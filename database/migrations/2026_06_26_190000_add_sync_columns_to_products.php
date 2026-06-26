<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        if (!Schema::hasColumn('products', 'is_synced')) {
            Schema::table('products', function (Blueprint $table) {
                $table->boolean('is_synced')->default(false)->after('id');
                $table->string('store_code')->nullable()->after('is_synced');
            });
        }
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        if (Schema::hasColumn('products', 'is_synced')) {
            Schema::table('products', function (Blueprint $table) {
                $table->dropColumn(['is_synced', 'store_code']);
            });
        }
    }
};
