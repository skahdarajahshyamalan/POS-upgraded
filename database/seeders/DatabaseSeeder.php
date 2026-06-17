<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;

// Manually require the seeders to bypass composer classmap autoloading issues in production builds
require_once __DIR__ . '/BarcodesTableSeeder.php';
require_once __DIR__ . '/PermissionsTableSeeder.php';
require_once __DIR__ . '/CurrenciesTableSeeder.php';
require_once __DIR__ . '/OldDummyBusinessSeeder.php';

class DatabaseSeeder extends Seeder
{
    /**
     * Run the database seeds.
     *
     * @return void
     */
    public function run()
    {
        $this->call([
            BarcodesTableSeeder::class,
            PermissionsTableSeeder::class,
            CurrenciesTableSeeder::class,
            OldDummyBusinessSeeder::class,
        ]);
    }
}
