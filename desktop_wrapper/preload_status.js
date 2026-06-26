const { ipcRenderer } = require('electron');

console.log('[Preload Status] Preload script loaded.');

// Helper to navigate the main world (renderer page context) from isolated preload script
function navigateMainWorld(url) {
    try {
        console.log('[Preload Status] Performing navigation to:', url);
        if (url.includes('/home') || url.endsWith('/home')) {
            ipcRenderer.send('navigate-to-dashboard');
        } else {
            window.location.href = url;
        }
    } catch (e) {
        console.error('[Preload Status] Navigation failed:', e);
    }
}

// Register global click interceptor in capturing phase immediately (outside DOMContentLoaded)
document.addEventListener('click', (e) => {
    // Safely check closest anchor without throwing TypeErrors
    const anchor = (e.target && typeof e.target.closest === 'function') ? e.target.closest('a') : null;
    if (anchor) {
        const href = anchor.getAttribute('href') || '';
        
        // Intercept if the old /sells/pos URL is still in href (fallback safety)
        // Also intercept /home links to bypass page-level click preventions
        const needsRedirect = href.includes('/sells/pos') || href.includes('/home') || href.endsWith('/home');
        
        console.log('[Preload Status] Clicked anchor href:', href, 'needsRedirect:', needsRedirect);
        
        if (needsRedirect) {
            console.log('[Preload Status] Redirecting to Dashboard via IPC.');
            e.preventDefault();
            e.stopPropagation();
            ipcRenderer.send('navigate-to-dashboard');
        }
    }
}, true);


window.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowLeft') {
        window.history.back();
    }
});

// Network status state
let isChecking = false;
async function updateOnlineStatus() {
    if (isChecking) return;
    isChecking = true;

    const dot = document.getElementById('net-dot');
    const text = document.getElementById('net-text');
    if (!dot || !text) {
        isChecking = false;
        return;
    }

    if (navigator.onLine) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            
            await fetch('https://www.google.com/favicon.ico', { 
                mode: 'no-cors', 
                cache: 'no-store',
                signal: controller.signal 
            });
            
            clearTimeout(timeoutId);
            setOnline(true);
        } catch (err) {
            setOnline(false);
        }
    } else {
        setOnline(false);
    }
    isChecking = false;
}

function setOnline(online) {
    const dot = document.getElementById('net-dot');
    const text = document.getElementById('net-text');
    if (!dot || !text) return;

    if (online) {
        dot.className = 'status-dot online';
        text.innerText = 'Online';
        text.style.color = '#2ec4b6';
    } else {
        dot.className = 'status-dot offline';
        text.innerText = 'Offline';
        text.style.color = '#e71d36';
    }
}

// IPC sync status variables
let isPackaged = false;
let resetTimeout;
let lastSyncData = { status: 'idle', file: '' };

// Database sync status variables
let dbSyncStatus = { status: 'idle', message: 'Sync Database' };
let isSyncing = false;
let applySyncUI = () => {};

function showDBSyncStatus(status, message) {
    dbSyncStatus = { status, message };
    applySyncUI();
}

