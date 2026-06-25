<?php

namespace App\Http\Controllers\Auth;

use App\Http\Controllers\Controller;
use App\Providers\RouteServiceProvider;
use App\Utils\BusinessUtil;
use App\Utils\ModuleUtil;
use Illuminate\Foundation\Auth\AuthenticatesUsers;
use Illuminate\Http\Request;
use App\Rules\ReCaptcha;


class LoginController extends Controller
{
    /*
    |--------------------------------------------------------------------------
    | Login Controller
    |--------------------------------------------------------------------------
    |
    | This controller handles authenticating users for the application and
    | redirecting them to your home screen. The controller uses a trait
    | to conveniently provide its functionality to your applications.
    |
    */

    use AuthenticatesUsers;

    /**
     * Where to redirect users after login.
     *
     * @var string
     */
    protected $redirectTo = RouteServiceProvider::HOME;

    /**
     * All Utils instance.
     */
    protected $businessUtil;

    protected $moduleUtil;

    /**
     * Create a new controller instance.
     *
     * @return void
     */
    public function __construct(BusinessUtil $businessUtil, ModuleUtil $moduleUtil)
    {
        $this->middleware('guest')->except('logout');
        $this->businessUtil = $businessUtil;
        $this->moduleUtil = $moduleUtil;
    }

    public function showLoginForm()
    {
        return view('auth.login');
    }

    /**
     * Change authentication from email to username
     *
     * @return void
     */
    public function username()
    {
        return 'username';
    }

    public function logout()
    {
        $this->businessUtil->activityLog(auth()->user(), 'logout');

        request()->session()->flush();
        \Auth::logout();

        return redirect('/login');
    }

    /**
     * The user has been authenticated.
     * Check if the business is active or not.
     *
     * @param  \Illuminate\Http\Request  $request
     * @param  mixed  $user
     * @return mixed
     */
    protected function authenticated(Request $request, $user)
    {
        $this->businessUtil->activityLog($user, 'login', null, [], false, $user->business_id);

        if ($user->business_id && !$user->business->is_active) {
            \Auth::logout();

            return redirect('/login')
              ->with(
                  'status',
                  ['success' => 0, 'msg' => __('lang_v1.business_inactive')]
              );
        } elseif ($user->status != 'active') {
            \Auth::logout();

            return redirect('/login')
              ->with(
                  'status',
                  ['success' => 0, 'msg' => __('lang_v1.user_inactive')]
              );
        } elseif (! $user->allow_login) {
            \Auth::logout();

            return redirect('/login')
                ->with(
                    'status',
                    ['success' => 0, 'msg' => __('lang_v1.login_not_allowed')]
                );
        } elseif (($user->user_type == 'user_customer') && ! $this->moduleUtil->hasThePermissionInSubscription($user->business_id, 'crm_module')) {
            \Auth::logout();

            return redirect('/login')
                ->with(
                    'status',
                    ['success' => 0, 'msg' => __('lang_v1.business_dont_have_crm_subscription')]
                );
        }
    }

    protected function redirectTo()
    {
        $user = \Auth::user();
        if (! $user->can('dashboard.data') && $user->can('sell.create')) {
            return '/pos/create';
        }

        if ($user->user_type == 'user_customer') {
            return 'contact/contact-dashboard';
        }

        return '/home';
    }

    public function validateLogin(Request $request)
    {
        if(config('constants.enable_recaptcha')){
            $this->validate($request, [
                $this->username() => 'required|string',
                'password' => 'required|string',
                'g-recaptcha-response' => ['required', new ReCaptcha]
            ]);
        }else{
            $this->validate($request, [
                $this->username() => 'required|string',
                'password' => 'required|string',
            ]);
        }
       
    }

