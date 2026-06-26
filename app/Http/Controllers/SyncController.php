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
        // Validate Sync Secret
        $secret = $request->header('X-Sync-Secret') ?? $request->input('sync_secret');
        $expectedSecret = env('SYNC_SECRET', '');

        if (!empty($expectedSecret) && $secret !== $expectedSecret) {
            return response()->json(['success' => false, 'message' => 'Unauthorized sync request.'], 401);
        }

        $storeCode = $request->input('store_code');
        $transactions = $request->input('transactions', []);
        $contacts = $request->input('contacts', []);

        if (empty($storeCode)) {
            return response()->json(['success' => false, 'message' => 'Store code required'], 400);
        }

        // Try to resolve business_id and location_id from store_code
        $location = \App\BusinessLocation::where('location_id', $storeCode)->first();
        $businessId = $location ? $location->business_id : 1;
        $locationId = $location ? $location->id : null;

        $savedTransactionIds = [];
        $savedContactIds = [];

        // Disable FK checks during push to avoid foreign key violations (e.g. missing users/locations on cloud)
        DB::statement('SET FOREIGN_KEY_CHECKS=0');

        // 1. Sync Contacts
        foreach ($contacts as $c) {
            DB::beginTransaction();
            try {
                // Find contact by store_code and contact_id/name/mobile
                $contact = null;
                if (!empty($c['contact_id'])) {
                    $contact = Contact::where('contact_id', $c['contact_id'])->first();
                }
                if (!$contact && !empty($c['mobile'])) {
                    $contact = Contact::where('name', $c['name'])
                        ->where('mobile', $c['mobile'])
                        ->first();
                }
                if (!$contact) {
                    $contact = Contact::where('name', $c['name'])->first();
                }

                if (!$contact) {
                    $contact = new Contact();
                }

                $contact->fill($c);
                $contact->store_code = $storeCode;
                $contact->business_id = $businessId;
                $contact->is_synced = true;
                $contact->save();

                DB::commit();
                $savedContactIds[] = $c['id'];
            } catch (\Exception $e) {
                DB::rollBack();
                \Log::error('[SyncPush] Contact sync error: ' . $e->getMessage());
            }
        }

        // 2. Sync Transactions
        foreach ($transactions as $t) {
            DB::beginTransaction();
            try {
                // Prevent duplicate by checking store_code and invoice_no / ref_no
                $transaction = Transaction::where('store_code', $storeCode)
                    ->where(function($query) use ($t) {
                        if (!empty($t['invoice_no'])) {
                            $query->where('invoice_no', $t['invoice_no']);
                        } else if (!empty($t['ref_no'])) {
                            $query->where('ref_no', $t['ref_no']);
                        } else {
                            $query->where('id', 0);
                        }
                    })
                    ->first();

                if ($transaction) {
                    // Delete existing child records to avoid duplicate sell lines / payments
                    $transaction->sell_lines()->delete();
                    $transaction->purchase_lines()->delete();
                    $transaction->payment_lines()->delete();
                } else {
                    $transaction = new Transaction();
                }

                $transaction->fill($t);
                $transaction->store_code = $storeCode;
                $transaction->business_id = $businessId;
                if ($locationId) {
                    $transaction->location_id = $locationId;
                }
                $transaction->is_synced = true;

                // Map contact
                if (!empty($t['contact_ref'])) {
                    $ref = $t['contact_ref'];
                    $contactVal = null;
                    if (!empty($ref['contact_id'])) {
                        $contactVal = Contact::where('contact_id', $ref['contact_id'])->first();
                    }
                    if (!$contactVal && !empty($ref['mobile'])) {
                        $contactVal = Contact::where('name', $ref['name'])
                            ->where('mobile', $ref['mobile'])
                            ->first();
                    }
                    if (!$contactVal) {
                        $contactVal = Contact::where('name', $ref['name'])->first();
                    }
                    if ($contactVal) {
                        $transaction->contact_id = $contactVal->id;
                    }
                }

                $transaction->save();

                // Save sell lines
                if (!empty($t['sell_lines'])) {
                    foreach ($t['sell_lines'] as $line) {
                        $sellLine = new \App\TransactionSellLine();
                        $sellLine->fill($line);
                        $sellLine->transaction_id = $transaction->id;
                        $sellLine->save();
                    }
                }

                // Save purchase lines
                if (!empty($t['purchase_lines'])) {
                    foreach ($t['purchase_lines'] as $line) {
                        $purchaseLine = new \App\PurchaseLine();
                        $purchaseLine->fill($line);
                        $purchaseLine->transaction_id = $transaction->id;
                        $purchaseLine->save();
                    }
                }

                // Save payments
                if (!empty($t['payment_lines'])) {
                    foreach ($t['payment_lines'] as $payment) {
                        $payLine = new \App\TransactionPayment();
                        $payLine->fill($payment);
                        $payLine->transaction_id = $transaction->id;
                        $payLine->business_id = $businessId;
                        $payLine->save();
                    }
                }

                DB::commit();
                $savedTransactionIds[] = $t['id'];
            } catch (\Exception $e) {
                DB::rollBack();
                \Log::error('[SyncPush] Transaction sync error: ' . $e->getMessage() . ' | Data: ' . json_encode($t));
            }
        }

        DB::statement('SET FOREIGN_KEY_CHECKS=1');

        return response()->json([
            'success' => true,
            'synced_transactions' => $savedTransactionIds,
            'synced_contacts' => $savedContactIds
        ]);
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

        // 2. Fetch local unsynced transactions with their relational data
        $unsyncedTransactions = Transaction::where('is_synced', false)->get();
        $transactionsPayload = [];

        foreach ($unsyncedTransactions as $t) {
            $tArr = $t->toArray();
            $tArr['sell_lines'] = $t->sell_lines->toArray();
            $tArr['purchase_lines'] = $t->purchase_lines->toArray();
            $tArr['payment_lines'] = $t->payment_lines->toArray();

            // Add contact reference for mapping on cloud
            if ($t->contact) {
                $tArr['contact_ref'] = [
                    'contact_id' => $t->contact->contact_id,
                    'name' => $t->contact->name,
                    'mobile' => $t->contact->mobile,
                ];
            }
            $transactionsPayload[] = $tArr;
        }

        try {
            // Push local data
            $pushResponse = Http::withoutVerifying()
                ->withHeaders(['X-Sync-Secret' => env('SYNC_SECRET', '')])
                ->post("{$cloudUrl}/api/sync/push", [
                    'store_code' => $storeCode,
                    'sync_secret' => env('SYNC_SECRET', ''),
                    'contacts' => $unsyncedContacts,
                    'transactions' => $transactionsPayload
                ]);

            if ($pushResponse->successful()) {
                $resData = $pushResponse->json();
                
                // Mark successfully pushed contacts as synced and write store_code
                if (!empty($resData['synced_contacts'])) {
                    Contact::whereIn('id', $resData['synced_contacts'])->update(['is_synced' => true, 'store_code' => $storeCode]);
                }

                // Mark successfully pushed transactions as synced and write store_code
                if (!empty($resData['synced_transactions'])) {
                    Transaction::whereIn('id', $resData['synced_transactions'])->update(['is_synced' => true, 'store_code' => $storeCode]);
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

                // Disable FK checks to avoid products foreign key constraint error with created_by/tax/etc
                DB::statement('SET FOREIGN_KEY_CHECKS=0');

                // Upsert products locally
                foreach ($pullData['products'] as $p) {
                    $pArray = (array)$p;
                    DB::table('products')->updateOrInsert(['id' => $pArray['id']], $pArray);
                }

                DB::statement('SET FOREIGN_KEY_CHECKS=1');

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

    /**
     * SYNC USERS Endpoint (Runs on Cloud/Live Server)
     * Returns all users with hashed passwords and role assignments for desktop sync.
     * Protected by SYNC_SECRET token.
     */
    public function syncUsers(Request $request)
    {
        try {
            // Validate sync secret token
            $secret = $request->header('X-Sync-Secret') ?? $request->input('sync_secret');
            $expectedSecret = env('SYNC_SECRET', '');

            if (empty($expectedSecret) || $secret !== $expectedSecret) {
                return response()->json(['success' => false, 'message' => 'Unauthorized.'], 401);
            }

            // Fetch all active users with their hashed passwords
            $users = \DB::table('users')
                ->whereNull('deleted_at')
                ->get();

            // Fetch all roles
            $roles = \DB::table('roles')->get();

            // Fetch all model_has_roles (user → role assignments)
            $modelHasRoles = \DB::table('model_has_roles')
                ->where('model_type', \App\User::class)
                ->get();

            // Fetch all permissions
            $permissions = \DB::table('permissions')->get();

            // Fetch role_has_permissions
            $roleHasPermissions = \DB::table('role_has_permissions')->get();

            // Fetch model_has_permissions
            $modelHasPermissions = \DB::table('model_has_permissions')
                ->where('model_type', \App\User::class)
                ->get();

            return response()->json([
                'success'               => true,
                'users'                 => $users,
                'roles'                 => $roles,
                'model_has_roles'       => $modelHasRoles,
                'permissions'           => $permissions,
                'role_has_permissions'  => $roleHasPermissions,
                'model_has_permissions' => $modelHasPermissions,
                'synced_at'             => now()->toDateTimeString(),
            ]);
        } catch (\Exception $e) {
            return response()->json([
                'success' => false,
                'message' => 'Server Error: ' . $e->getMessage(),
            ], 500);
        }
    }
}
