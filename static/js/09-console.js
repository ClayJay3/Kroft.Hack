// MSF Interactive Console
let msfcConsoleId   = null;
let msfcPollTimer   = null;
let msfcCmdHistory  = [];
let msfcHistoryIdx  = -1;
let msfcInitialized = false;

async function msfcInit() {
    if (msfcInitialized) return;
    msfcInitialized = true;
    msfcAppend('\x1b[33m[*]\x1b[0m Connecting to msfconsole…\n', 'text-yellow-400');
    await msfcConnect();
}

async function msfcConnect() {
    try {
        const res  = await fetch('/api/msf/console/create', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Failed');
        msfcConsoleId = data.console_id;
        document.getElementById('msfc-console-id').textContent = msfcConsoleId;
        document.getElementById('msfc-status-text').textContent = 'Connected · id ' + msfcConsoleId;
        if (data.banner) msfcAppend(data.banner, 'text-orange-300/80');
        msfcStartPolling();
        document.getElementById('msfc-input').focus();
    } catch(e) {
        msfcAppend('[!] Could not connect: ' + e.message + '\n', 'text-red-400');
        document.getElementById('msfc-status-text').textContent = 'Error: check MSF RPC';
    }
}

function msfcStartPolling() {
    if (msfcPollTimer) clearInterval(msfcPollTimer);
    msfcPollTimer = setInterval(msfcPoll, 800);
}

async function msfcPoll() {
    if (!msfcConsoleId) return;
    try {
        const res  = await fetch(`/api/msf/console/${msfcConsoleId}/read`);
        const data = await res.json();
        if (data.data && data.data.trim()) {
            msfcAppend(data.data, 'text-green-300');
        }
        const busyEl = document.getElementById('msfc-busy-indicator');
        if (data.busy) busyEl.classList.remove('hidden'), busyEl.classList.add('flex');
        else           busyEl.classList.add('hidden'),    busyEl.classList.remove('flex');
        if (data.prompt && data.prompt.trim()) {
            document.getElementById('msfc-prompt').textContent = data.prompt.trim() + ' >';
        }
    } catch { /* silent */ }
}

function msfcAppend(text, colorClass) {
    const out = document.getElementById('msfc-output');
    if (!out) return;
    const span = document.createElement('span');
    if (colorClass) span.className = colorClass;
    span.textContent = text;
    out.appendChild(span);
    out.scrollTop = out.scrollHeight;
}

async function msfcSend() {
    const input = document.getElementById('msfc-input');
    const cmd   = input.value;   // allow empty (just Enter) to refresh prompt
    input.value = '';
    if (cmd.trim()) {
        msfcCmdHistory.unshift(cmd);
        if (msfcCmdHistory.length > 100) msfcCmdHistory.pop();
    }
    msfcHistoryIdx = -1;
    // Echo locally
    msfcAppend((document.getElementById('msfc-prompt').textContent || 'msf6 >') + ' ' + cmd + '\n', 'text-gray-400');
    if (!msfcConsoleId) { msfcAppend('[!] Not connected. Click Reconnect.\n', 'text-red-400'); return; }
    try {
        await fetch(`/api/msf/console/${msfcConsoleId}/write`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: cmd })
        });
    } catch(e) {
        msfcAppend('[!] Send error: ' + e.message + '\n', 'text-red-400');
    }
}

function msfcInputKeydown(e) {
    if (e.key === 'Enter') { e.preventDefault(); msfcSend(); }
    else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (msfcHistoryIdx < msfcCmdHistory.length - 1) {
            msfcHistoryIdx++;
            document.getElementById('msfc-input').value = msfcCmdHistory[msfcHistoryIdx] || '';
        }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (msfcHistoryIdx > 0) {
            msfcHistoryIdx--;
            document.getElementById('msfc-input').value = msfcCmdHistory[msfcHistoryIdx] || '';
        } else {
            msfcHistoryIdx = -1;
            document.getElementById('msfc-input').value = '';
        }
    }
}

function msfcClear() {
    document.getElementById('msfc-output').innerHTML = '';
}

async function msfcReconnect() {
    if (msfcPollTimer) { clearInterval(msfcPollTimer); msfcPollTimer = null; }
    if (msfcConsoleId) {
        try { await fetch(`/api/msf/console/${msfcConsoleId}/destroy`, { method: 'POST' }); } catch {}
        msfcConsoleId = null;
    }
    document.getElementById('msfc-console-id').textContent = '-';
    document.getElementById('msfc-status-text').textContent = 'Reconnecting…';
    msfcClear();
    await msfcConnect();
}

// Ollama model picker
// Seed from the saved default so the user's choice persists across page loads.
let ollamaCurrentModel = (() => { try { return localStorage.getItem('kroft_ollama_model') || null; } catch { return null; } })();

async function fetchOllamaModels() {
    try {
        const res  = await fetch('/api/ollama/models');
        const data = await res.json();
        const sel  = document.getElementById('ollama-model-select');
        const models = data.models || [];
        if (!models.length) {
            sel.innerHTML = '<option value="">No models found</option>';
            return;
        }
        const prev = ollamaCurrentModel || sel.value;
        sel.innerHTML = models.map(m =>
            `<option value="${escHtml(m)}" ${m === prev ? 'selected' : ''}>${escHtml(m)}</option>`
        ).join('');
        // Set active model: prefer saved, else first
        const chosen = models.includes(prev) ? prev : models[0];
        ollamaCurrentModel = chosen;
        sel.value = chosen;
    } catch(e) {
        const sel = document.getElementById('ollama-model-select');
        if (sel) sel.innerHTML = '<option value="">ollama offline</option>';
    }
}

function ollamaModelChanged(model) {
    if (!model) return;
    ollamaCurrentModel = model;
    try { localStorage.setItem('kroft_ollama_model', model); } catch { /* storage disabled */ }
}

function getActiveOllamaModel() {
    // Prefer the model picked in the AI tab dropdown; otherwise fall back to the
    // default model configured on the Settings page (no hardcoded model name).
    return ollamaCurrentModel || kroftConfig.ollama_model;
}