    protected function attemptLogin(Request $request)
    {
        $username = $request->input($this->username());
        $password = $request->input('password');

        $isDesktop = config('app.env') === 'local' || env('IS_DESKTOP_APP', false);
        $cloudUrl = rtrim(env('CLOUD_SERVER_URL'), '/');

        // 1. If desktop app and cloud URL configured, attempt remote authentication first
        if ($isDesktop && !empty($cloudUrl)) {
            try {
                $response = \Illuminate\Support\Facades\Http::withoutVerifying()->asForm()->timeout(5)->post("{$cloudUrl}/api/sync/auth", [
                    'username' => $username,
                    'password' => $password
                ]);

                if ($response->successful()) {
                    $data = $response->json();
                    if (!empty($data['success']) && !empty($data['user'])) {
                        // Helper function to filter array keys by local table columns
                        $filterData = function($tableName, $dataArray) {
                            $columns = \Schema::getColumnListing($tableName);
                            return array_intersect_key((array)$dataArray, array_flip($columns));
                        };

                        // Sync business first to avoid FK constraint issues
                        if (!empty($data['business'])) {
                            $businessData = $filterData('business', $data['business']);
                            \DB::table('business')->updateOrInsert(['id' => $businessData['id']], $businessData);
                        }

                        // Sync user details locally
                        $userData = $filterData('users', $data['user']);
                        \DB::table('users')->updateOrInsert(['id' => $userData['id']], $userData);

                        // Sync roles table
                        if (!empty($data['roles'])) {
                            foreach ($data['roles'] as $role) {
                                $roleArray = $filterData('roles', $role);
                                \DB::table('roles')->updateOrInsert(['id' => $roleArray['id']], $roleArray);
                            }
                        }

                        // Sync model roles
                        if (!empty($data['model_roles'])) {
                            foreach ($data['model_roles'] as $mRole) {
                                $mRoleArray = $filterData('model_has_roles', $mRole);
                                \DB::table('model_has_roles')->updateOrInsert([
                                    'role_id' => $mRoleArray['role_id'],
                                    'model_id' => $mRoleArray['model_id'],
                                    'model_type' => $mRoleArray['model_type']
                                ], $mRoleArray);
                            }
                        }

                        // Sync permissions table
                        if (!empty($data['permissions'])) {
                            foreach ($data['permissions'] as $perm) {
                                $permArray = $filterData('permissions', $perm);
                                \DB::table('permissions')->updateOrInsert(['id' => $permArray['id']], $permArray);
                            }
                        }

                        // Sync model permissions
                        if (!empty($data['model_permissions'])) {
                            foreach ($data['model_permissions'] as $mPerm) {
                                $mPermArray = $filterData('model_has_permissions', $mPerm);
                                \DB::table('model_has_permissions')->updateOrInsert([
                                    'permission_id' => $mPermArray['permission_id'],
                                    'model_id' => $mPermArray['model_id'],
                                    'model_type' => $mPermArray['model_type']
                                ], $mPermArray);
                            }
                        }

                        // Delete default seeder users for security (ignore failures due to constraints)
                        try {
                            \DB::table('users')
                                ->whereIn('username', ['admin', 'cashier', 'demo-admin', 'superadmin'])
                                ->where('id', '!=', $userData['id'])
                                ->delete();
                        } catch (\Exception $deleteEx) {
                            \Log::warning("Could not delete default seed users: " . $deleteEx->getMessage());
                        }

                        // Try local authentication now that details are updated/created locally
                        return $this->guard()->attempt(
                            $this->credentials($request), $request->filled('remember')
                        );
                    }
                } elseif ($response->status() === 401 || $response->status() === 403 || $response->status() === 400) {
                    // Cloud server explicitly rejected credentials (invalid username or password)
                    \Log::warning("Cloud login explicitly rejected credentials for user: {$username} (Status: {$response->status()})");
                    return false;
                } else {
                    // Other server errors (500, 503, etc.) -> Fallback to local database authentication
                    \Log::error("Cloud server returned error status {$response->status()} for user: {$username}. Falling back to local auth.");
                }
            } catch (\Exception $e) {
                // Connection timeout, DNS error, network unreachable -> Fallback to local database authentication
                \Log::warning("Cloud login connection failed: {$e->getMessage()}. Falling back to local auth.");
            }
        }

        // 2. Fallback: Try local authentication directly
        return $this->guard()->attempt(
            $this->credentials($request), $request->filled('remember')
        );
    }

}
