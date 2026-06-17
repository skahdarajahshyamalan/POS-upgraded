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
        Schema::table('transactions', function (Blueprint $table) {
            $table->boolean('is_synced')->default(false)->after('id');
            $table->string('store_code')->nullable()->after('is_synced');
        });

        Schema::table('contacts', function (Blueprint $table) {
            $table->boolean('is_synced')->default(false)->after('id');
            $table->string('store_code')->nullable()->after('is_synced');
        });

        Schema::table('business', function (Blueprint $table) {
            $table->text('productcatalogue_settings')->nullable();
            $table->text('repair_settings')->nullable();
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        Schema::table('transactions', function (Blueprint $table) {
            $table->dropColumn(['is_synced', 'store_code']);
        });

        Schema::table('contacts', function (Blueprint $table) {
            $table->dropColumn(['is_synced', 'store_code']);
        });

        Schema::table('business', function (Blueprint $table) {
            $table->dropColumn(['productcatalogue_settings', 'repair_settings']);
        });
    }
};
