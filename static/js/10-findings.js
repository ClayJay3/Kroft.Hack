// FINDINGS / LOOT
let _lootCache = [];
async function fetchLoot() {
    try {
        const res = await fetch('/api/loot');
        _lootCache = await res.json();
    } catch { _lootCache = []; }
    renderLootTable();
    const badge = document.getElementById('loot-badge');
    if (badge) {
        badge.textContent = _lootCache.length;
        badge.classList.toggle('hidden', !_lootCache.length);
    }
}

const LOOT_COLORS = {
    credential: 'text-red-400 bg-red-500/10 border-red-500/25',
    hash:       'text-orange-400 bg-orange-500/10 border-orange-500/25',
    key:        'text-amber-400 bg-amber-500/10 border-amber-500/25',
    ssid:       'text-cyan-400 bg-cyan-500/10 border-cyan-500/25',
    token:      'text-violet-400 bg-violet-500/10 border-violet-500/25',
    file:       'text-blue-400 bg-blue-500/10 border-blue-500/25',
    info:       'text-gray-400 bg-gray-500/10 border-gray-500/25',
};
function renderLootTable() {
    const tb = document.getElementById('loot-table');
    if (!tb) return;
    if (!_lootCache.length) {
        tb.innerHTML = '<tr><td colspan="7" class="text-center py-20 text-gray-600">No findings yet. Loot is captured automatically as Kroft.AI analyzes module output.</td></tr>';
        return;
    }
    tb.innerHTML = _lootCache.map(l => {
        const c = LOOT_COLORS[(l.type || 'info').toLowerCase()] || LOOT_COLORS.info;
        const val = l.username ? `${l.username} : ${l.value}` : l.value;
        return `<tr class="hover:bg-[#0a0c10] transition-colors border-b border-[#14171d]/60">
            <td class="px-5 py-3"><span class="text-[9px] font-bold uppercase px-2 py-0.5 rounded border ${c}">${escHtml(l.type || 'info')}</span></td>
            <td class="px-5 py-3 font-mono text-xs text-gray-200 break-all max-w-sm">${escHtml(val || '')}</td>
            <td class="px-5 py-3 font-mono text-[11px] text-blue-400">${escHtml(l.host_ip || '-')}</td>
            <td class="px-5 py-3 text-[11px] text-gray-500 font-mono">${escHtml(l.service || '-')}</td>
            <td class="px-5 py-3 text-[11px] text-gray-500 font-mono truncate max-w-[160px]" title="${escHtml(l.source||'')}">${escHtml(l.source || '-')}</td>
            <td class="px-5 py-3 text-[10px] text-gray-600 font-mono whitespace-nowrap">${escHtml(l.found_at || '')}</td>
            <td class="px-4 py-3 text-right"><button onclick="deleteLoot(${l.id})" class="text-gray-600 hover:text-red-400 transition-colors p-1" title="Delete"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button></td>
        </tr>`;
    }).join('');
}
async function deleteLoot(id) {
    try { await fetch(`/api/loot/${id}`, { method: 'DELETE' }); } catch {}
    fetchLoot();
}

// AI extracts structured findings from job output and persists them as loot.
async function kaiExtractLoot(label, outputText, hostIp) {
    if (!outputText || outputText.trim().length < 15) return;
    const SYS = `You extract security findings from Metasploit/scan output. Respond with ONLY a JSON array (possibly empty) of findings. Each item: {"type": one of credential|hash|key|ssid|token|file|info, "value": the secret/finding, "username": optional, "service": optional}. Extract ONLY concrete secrets actually present in the output — credentials, password hashes, keys, SSIDs/Wi-Fi keys, tokens, sensitive file contents. Do NOT invent anything. If there are no real findings, return [].`;
    const USR = `Target host: ${hostIp || 'unknown'}\nModule/source: ${label}\n\nOutput:\n${outputText.slice(0, 6000)}\n\nReturn the JSON array of findings.`;
    try {
        const parsed = JSON.parse(extractJsonBlock(await callOllama(SYS, USR)));
        const items = (Array.isArray(parsed) ? parsed : (parsed.findings || []))
            .filter(x => x && x.value)
            .map(x => ({ ...x, host_ip: hostIp || '', source: label }));
        if (!items.length) return;
        const res = await fetch('/api/loot', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ items })
        });
        const d = await res.json();
        if (d.added > 0) {
            fetchLoot();
            aiAddMessage('system-inject',
                `🏆 ${d.added} finding${d.added > 1 ? 's' : ''} captured to <span class="text-amber-400 cursor-pointer underline" onclick="switchTab('findings')">Findings</span>`);
            kaiNotify('Loot captured', `${d.added} new finding(s) from ${label}`);
        }
    } catch { /* extraction is best-effort */ }
}

