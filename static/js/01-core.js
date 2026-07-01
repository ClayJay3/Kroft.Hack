// Globals
let activeSessionId = null;
let terminalInstance = null;
let terminalFit     = null;
let allHosts        = [];
let currentModule   = null;
let currentModuleInfo = null;

// Runtime config (server-side settings, persisted in the DB)
// Defaults are empty: the operator sets the Ollama endpoint, default model, and
// context window on the Settings page. Until then Kroft.AI stays inert rather
// than reaching out to a hardcoded host. loadKroftConfig() refreshes these from
// /api/settings (called at init and after every Save).
let kroftConfig = { ollama_base: '', ollama_model: '', ollama_num_ctx: '' };

async function loadKroftConfig() {
    try {
        const s = await (await fetch('/api/settings')).json();
        kroftConfig.ollama_base    = (s.ollama_base    || '').trim().replace(/\/+$/, '');
        kroftConfig.ollama_model   = (s.ollama_model   || '').trim();
        kroftConfig.ollama_num_ctx = (s.ollama_num_ctx || '').trim();
    } catch { /* keep empty defaults */ }
}

// Build the Ollama request `options` object, injecting the configured context
// window only when the operator has set one (otherwise Ollama uses the model's
// own default rather than a hardcoded number).
function ollamaOptions(extra) {
    const opts = Object.assign({}, extra || {});
    const ctx = parseInt(kroftConfig.ollama_num_ctx, 10);
    if (ctx > 0) opts.num_ctx = ctx;
    return opts;
}

// Clock
setInterval(() => {
    document.getElementById('clock').innerText = new Date().toLocaleTimeString([], {hour12:false});
}, 1000);

// Tab switching
function switchTab(tabId) {
    // Let the 3D visualizer pause its render loop whenever we navigate away.
    if (tabId !== 'cyberspace' && typeof cyberOnTabClose === 'function') cyberOnTabClose();

    document.querySelectorAll('.tab-content').forEach(el => {
        el.classList.add('hidden'); el.classList.remove('flex');
    });
    document.getElementById(tabId).classList.remove('hidden');
    document.getElementById(tabId).classList.add('flex');

    const titles = {
        matrix: 'Asset Matrix', scanner: 'Advanced Scanner',
        findings: 'Findings & Loot',
        pentest: 'Pentest Console', shells: 'Active Shells',
        kroftai: 'Kroft.AI: Autonomous Recon & Exploit Advisor',
        cyberspace: 'Cyberspace: Live Attack Visualizer',
        postaux: 'Post / Auxiliary Console',
        msfconsole: 'MSF Console: Interactive Terminal'
    };
    document.getElementById('page-title').innerText = titles[tabId] || tabId;

    document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.remove('active', 'active-red', 'active-violet', 'active-cyan');
    });
    const btn = document.getElementById('tab-' + tabId);
    if (btn) {
        if (tabId === 'pentest' || tabId === 'shells') btn.classList.add('active-red');
        else if (tabId === 'kroftai') btn.classList.add('active-violet');
        else if (tabId === 'postaux') btn.classList.add('active-red');
        else if (tabId === 'cyberspace') btn.classList.add('active-cyan');
        else btn.classList.add('active');
    }

    if (tabId === 'cyberspace' && typeof cyberOnTabOpen === 'function') cyberOnTabOpen();
    if (tabId === 'matrix')      fetchHosts();
    if (tabId === 'findings')    fetchLoot();
    if (tabId === 'pentest')     { fetchExploitLogs(); populateTargetDropdown(); }
    if (tabId === 'kroftai')     { kroftAiOnTabOpen(); }
    if (tabId === 'postaux')     { paOnTabOpen(); }
    if (tabId === 'msfconsole')  { msfcInit(); }
    if (tabId === 'shells')  {
        fetchSessions();
        // Defer terminal init until after the browser paints the now-visible tab
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                initTerminal();
                if (terminalFit) terminalFit.fit();
                if (terminalInstance) terminalInstance.focus();
            });
        });
    }
}

