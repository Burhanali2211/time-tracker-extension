/**
 * Browser Buddy: Premium UX Controller
 * Handles animated rings, glassmorphic interactions, and remote sync.
 */

// --- UTILS ---
function formatTime(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));

    if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function getFaviconUrl(domain) {
    return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
}

const GREETINGS = [
    { hour: 5, text: "Good Morning, Buddy! ☀️" },
    { hour: 12, text: "Good Afternoon, Buddy! 🌤️" },
    { hour: 17, text: "Good Evening, Buddy! 🌙" },
    { hour: 21, text: "Late Night Focus? 🦉" }
];

// --- CORE RENDERER ---
async function render() {
    const data = await chrome.storage.local.get(['stats', 'cookieData']);
    const stats = data.stats || {};
    const cookies = data.cookieData || {};

    const totalMs = Object.values(stats).reduce((acc, curr) => acc + curr, 0);
    const sortedDomains = Object.keys(stats).sort((a, b) => stats[b] - stats[a]);

    // 1. Update Hero Ring
    const totalTimeEl = document.getElementById('total-time');
    const totalRing = document.getElementById('total-progress-ring');
    if (totalTimeEl) totalTimeEl.textContent = formatTime(totalMs);

    // Animate hero ring (100% full for today)
    if (totalRing) {
        totalRing.style.strokeDashoffset = totalMs > 0 ? "0" : "283";
    }

    // 2. Render Time Stats List
    const statsList = document.getElementById('stats-list');
    if (statsList) {
        statsList.innerHTML = '';
        sortedDomains.forEach(domain => {
            const domainMs = stats[domain];
            const percentage = totalMs > 0 ? (domainMs / totalMs) : 0;
            const dashOffset = 100 - (percentage * 100);

            const div = document.createElement('div');
            div.className = 'stat-item';
            div.innerHTML = `
                <div class="mini-ring">
                    <img src="${getFaviconUrl(domain)}" class="item-favicon" onerror="this.src='../icons/icon16.png'">
                    <svg viewBox="0 0 36 36">
                        <circle class="mini-circle-bg" cx="18" cy="18" r="15.9"></circle>
                        <circle class="mini-circle-fill" cx="18" cy="18" r="15.9" 
                                style="stroke-dashoffset: ${dashOffset}"></circle>
                    </svg>
                </div>
                <div class="item-info">
                    <span class="item-name">${domain}</span>
                    <span class="item-time">${formatTime(domainMs)} spent</span>
                </div>
            `;
            statsList.appendChild(div);
        });
    }

    // 3. Render Cookie Secrets
    const cookieList = document.getElementById('cookie-list');
    const searchInput = document.getElementById('cookie-search');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

    if (cookieList) {
        cookieList.innerHTML = '';
        const filtered = Object.keys(cookies).filter(d => d.toLowerCase().includes(searchTerm));

        filtered.forEach(domain => {
            const domainCookies = cookies[domain] || [];
            const div = document.createElement('div');
            div.className = 'stat-item';
            div.style.cursor = 'pointer';
            div.innerHTML = `
                <img src="${getFaviconUrl(domain)}" class="header-logo" style="width:24px; height:24px; border-radius:4px" onerror="this.src='../icons/icon16.png'">
                <div class="item-info">
                    <span class="item-name">${domain}</span>
                    <span class="item-time">${domainCookies.length} secrets found</span>
                </div>
                <div class="item-arrow">→</div>
            `;
            div.onclick = () => showOverlay(domain, domainCookies);
            cookieList.appendChild(div);
        });
    }

    // 4. Empty State
    const noData = document.getElementById('no-data');
    if (noData) {
        const hasAny = sortedDomains.length > 0 || Object.keys(cookies).length > 0;
        noData.classList.toggle('hidden', hasAny);
    }
}

// --- INTERACTIONS ---
function showOverlay(domain, cookies) {
    const overlay = document.getElementById('cookie-detail-overlay');
    const title = document.getElementById('detail-domain-name');
    const list = document.getElementById('detail-cookie-list');

    title.textContent = domain;
    list.innerHTML = '';

    cookies.forEach(c => {
        const div = document.createElement('div');
        div.className = 'detail-cookie';
        div.innerHTML = `
            <span class="c-key">${c.name}</span>
            <div class="c-val-cnt"><code>${c.value || '(empty)'}</code></div>
        `;
        list.appendChild(div);
    });

    overlay.classList.remove('hidden');
}

// Scroll-based UI Compaction Logic
function setupScrollCompaction() {
    const panes = document.querySelectorAll('.scroll-area');
    const container = document.querySelector('.glass-container');

    panes.forEach(pane => {
        pane.addEventListener('scroll', () => {
            if (pane.scrollTop > 20) {
                container.classList.add('compact');
            } else {
                container.classList.remove('compact');
            }
        });
    });
}

// Tab Switching logic
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        const paneId = `tab-${btn.dataset.tab}`;
        const activePane = document.getElementById(paneId);
        if (activePane) activePane.classList.add('active');

        // Reset compaction when switching tabs
        document.querySelector('.glass-container').classList.remove('compact');
    };
});

// Close Overlay
document.getElementById('close-overlay').onclick = () => {
    document.getElementById('cookie-detail-overlay').classList.add('hidden');
};

// Search Filter
document.getElementById('cookie-search').oninput = render;

// Export
document.getElementById('export-json').onclick = async () => {
    const data = await chrome.storage.local.get(null);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
        url: url,
        filename: `buddy-dump-${new Date().getTime()}.json`
    });
};

// Reset
document.getElementById('reset-btn').onclick = async () => {
    if (confirm("Clear all data? Buddy will start fresh.")) {
        await chrome.storage.local.set({ stats: {}, cookieData: {}, webStorage: {} });
        render();
    }
};

// Sync Logic
const syncBtn = document.getElementById('sync-telegram');
syncBtn.onclick = () => {
    const btnText = syncBtn.querySelector('.btn-text');
    const spinner = document.getElementById('sync-spinner');

    btnText.textContent = "Refreshing...";
    spinner.classList.remove('hidden');
    syncBtn.disabled = true;

    chrome.runtime.sendMessage({ action: 'sync_telegram' }, () => {
        setTimeout(() => {
            btnText.textContent = "Refresh Complete!";
            spinner.classList.add('hidden');

            setTimeout(() => {
                btnText.textContent = "Refresh";
                syncBtn.disabled = false;
            }, 2000);
        }, 1000);
    });
};

// Greetings
function setGreeting() {
    const h = new Date().getHours();
    const greet = GREETINGS.find(g => h < (g.hour + 6)) || GREETINGS[0];
    document.getElementById('user-greeting').textContent = greet.text;
}

// Initial Run
setGreeting();
render();
setupScrollCompaction(); // New space-optimization
setInterval(render, 10000); // Polished refresh rate