// SETTINGS / SCOPE
async function loadScopeIndicator() {
    try {
        const s = await (await fetch('/api/settings')).json();
        const scope = (s.scope_cidr || '').trim();
        const ind = document.getElementById('scope-indicator');
        if (scope) {
            document.getElementById('scope-indicator-text').textContent = 'scope: ' + scope;
            ind.classList.remove('hidden'); ind.classList.add('flex');
        } else {
            ind.classList.add('hidden'); ind.classList.remove('flex');
        }
    } catch {}
}
async function openSettings() {
    try {
        const s = await (await fetch('/api/settings')).json();
        document.getElementById('settings-scope').value        = s.scope_cidr || '';
        document.getElementById('settings-ollama-base').value  = s.ollama_base || '';
        document.getElementById('settings-ollama-model').value = s.ollama_model || '';
        document.getElementById('settings-ollama-ctx').value   = s.ollama_num_ctx || '';
    } catch {}
    const m = document.getElementById('settings-modal');
    m.classList.remove('hidden'); m.classList.add('flex');
}
function closeSettings() {
    const m = document.getElementById('settings-modal');
    m.classList.add('hidden'); m.classList.remove('flex');
}
async function saveSettings() {
    const payload = {
        scope_cidr:     document.getElementById('settings-scope').value.trim(),
        ollama_base:    document.getElementById('settings-ollama-base').value.trim(),
        ollama_model:   document.getElementById('settings-ollama-model').value.trim(),
        ollama_num_ctx: document.getElementById('settings-ollama-ctx').value.trim(),
    };
    try {
        await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    } catch {}
    closeSettings();
    loadScopeIndicator();
    // Refresh the in-memory Ollama config so the new endpoint/model/context take
    // effect immediately, then re-check connectivity if the AI tab is open.
    await loadKroftConfig();
    if (typeof checkOllamaStatus === 'function') checkOllamaStatus();
}

// ENGAGEMENT REPORT
let _reportText = '', _reportIp = '';
async function generateReport(ip) {
    ip = ip || aiCurrentTarget;
    if (!ip) { alert('Pick a target first.'); return; }
    _reportIp = ip;
    const modal = document.getElementById('report-modal');
    modal.classList.remove('hidden'); modal.classList.add('flex');
    document.getElementById('report-title').textContent = `Engagement Report: ${ip}`;
    document.getElementById('report-download').classList.add('hidden');
    const body = document.getElementById('report-body');
    body.innerHTML = '<div class="text-violet-400/70 animate-pulse text-sm">Gathering engagement data and writing report…</div>';
    let data;
    try { data = await (await fetch(`/api/report/${encodeURIComponent(ip)}`)).json(); }
    catch { body.innerHTML = '<div class="text-red-400 text-sm">Failed to load engagement data.</div>'; return; }

    const SYS = `You are a penetration testing report writer. Write a clear, professional engagement report in GitHub-flavored markdown. Sections: ## Executive Summary, ## Target, ## Findings (with severity), ## What Worked / Attack Path, ## Loot & Credentials, ## Recommendations. Base everything ONLY on the supplied data — do not invent findings. Be concise and factual.`;
    const USR = `Engagement data (JSON):\n\n${JSON.stringify(data, null, 2)}\n\nWrite the report now.`;
    try {
        _reportText = await callOllama(SYS, USR);
        _reportText = _reportText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        body.innerHTML = formatAiReply(_reportText);
        document.getElementById('report-download').classList.remove('hidden');
    } catch (e) {
        body.innerHTML = `<div class="text-red-400 text-sm">Report generation failed: ${escHtml(e.message)}</div>`;
    }
}
function closeReport() {
    const m = document.getElementById('report-modal');
    m.classList.add('hidden'); m.classList.remove('flex');
}
function downloadReport() {
    if (!_reportText) return;
    const blob = new Blob([_reportText], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kroft_report_${_reportIp.replace(/[^\w.]/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
}

