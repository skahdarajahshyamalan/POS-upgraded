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
                $this->warn('[SyncUsers] HTTP ' . $response->status() . ': ' . substr($response->body(), 0, 200));
                return 0;
            }

            $data = $response->json();

            if (empty($data['success'])) {
                $this->warn('[SyncUsers] Error: ' . ($data['message'] ?? 'Unknown'));
                return 0;
            }

            // Disable FK checks for safe cross-table upserts
            DB::statement('SET FOREIGN_KEY_CHECKS=0');

            // 1. Sync Roles
            $this->info('[SyncUsers] Syncing roles...');
            foreach ($data['roles'] ?? [] as $role) {
                DB::table('roles')->updateOrInsert(['id' => ((array)$role)['id']], (array)$role);
            }

            // 2. Sync Permissions
            $this->info('[SyncUsers] Syncing permissions...');
            foreach ($data['permissions'] ?? [] as $perm) {
                DB::table('permissions')->updateOrInsert(['id' => ((array)$perm)['id']], (array)$perm);
            }

            // 3. Sync Role->Permission assignments
            $this->info('[SyncUsers] Syncing role permissions...');
            foreach ($data['role_has_permissions'] ?? [] as $rp) {
                $rp = (array)$rp;
                DB::table('role_has_permissions')->updateOrInsert(
                    ['role_id' => $rp['role_id'], 'permission_id' => $rp['permission_id']],
                    $rp
                );
            }

            // 4. Sync Users
            $this->info('[SyncUsers] Syncing users...');
            $liveUserIds = [];
            foreach ($data['users'] ?? [] as $user) {
                $user = (array)$user;
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

            // Force all local users to business 1 (desktop app is single-business)
            DB::statement("UPDATE users SET business_id = 1 WHERE deleted_at IS NULL");

            // 5. Sync User->Role assignments
            $this->info('[SyncUsers] Syncing user role assignments...');
            if (!empty($liveUserIds)) {
                DB::table('model_has_roles')
                    ->where('model_type', \App\User::class)
                    ->whereIn('model_id', $liveUserIds)
                    ->delete();
            }
            foreach ($data['model_has_roles'] ?? [] as $mhr) {
                DB::table('model_has_roles')->insertOrIgnore((array)$mhr);
            }

            // Remap all roles to business-1 equivalents (Admin#1 / Cashier#1)
            // Desktop has 1 business so all roles must belong to business 1
            DB::statement("
                UPDATE model_has_roles mhr
                JOIN roles r ON r.id = mhr.role_id
                JOIN users u ON u.id = mhr.model_id AND mhr.model_type = 'App\\\\User'
                SET mhr.role_id = IF(r.name LIKE 'Admin%', 1, 2)
                WHERE r.business_id != 1 AND u.deleted_at IS NULL
            ");

            // 6. Sync User->Permission assignments
            $this->info('[SyncUsers] Syncing user permission assignments...');
            if (!empty($liveUserIds)) {
                DB::table('model_has_permissions')
                    ->where('model_type', \App\User::class)
                    ->whereIn('model_id', $liveUserIds)
                    ->delete();
            }
            foreach ($data['model_has_permissions'] ?? [] as $mhp) {
                DB::table('model_has_permissions')->insertOrIgnore((array)$mhp);
            }

            // Re-enable FK checks
            DB::statement('SET FOREIGN_KEY_CHECKS=1');

            $this->info('[SyncUsers] Done. Synced at: ' . ($data['synced_at'] ?? now()));

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