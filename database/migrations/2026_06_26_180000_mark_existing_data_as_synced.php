<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Mark all existing demo/seed data as already synced.
     * Only NEW data created after this migration will be pushed to cloud.
     */
    public function up()
    {
        $storeCode = env('STORE_CODE', 'STORE-001');

        // Mark all existing transactions as already synced
        DB::table('transactions')
            ->where('is_synced', 0)
            ->update([
                'is_synced' => 1,
                'store_code' => $storeCode,
            ]);

        // Mark all existing contacts as already synced
        DB::table('contacts')
            ->where('is_synced', 0)
            ->update([
                'is_synced' => 1,
                'store_code' => $storeCode,
            ]);
    }

    /**
     * Reverse: mark everything as unsynced again.
     */
    public function down()
    {
        DB::table('transactions')->update(['is_synced' => 0, 'store_code' => null]);
        DB::table('contacts')->update(['is_synced' => 0, 'store_code' => null]);
    }
};
