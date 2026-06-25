<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use App\Transaction;
use App\Contact;

class SyncController extends Controller
{
    /**
     * PUSH Endpoint (Runs on Cloud Server)
     * Receives local data from desktop clients and saves to cloud database.
     */
    public function push(Request $request)
    {
        $storeCode = $request->input('store_code');
        $transactions = $request->input('transactions', []);
        $contacts = $request->input('contacts', []);

        if (empty($storeCode)) {
            return response()->json(['success' => false, 'message' => 'Store code required'], 400);
        }

        $savedTransactionIds = [];
        $savedContactIds = [];

        DB::beginTransaction();
        try {
            // 1. Sync Contacts
            foreach ($contacts as $c) {
                // Find contact by store_code and local contact_id
                $contact = Contact::where('store_code', $storeCode)
                    ->where('contact_id', $c['id']) // local ID
                    ->first();

                if (!$contact) {
                    $contact = new Contact();
                }

                // Map data from request payload
                $contact->fill($c);
                $contact->store_code = $storeCode;
                $contact->is_synced = true;
                $contact->save();

                $savedContactIds[] = $c['id'];
            }

            // 2. Sync Transactions
            foreach ($transactions as $t) {
                // Prevent duplicate by checking store_code and local transaction id
                // UltimatePOS has transaction_ref_no or we can map local_id
                $transaction = Transaction::where('store_code', $storeCode)
                    ->where('invoice_no', $t['invoice_no']) // Or unique reference
                    ->first();

                if (!$transaction) {
                    $transaction = new Transaction();
                }

                $transaction->fill($t);
                $transaction->store_code = $storeCode;
                $transaction->is_synced = true;
                $transaction->save();

                $savedTransactionIds[] = $t['id'];
            }

            DB::commit();
            return response()->json([
                'success' => true,
                'synced_transactions' => $savedTransactionIds,
                'synced_contacts' => $savedContactIds
            ]);
        } catch (\Exception $e) {
            DB::rollBack();
            return response()->json(['success' => false, 'message' => $e->getMessage()], 500);
        }
    }

    /**
     * PULL Endpoint (Runs on Cloud Server)
     * Sends new products or updates to the desktop client.
     */
    public function pull(Request $request)
    {
        $lastSyncTime = $request->input('last_sync_time', '1970-01-01 00:00:00');

        // Fetch products, categories, brands updated since last sync
        $products = DB::table('products')
            ->where('updated_at', '>', $lastSyncTime)
            ->get();

        $categories = DB::table('categories')
            ->where('updated_at', '>', $lastSyncTime)
            ->get();

        $brands = DB::table('brands')
            ->where('updated_at', '>', $lastSyncTime)
            ->get();

        return response()->json([
            'success' => true,
            'products' => $products,
            'categories' => $categories,
            'brands' => $brands,
            'server_time' => now()->toDateTimeString()
        ]);
    }

