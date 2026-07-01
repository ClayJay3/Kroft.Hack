// NOTIFICATIONS
function kaiNotify(title, body) {
    try {
        if (window.Notification && Notification.permission === 'granted') {
            new Notification(title, { body });
        }
    } catch {}
    // Short beep via WebAudio
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine'; o.frequency.value = 660;
        g.gain.setValueAtTime(0.04, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
        o.start(); o.stop(ctx.currentTime + 0.3);
    } catch {}
}
if (window.Notification && Notification.permission === 'default') {
    try { Notification.requestPermission(); } catch {}
}

// CREDENTIAL REUSE / SPRAY
function lootSprayPrompt() {
    const creds = _lootCache.filter(l => ['credential', 'key'].includes((l.type || '').toLowerCase()) && l.value);
    if (!creds.length) { alert('No captured credentials to reuse yet.'); return; }
    const users = [...new Set(creds.map(c => c.username).filter(Boolean))];
    const passes = [...new Set(creds.map(c => c.value).filter(Boolean))];
    switchTab('kroftai');
    const msg = `I have these captured credentials to reuse across the network:\n` +
        creds.map(c => `- ${c.username ? c.username + ' / ' : ''}${c.value} (${c.service || '?'} from ${c.host_ip || '?'})`).join('\n') +
        `\n\nWhich login/auth Metasploit modules should I run to spray these against the in-scope hosts, and how should I set USERNAME/PASSWORD (or USERPASS) options? Give me one combined msf block per module.`;
    document.getElementById('ai-chat-input').value = msg;
    aiAddMessage('system-inject', `Reusing ${creds.length} captured credential(s) — sent to Kroft.AI for spray planning`);
    sendAiChatMessage();
}

// AUTO POST-RECON ON NEW SHELL
const _postReconDone = new Set();
async function kaiAutoPostRecon(sid, type, target) {
    if (_postReconDone.has(String(sid))) return;
    _postReconDone.add(String(sid));
    const cmds = (type === 'meterpreter')
        ? ['sysinfo', 'getuid', 'getprivs']
        : ['id', 'uname -a', 'hostname', 'sudo -n -l 2>/dev/null', 'cat /etc/passwd 2>/dev/null | head -20'];
    aiAddMessage('system-inject',
        `🐚 New session ${escHtml(String(sid))} on ${escHtml(target || '?')} — running baseline post-recon…`);
    let combined = '';
    for (const cmd of cmds) {
        try {
            const r = await fetch(`/api/msf/sessions/${encodeURIComponent(sid)}/exec`, {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ cmd })
            });
            const d = await r.json();
            combined += `$ ${cmd}\n${(d.output || d.error || '').trim()}\n\n`;
        } catch { /* skip */ }
    }
    if (combined.trim().length < 5) return;
    // Feed to the AI for analysis + next-step suggestions (uses a synthetic job id).
    if (!aiCurrentTarget) aiCurrentTarget = target;
    await feedJobOutputToAI('postrecon-' + sid + '-' + Date.now(),
        `post-recon session ${sid}`, combined);
}

// CVE ENRICHMENT
async function showHostCves(ip) {
    const host = (allHosts || []).find(h => h.ip === ip);
    // Pull "product version" strings from the ports column, e.g. "(dnsmasq 2.85)".
    const services = [...new Set([...((host && host.ports) || '').matchAll(/\(([^)]+)\)/g)]
        .map(m => m[1].trim()).filter(s => s.length > 2))].slice(0, 8);
    _reportText = '';   // keep the download button hidden (reusing the report modal)
    const modal = document.getElementById('report-modal');
    modal.classList.remove('hidden'); modal.classList.add('flex');
    document.getElementById('report-title').textContent = `Known CVEs: ${ip}`;
    document.getElementById('report-download').classList.add('hidden');
    const body = document.getElementById('report-body');
    if (!services.length) {
        body.innerHTML = '<div class="text-gray-500 text-sm">No service/version strings detected for this host. Run a version scan (-sV) first.</div>';
        return;
    }
    body.innerHTML = '<div class="text-amber-400/70 animate-pulse text-sm">Looking up CVEs for: ' + services.map(escHtml).join(', ') + '…</div>';
    let html = '';
    for (const svc of services) {
        let cves = [];
        try { cves = (await (await fetch('/api/cve?q=' + encodeURIComponent(svc))).json()).cves || []; } catch {}
        html += `<div class="mb-4"><div class="text-xs font-bold text-gray-300 font-mono mb-1.5">${escHtml(svc)}</div>`;
        if (!cves.length) {
            html += '<div class="text-[11px] text-gray-600 italic">No CVEs found (or lookup unavailable).</div>';
        } else {
            html += cves.slice(0, 6).map(c => {
                const sev = (c.score >= 9) ? 'text-red-400 border-red-500/30' : (c.score >= 7) ? 'text-orange-400 border-orange-500/30' : (c.score >= 4) ? 'text-yellow-400 border-yellow-500/30' : 'text-gray-400 border-gray-500/30';
                return `<div class="border-l-2 ${sev} pl-2 mb-1.5">
                    <a href="https://nvd.nist.gov/vuln/detail/${encodeURIComponent(c.id)}" target="_blank" class="font-mono text-[11px] ${sev.split(' ')[0]} hover:underline">${escHtml(c.id)}</a>
                    <span class="text-[10px] text-gray-500 ml-1">CVSS ${c.score != null ? c.score : '?'}</span>
                    <div class="text-[10px] text-gray-500 leading-snug">${escHtml(c.summary || '')}</div>
                </div>`;
            }).join('');
        }
        html += '</div>';
        body.innerHTML = html;   // progressive render
    }
}