async function triggerDatabaseSync() {
    if (isSyncing) return;

    const isRemote = !window.location.origin.includes('127.0.0.1') && !window.location.origin.includes('localhost');
    if (isRemote) return; // No sync needed in cloud direct mode

    if (!navigator.onLine) {
        showDBSyncStatus('error', 'Sync Failed: Offline');
        setTimeout(() => {
            showDBSyncStatus('idle', 'Sync Database');
        }, 4000);
        return;
    }

    isSyncing = true;
    showDBSyncStatus('syncing', 'Syncing DB...');

    try {
        console.log('[Preload Status] Triggering database sync API...');
        const response = await fetch('/api/sync/local-trigger', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        if (data.success) {
            console.log('[Preload Status] Database sync completed successfully!');
            showDBSyncStatus('success', 'Sync Complete!');
        } else {
            console.error('[Preload Status] Database sync failed:', data.message);
            showDBSyncStatus('error', `Sync Failed: ${data.message || 'Server Error'}`);
        }
    } catch (err) {
        console.error('[Preload Status] Network error during database sync:', err);
        showDBSyncStatus('error', 'Sync Failed: Network Error');
    } finally {
        isSyncing = false;
        setTimeout(() => {
            if (!isSyncing) {
                showDBSyncStatus('idle', 'Sync Database');
            }
        }, 5000);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    console.log('[Preload Status] DOMContentLoaded fired.');

    // Inject status bar & styles function
    const injectStatusBar = () => {
        if (!document.body) return;

        // 1. Inject Styles if missing
        if (!document.getElementById('electron-status-bar-style')) {
            const style = document.createElement('style');
            style.id = 'electron-status-bar-style';
            style.innerHTML = `
                .pos-form-actions, .fixed-bottom {
                    bottom: 28px !important;
                }
                #electron-status-bar {
                    position: fixed;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    height: 28px;
                    background: rgba(20, 20, 20, 0.75);
                    backdrop-filter: blur(12px) saturate(140%);
                    -webkit-backdrop-filter: blur(12px) saturate(140%);
                    border-top: 1px solid rgba(255, 255, 255, 0.08);
                    color: rgba(255, 255, 255, 0.85);
                    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: 11px;
                    font-weight: 500;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 0 16px;
                    z-index: 2147483647;
                    user-select: none;
                    box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.3);
                    transition: all 0.3s ease;
                }
                .status-left, .status-right {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }
                .indicator-item {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .status-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    display: inline-block;
                }
                .status-dot.online {
                    background-color: #2ec4b6;
                    box-shadow: 0 0 8px #2ec4b6;
                    animation: pulse-online 2s infinite;
                }
                .status-dot.offline {
                    background-color: #e71d36;
                    box-shadow: 0 0 8px #e71d36;
                    animation: pulse-offline 1.5s infinite;
                }
                .sync-text {
                    color: rgba(255, 255, 255, 0.7);
                    transition: color 0.3s ease;
                }
                .sync-icon {
                    display: inline-block;
                    transition: transform 0.3s ease;
                }
                .sync-icon.spinning {
                    animation: spin 1.2s linear infinite;
                }
                .status-btn {
                    background: rgba(255, 255, 255, 0.08);
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    color: rgba(255, 255, 255, 0.9);
                    padding: 2px 8px;
                    border-radius: 4px;
                    font-size: 10px;
                    font-weight: 600;
                    font-family: 'Outfit', sans-serif;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    transition: all 0.2s ease;
                    outline: none;
                }
                .status-btn:hover {
                    background: rgba(255, 255, 255, 0.15);
                    border-color: rgba(255, 255, 255, 0.25);
                    color: #ffffff;
                }
                .status-btn:active {
                    transform: scale(0.95);
                }
                .status-btn.exit-btn {
                    background: rgba(239, 75, 83, 0.2);
                    border-color: rgba(239, 75, 83, 0.4);
                    color: #ff8b94;
                }
                .status-btn.exit-btn:hover {
                    background: rgba(239, 75, 83, 0.35);
                    border-color: rgba(239, 75, 83, 0.6);
                    color: #ffffff;
                }
                @keyframes pulse-online {
                    0% { box-shadow: 0 0 0 0 rgba(46, 196, 182, 0.6); }
                    70% { box-shadow: 0 0 0 6px rgba(46, 196, 182, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(46, 196, 182, 0); }
                }
                @keyframes pulse-offline {
                    0% { box-shadow: 0 0 0 0 rgba(231, 29, 54, 0.6); }
                    70% { box-shadow: 0 0 0 6px rgba(231, 29, 54, 0); }
                    100% { box-shadow: 0 0 0 0 rgba(231, 29, 54, 0); }
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
            `;
            document.body.appendChild(style);
        }

        // 2. Inject Bar if missing
        if (!document.getElementById('electron-status-bar')) {
            const bar = document.createElement('div');
            bar.id = 'electron-status-bar';
            bar.innerHTML = `
                <div class="status-left">
                    <button class="status-btn" id="status-back-btn" title="Go Back">
                        <span>⬅</span> Back
                    </button>
                    <span style="width: 1px; height: 14px; background: rgba(255,255,255,0.15); margin: 0 4px;"></span>
                    <div class="indicator-item" id="network-indicator">
                        <span class="status-dot online" id="net-dot"></span>
                        <span class="net-text" id="net-text" style="color: #2ec4b6;">Online</span>
                    </div>
                </div>
                <div class="status-right">
                    <div class="indicator-item" id="sync-indicator">
                        <span class="sync-icon" id="sync-icon">🔄</span>
                        <span class="sync-text" id="sync-text">Sync: Idle</span>
                    </div>
                    <span style="width: 1px; height: 14px; background: rgba(255,255,255,0.15); margin: 0 4px;"></span>
                    <button class="status-btn exit-btn" id="status-exit-btn" title="Exit Application">
                        <span>❌</span> Exit
                    </button>
                </div>
            `;
            document.body.appendChild(bar);

            // Bind click handlers to newly created elements
            document.getElementById('status-back-btn').addEventListener('click', () => {
                console.log('[Preload Status] Status Back button clicked. Navigating to Dashboard.');
                navigateMainWorld('/home');
            });

            document.getElementById('status-exit-btn').addEventListener('click', () => {
                console.log('[Preload Status] Exit button clicked. Sending exit-app IPC message.');
                ipcRenderer.send('exit-app');
            });

            // Bind database sync click handler to the sync indicator
            const syncIndicator = document.getElementById('sync-indicator');
            if (syncIndicator) {
                syncIndicator.addEventListener('click', triggerDatabaseSync);
            }

            // Update UI elements with latest state
            updateOnlineStatus();
            applySyncUI();
        }

        // 3. Force body padding bottom
        if (document.body.style.paddingBottom !== '28px') {
            document.body.style.setProperty('padding-bottom', '28px', 'important');
        }
    };

    applySyncUI = function() {
        const syncText = document.getElementById('sync-text');
        const syncIcon = document.getElementById('sync-icon');
        const syncIndicator = document.getElementById('sync-indicator');
        if (!syncText || !syncIcon) return;

        const isRemote = !window.location.origin.includes('127.0.0.1') && !window.location.origin.includes('localhost');

        if (isRemote) {
            syncIcon.style.display = 'none';
            syncText.innerText = 'Cloud Mode (Connected Live)';
            syncText.style.color = 'rgba(255, 255, 255, 0.6)';
            if (syncIndicator) {
                syncIndicator.style.cursor = 'default';
                syncIndicator.title = 'You are connected directly to the cloud server.';
            }
            return;
        }

        if (isPackaged) {
            syncIcon.style.display = 'inline-block';
            syncText.innerText = dbSyncStatus.message;
            if (dbSyncStatus.status === 'syncing') {
                syncIcon.classList.add('spinning');
                syncText.style.color = '#ff9f1c';
            } else if (dbSyncStatus.status === 'success') {
                syncIcon.classList.remove('spinning');
                syncText.style.color = '#2ec4b6';
            } else if (dbSyncStatus.status === 'error') {
                syncIcon.classList.remove('spinning');
                syncText.style.color = '#e71d36';
            } else {
                syncIcon.classList.remove('spinning');
                syncText.style.color = 'rgba(255, 255, 255, 0.8)';
            }
            if (syncIndicator) {
                syncIndicator.style.cursor = 'pointer';
                syncIndicator.title = 'Click to sync local database with cloud';
            }
        } else {
            // Development file watcher mode
            syncIcon.style.display = 'inline-block';
            if (syncIndicator) {
                syncIndicator.style.cursor = 'pointer';
                syncIndicator.title = 'Click to sync local database with cloud (File watcher active)';
            }
            if (dbSyncStatus.status !== 'idle') {
                // Show database sync status temporarily
                syncText.innerText = dbSyncStatus.message;
                if (dbSyncStatus.status === 'syncing') {
                    syncIcon.classList.add('spinning');
                    syncText.style.color = '#ff9f1c';
                } else if (dbSyncStatus.status === 'success') {
                    syncIcon.classList.remove('spinning');
                    syncText.style.color = '#2ec4b6';
                } else if (dbSyncStatus.status === 'error') {
                    syncIcon.classList.remove('spinning');
                    syncText.style.color = '#e71d36';
                }
            } else {
                // Show standard dev file watcher status
                if (lastSyncData.status === 'syncing') {
                    syncIcon.classList.add('spinning');
                    syncText.innerText = `Dev Sync: ${lastSyncData.file}...`;
                    syncText.style.color = '#ff9f1c';
                } else if (lastSyncData.status === 'success') {
                    syncIcon.classList.remove('spinning');
                    syncText.innerText = 'Dev Sync: Up to date';
                    syncText.style.color = '#2ec4b6';
                } else {
                    syncIcon.classList.remove('spinning');
                    syncText.innerText = 'Dev Sync: Idle';
                    syncText.style.color = 'rgba(255, 255, 255, 0.7)';
                }
            }
        }
    }

    // Initialize status bar
    injectStatusBar();

    // Use MutationObserver to observe both style changes AND children deletion/wiping
    const observer = new MutationObserver((mutations) => {
        let needsReinject = false;
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                const barPresent = document.getElementById('electron-status-bar');
                const stylePresent = document.getElementById('electron-status-bar-style');
                if (!barPresent || !stylePresent) {
                    needsReinject = true;
                    break;
                }
            } else if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                if (document.body.style.paddingBottom !== '28px') {
                    needsReinject = true;
                    break;
                }
            }
        }
        if (needsReinject) {
            injectStatusBar();
        }
    });

    observer.observe(document.body, { 
        childList: true, 
        attributes: true, 
        attributeFilter: ['style'],
        subtree: false 
    });

    // Initial check and regular check for network
    updateOnlineStatus();
    
    // Auto sync when internet transitions from offline to online
    window.addEventListener('online', () => {
        updateOnlineStatus();
        console.log('[Preload Status] Internet restored. Auto-triggering database sync...');
        triggerDatabaseSync();
    });
    
    window.addEventListener('offline', updateOnlineStatus);
    setInterval(updateOnlineStatus, 8000);

    // Auto-sync 3 seconds after page load if online
    setTimeout(() => {
        if (navigator.onLine && !isSyncing) {
            console.log('[Preload Status] Page load database auto-sync...');
            triggerDatabaseSync();
        }
    }, 3000);

    // Periodic auto-sync every 30 seconds if online
    setInterval(() => {
        if (navigator.onLine && !isSyncing) {
            console.log('[Preload Status] Periodic database auto-sync...');
            triggerDatabaseSync();
        }
    }, 30000);


    // Listeners for IPC Sync / Info
    ipcRenderer.on('app-info', (event, info) => {
        isPackaged = info.isPackaged;
        applySyncUI();
    });

    ipcRenderer.on('sync-status', (event, data) => {
        if (isPackaged) return;
        
        clearTimeout(resetTimeout);
        lastSyncData = {
            status: data.status,
            file: data.file ? data.file.split(/[\\/]/).pop() : ''
        };
        applySyncUI();

        if (data.status === 'success') {
            resetTimeout = setTimeout(() => {
                lastSyncData = { status: 'idle', file: '' };
                applySyncUI();
            }, 3000);
        }
    });
});
