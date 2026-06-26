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