    /**
     * Local Sync Trigger (Runs on Desktop client app only)
     * Initiates the PUSH and PULL processes with the cloud server.
     */
    public function syncLocal()
    {
        if (!env('IS_DESKTOP_APP', false)) {
            return response()->json(['success' => false, 'message' => 'This operation is only allowed on the Desktop client.'], 403);
        }

        $cloudUrl = rtrim(env('CLOUD_SERVER_URL', 'https://your-cloud-pos.com'), '/');
        $storeCode = env('STORE_CODE', 'STORE-001');

        // 1. Fetch local unsynced contacts
        $unsyncedContacts = Contact::where('is_synced', false)->get()->toArray();

        // 2. Fetch local unsynced transactions
        $unsyncedTransactions = Transaction::where('is_synced', false)->get()->toArray();

        try {
            // Push local data
            $pushResponse = Http::withoutVerifying()->post("{$cloudUrl}/api/sync/push", [
                'store_code' => $storeCode,
                'contacts' => $unsyncedContacts,
                'transactions' => $unsyncedTransactions
            ]);

            if ($pushResponse->successful()) {
                $resData = $pushResponse->json();
                
                // Mark successfully pushed contacts as synced
                if (!empty($resData['synced_contacts'])) {
                    Contact::whereIn('id', $resData['synced_contacts'])->update(['is_synced' => true]);
                }

                // Mark successfully pushed transactions as synced
                if (!empty($resData['synced_transactions'])) {
                    Transaction::whereIn('id', $resData['synced_transactions'])->update(['is_synced' => true]);
                }
            } else {
                return response()->json(['success' => false, 'message' => 'Data Push failed: ' . $pushResponse->body()], 500);
            }

            // Pull cloud updates
            $lastSync = DB::table('system')->where('key', 'last_sync_time')->first();
            $lastSyncTime = $lastSync ? $lastSync->value : '1970-01-01 00:00:00';

            $pullResponse = Http::withoutVerifying()->get("{$cloudUrl}/api/sync/pull", [
                'last_sync_time' => $lastSyncTime
            ]);

            if ($pullResponse->successful()) {
                $pullData = $pullResponse->json();

                // Upsert products locally
                foreach ($pullData['products'] as $p) {
                    $pArray = (array)$p;
                    DB::table('products')->updateOrInsert(['id' => $pArray['id']], $pArray);
                }

                // Update last sync time
                DB::table('system')->updateOrInsert(
                    ['key' => 'last_sync_time'],
                    ['value' => $pullData['server_time']]
                );
            }

            return response()->json(['success' => true, 'message' => 'Sync completed successfully!']);
        } catch (\Exception $e) {
            return response()->json(['success' => false, 'message' => 'Sync Error: ' . $e->getMessage()], 500);
        }
    }

    /**
     * REMOTE AUTH Endpoint (Runs on Cloud Server)
     * Authenticates a user and returns user info, roles, permissions and business registration for local caching.
     */
    public function remoteAuth(Request $request)
    {
        try {
            $username = $request->input('username');
            $password = $request->input('password');

            if (empty($username) || empty($password)) {
                return response()->json(['success' => false, 'message' => 'Username and password are required.'], 400);
            }

            // Try to authenticate using username or email
            $fieldType = filter_var($username, FILTER_VALIDATE_EMAIL) ? 'email' : 'username';
            
            $user = \App\User::where($fieldType, $username)->first();

            if ($user && \Hash::check($password, $user->password)) {
                // Fetch business
                $business = \DB::table('business')->where('id', $user->business_id)->first();
                
                // Fetch model roles
                $modelRoles = \DB::table('model_has_roles')
                    ->where('model_id', $user->id)
                    ->where('model_type', \App\User::class)
                    ->get();
                    
                $roleIds = $modelRoles->pluck('role_id')->toArray();
                $roles = \DB::table('roles')->whereIn('id', $roleIds)->get();

                // Fetch model permissions
                $modelPermissions = \DB::table('model_has_permissions')
                    ->where('model_id', $user->id)
                    ->where('model_type', \App\User::class)
                    ->get();
                    
                $permissionIds = $modelPermissions->pluck('permission_id')->toArray();
                $permissions = \DB::table('permissions')->whereIn('id', $permissionIds)->get();

                // Fetch role_has_permissions (permissions granted via role)
                $rolePermissions = \DB::table('role_has_permissions')
                    ->whereIn('role_id', $roleIds)
                    ->get();
                    
                // Merge all permission IDs (direct + role-based)
                $allPermissionIds = array_unique(array_merge(
                    $permissionIds,
                    $rolePermissions->pluck('permission_id')->toArray()
                ));
                $allPermissions = \DB::table('permissions')->whereIn('id', $allPermissionIds)->get();

                return response()->json([
                    'success' => true,
                    'user' => array_merge($user->toArray(), ['password' => $user->password]),
                    'business' => $business,
                    'model_roles' => $modelRoles,
                    'roles' => $roles,
                    'role_permissions' => $rolePermissions,
                    'model_permissions' => $modelPermissions,
                    'permissions' => $allPermissions
                ]);
            }

            return response()->json(['success' => false, 'message' => 'Invalid credentials.'], 401);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Server Error: ' . $e->getMessage(),
                'trace' => $e->getTraceAsString()
            ], 500);
        }
    }
}
