<?php

use Illuminate\Http\Request;

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
|
| Here is where you can register API routes for your application. These
| routes are loaded by the RouteServiceProvider within a group which
| is assigned the "api" middleware group. Enjoy building your API!
|
*/

use App\Http\Controllers\SyncController;

Route::middleware('auth:api')->get('/user', function (Request $request) {
    return $request->user();
});

Route::post('/sync/push', [SyncController::class, 'push']);
Route::get('/sync/pull', [SyncController::class, 'pull']);
Route::post('/sync/local-trigger', [SyncController::class, 'syncLocal']);
Route::post('/sync/auth', [SyncController::class, 'remoteAuth']);
