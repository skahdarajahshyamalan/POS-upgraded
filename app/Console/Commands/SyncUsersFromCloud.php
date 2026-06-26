<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

class SyncUsersFromCloud extends Command
{
    protected $signature = 'pos:sync-users';
    protected $description = 'Sync users from live cloud server to local desktop database on startup.';

    public function handle()
    {
        if (!env('IS_DESKTOP_APP', false)) {
            $this->info('[SyncUsers] Not a desktop app. Skipping.');
            return 0;
        }

        $cloudUrl   = rtrim(env('CLOUD_SERVER_URL', ''), '/');
        $syncSecret = env('SYNC_SECRET', '');

        if (empty($cloudUrl) || empty($syncSecret)) {
            $this->warn('[SyncUsers] CLOUD_SERVER_URL or SYNC_SECRET not set. Skipping.');
            return 0;
        }

        $endpoint = $cloudUrl . '/api/sync/users';
        $this->info('[SyncUsers] Syncing from: ' . $endpoint);

        try {
            $response = Http::withoutVerifying()
                ->timeout(10)
                ->withHeaders(['X-Sync-Secret' => $syncSecret])
                ->post($endpoint, ['sync_secret' => $syncSecret]);

            if (!$response->successful()) {
                $this->warn('[SyncUsers] HTTP ' . $response->status() . ': ' . $response->body());
                return 0;
            }

            $data = $response->json();

            if (empty($data['success'])) {
                $this->warn('[SyncUsers] Error: ' . ($data['message'] ?? 'Unknown'));
                return 0;
            }

            // Disable FK checks to allow safe upsert across related tables
            DB::statement('SET FOREIGN_KEY_CHECKS=0');

            // 0. Sync Business (needed before roles due to FK constraint)
            foreach ($data['business'] ?? [] as $biz) {
                $biz = (array) $biz;
                DB::table('business')->updateOrInsert(['id' => $biz['id']], $biz);
            }

            // 1. Sync Roles
            foreach ($data['roles'] ?? [] as $role) {
                $role = (array) $role;
                DB::table('roles')->updateOrInsert(['id' => $role['id']], $role);
            }

            // 2. Sync Permissions
            foreach ($data['permissions'] ?? [] as $perm) {
                $perm = (array) $perm;
                DB::table('permissions')->updateOrInsert(['id' => $perm['id']], $perm);
            }

            // 3. Sync Role->Permission assignments
            foreach ($data['role_has_permissions'] ?? [] as $rp) {
                $rp = (array) $rp;
                DB::table('role_has_permissions')->updateOrInsert(
                    ['role_id' => $rp['role_id'], 'permission_id' => $rp['permission_id']],
                    $rp
                );
            }

            // 4. Sync Users
            $liveUserIds = [];
            foreach ($data['users'] ?? [] as $user) {
                $user = (array) $user;
                $liveUserIds[] = $user['id'];
                DB::table('users')->updateOrInsert(['id' => $user['id']], $user);
            }

            // Soft-delete users removed from live
            if (!empty($liveUserIds)) {
                DB::table('users')
                    ->whereNotIn('id', $liveUserIds)
                    ->whereNull('deleted_at')
                    ->update(['deleted_at' => now(), 'status' => 'inactive']);
            }

            // Fix business_id: if synced user's business doesn't exist locally, assign to business 1
            DB::statement("UPDATE users SET business_id = 1 WHERE business_id NOT IN (SELECT id FROM business) AND deleted_at IS NULL");

            // 5. Sync User->Role assignments
            if (!empty($liveUserIds)) {
                DB::table('model_has_roles')
                    ->where('model_type', \App\User::class)
                    ->whereIn('model_id', $liveUserIds)
                    ->delete();
            }
            foreach ($data['model_has_roles'] ?? [] as $mhr) {
                DB::table('model_has_roles')->insertOrIgnore((array) $mhr);
            }

            // 6. Sync User->Permission assignments
            if (!empty($liveUserIds)) {
                DB::table('model_has_permissions')
                    ->where('model_type', \App\User::class)
                    ->whereIn('model_id', $liveUserIds)
                    ->delete();
            }
            foreach ($data['model_has_permissions'] ?? [] as $mhp) {
                DB::table('model_has_permissions')->insertOrIgnore((array) $mhp);
            }

            // 7. Fix role-business mismatch:
            //    After syncing, a user's role might belong to a different business
            //    than the user's own business_id. Remap to the equivalent role in business 1.
            $this->info('[SyncUsers] Fixing role-business mismatches...');
            $mismatchedUsers = DB::select("
                SELECT mhr.model_id, mhr.role_id, r.name as role_name, u.business_id
                FROM model_has_roles mhr
                JOIN roles r ON r.id = mhr.role_id
                JOIN users u ON u.id = mhr.model_id
                WHERE mhr.model_type = 'App\\\\User'
                AND r.business_id != u.business_id
                AND u.deleted_at IS NULL
            ");

            foreach ($mismatchedUsers as $mu) {
                // Determine role type: Admin or Cashier
                $roleType = str_contains($mu->role_name, 'Admin') ? 'Admin' : 'Cashier';
                // Find the matching role for business 1
                $localRole = DB::table('roles')
                    ->where('business_id', $mu->business_id)
                    ->where('name', 'like', $roleType . '#%')
                    ->first();

                if ($localRole) {
                    DB::table('model_has_roles')
                        ->where('model_type', \App\User::class)
                        ->where('model_id', $mu->model_id)
                        ->where('role_id', $mu->role_id)
                        ->update(['role_id' => $localRole->id]);
                }
            }

            $this->info('[SyncUsers] Done. Synced at: ' . ($data['synced_at'] ?? now()));

            // Re-enable FK checks
            DB::statement('SET FOREIGN_KEY_CHECKS=1');

            try {
                app()[\Spatie\Permission\PermissionRegistrar::class]->forgetCachedPermissions();
            } catch (\Exception $e) {}

            return 0;

        } catch (\Illuminate\Http\Client\ConnectionException $e) {
            $this->warn('[SyncUsers] Offline. Using local cached users.');
            Log::info('[SyncUsers] Offline: ' . $e->getMessage());
            return 0;
        } catch (\Exception $e) {
            $this->error('[SyncUsers] Error: ' . $e->getMessage());
            Log::error('[SyncUsers] ' . $e->getMessage());
            return 0;
        }
    }
}