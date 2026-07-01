// MSF status indicator
async function checkMsfStatus() {
    try {
        const res = await fetch('/api/msf/status');
        const data = await res.json();
        const dot   = document.getElementById('msf-dot');
        const label = document.getElementById('msf-label');
        if (data.connected) {
            dot.className = 'w-1.5 h-1.5 bg-green-500 rounded-full shadow-[0_0_6px_rgba(34,197,94,0.8)]';
            label.innerHTML = `msf <span class="text-green-500">${data.version||'ok'}</span>`;
        } else {
            dot.className = 'w-1.5 h-1.5 bg-red-500/60 rounded-full';
            label.innerHTML = `msf <span class="text-red-500/60">offline</span>`;
        }
    } catch(e) { /* silent */ }
}

// Kroft.AI
// The Ollama endpoint, default model and context window live in kroftConfig
// (loaded from the Settings page; see 01-core.js). Nothing here is hardcoded.
let aiCurrentTarget  = null;
let aiCurrentModule  = null;
let aiCurrentOptions = {};
let aiCurrentScanCmd = null;

// Conversation state
let aiConversationHistory = [];   // [{role:'user'|'assistant', content:'...'}]
let aiSystemPrompt        = null; // Set at analysis time, reused for follow-ups
let aiHasAnalysis         = false;
let aiIsThinking          = false;
// Track job outputs already fed to AI to avoid re-injection
let aiInjectedJobIds      = new Set();

function kroftAiOnTabOpen() {
    populateAiTargetDropdown();
    checkOllamaStatus();
    refreshPostSessions();
}

function populateAiTargetDropdown() {
    const sel = document.getElementById('ai-target-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Pick a discovered host —</option>';
    allHosts.forEach(h => {
        const opt = document.createElement('option');
        opt.value = h.ip;
        opt.textContent = `${h.ip}  (${h.hostname || h.os || '?'})`;
        sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
}

function aiTargetChanged() {
    const ip = document.getElementById('ai-target-select').value;
    aiCurrentTarget = ip || null;
    const badge  = document.getElementById('ai-target-badge');
    const host   = allHosts.find(h => h.ip === ip);
    if (ip) {
        badge.classList.remove('hidden');
        document.getElementById('ai-badge-ip').textContent = ip;
        document.getElementById('ai-badge-os').textContent = (host && host.os) ? host.os : 'OS unknown';
    } else {
        badge.classList.add('hidden');
    }
}

async function checkOllamaStatus() {
    const dot   = document.getElementById('ollama-dot');
    const label = document.getElementById('ollama-label');
    if (!kroftConfig.ollama_base) {
        dot.className   = 'w-1.5 h-1.5 bg-gray-700 rounded-full';
        label.textContent = 'ollama not set';
        return;
    }
    try {
        const res = await fetch(kroftConfig.ollama_base + '/api/tags', {signal: AbortSignal.timeout(4000)});
        if (res.ok) {
            dot.className   = 'w-1.5 h-1.5 bg-violet-400 rounded-full shadow-[0_0_6px_rgba(139,92,246,0.8)]';
            label.textContent = 'ollama ✓';
            fetchOllamaModels();
        } else throw new Error();
    } catch {
        dot.className   = 'w-1.5 h-1.5 bg-red-500/60 rounded-full';
        label.textContent = 'ollama offline';
    }
}

function buildReconContext(host) {
    if (!host) return 'No scan data available.';
    const lines = [];
    lines.push(`IP: ${host.ip}`);
    if (host.hostname && host.hostname !== 'Unknown') lines.push(`Hostname: ${host.hostname}`);
    if (host.mac && host.mac !== '—') lines.push(`MAC: ${host.mac}`);

    // Spell out what is ALREADY known vs. still unknown so the model can decide
    // whether another scan is actually warranted (instead of always scanning).
    const hasOs = host.os && host.os !== 'Unknown';
    lines.push(`OS detection: ${hasOs ? host.os : 'NOT yet identified'}`);

    if (host.ports) {
        const portLines = host.ports.split('\n').filter(Boolean);
        // open_ports lines carry "(product version)" only when version detection ran
        const withVer = portLines.filter(l => l.includes('(')).length;
        lines.push(`Open ports (already enumerated, ${portLines.length} total):\n${host.ports}`);
        lines.push(`Service/version detail: ${withVer} of ${portLines.length} ports already have product/version info.`);
    } else {
        lines.push('Open ports: NONE enumerated yet — no port-scan data on record.');
    }
    if (host.last_seen) lines.push(`Last scanned: ${host.last_seen}`);
    return lines.join('\n');
}

// Derive Metasploit search keywords from a host's recon (service names + products).
function deriveModuleKeywords(host) {
    if (!host || !host.ports) return [];
    const NOISE = new Set(['open','closed','filtered','tcp','udp','syn-ack','ttl','unknown',
        'http','https','service','version','product','os','linux','windows','microsoft',
        'and','the','for','via','server','daemon']);
    const kws = [];
    const seen = new Set();
    const add = (w) => {
        const t = (w || '').toLowerCase().replace(/[^a-z0-9._-]/g,'');
        if (t.length < 3 || /^\d+(\.\d+)*$/.test(t) || NOISE.has(t) || seen.has(t)) return;
        seen.add(t); kws.push(t);
    };
    host.ports.split('\n').forEach(line => {
        // e.g. "21/tcp open ftp vsftpd 2.3.4"  -> keep ftp, vsftpd
        const m = line.match(/^\s*\d+\/\w+\s+\w+\s+([\w.\-]+)(?:\s+(.*))?/);
        if (m) {
            add(m[1]);                                  // service name (ftp, ssh, ...)
            if (m[2]) m[2].split(/\s+/).slice(0,2).forEach(add); // product words
        }
    });
    return kws.slice(0, 12);
}

// Rank real modules by how well they match the host's detected services, so the
// most relevant exploits surface first (and the deterministic fallback is sane).
// Infer a module's target platform from its path (exploit/windows/..., /linux/, /unix/).
function modulePlatform(fullname) {
    const seg = (fullname.split('/')[1] || '').toLowerCase();
    if (seg === 'windows' || seg === 'win') return 'windows';
    if (seg === 'linux') return 'linux';
    if (seg === 'unix') return 'unix';               // unix is linux-compatible
    if (seg === 'osx' || seg === 'apple_ios') return 'osx';
    return '';                                        // multi / android / hardware / etc.
}

function rankCandidatesByRelevance(candidates, host) {
    const kws = deriveModuleKeywords(host);
    const RANK = { excellent: 5, great: 4, good: 3, normal: 2, average: 1 };
    const os = ((host && host.os) || '').toLowerCase();
    const targetPlat = os.includes('windows') ? 'windows'
                     : os.includes('linux') ? 'linux'
                     : (os.includes('mac') || os.includes('osx') || os.includes('apple')) ? 'osx' : '';
    const platOk = (mp) => !targetPlat || !mp || mp === targetPlat
                        || (mp === 'unix' && targetPlat === 'linux');
    return candidates
        .map(m => {
            const hay = (m.fullname + ' ' + (m.description || '')).toLowerCase();
            // Relevance is driven by how many service keywords the module mentions.
            // Rank/type only break ties: a high-rank module that matches nothing on
            // this target isn't relevant (kwHits weighted x100 dominates the sort).
            const kwHits = kws.reduce((s, k) => s + (hay.includes(k) ? 1 : 0), 0);
            const okPlat = platOk(modulePlatform(m.fullname));
            // Wrong-OS modules (e.g. windows exploit vs a Linux target) sink to the
            // bottom and are never treated as relevant.
            const sort = (okPlat ? 0 : -100000)
                       + kwHits * 100 + (RANK[(m.rank || '').toLowerCase()] || 0) + (m.type === 'exploit' ? 1 : 0);
            return { m, relevant: kwHits > 0 && okPlat, sort };
        })
        .sort((a, b) => b.sort - a.sort)
        .map(x => Object.assign({ _relevant: x.relevant }, x.m));
}

// STAGE B (deterministic): gather REAL modules for the target from the AI's
// search terms plus keywords we derive from the recon, ranked by relevance.
async function gatherCandidates(host, searchTerms) {
    const derived = deriveModuleKeywords(host);
    const terms = [...new Set([
        ...(searchTerms || []).map(s => String(s).toLowerCase().trim()).filter(Boolean),
        ...derived,
    ])].slice(0, 14);
    if (!terms.length) return [];
    let list = [];
    try {
        const res = await fetch('/api/msf/modules/suggest', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ keywords: terms })
        });
        if (res.ok) { const d = await res.json(); if (Array.isArray(d)) list = d; }
    } catch { /* best-effort */ }
    return rankCandidatesByRelevance(list, host);
}

// STAGE C (focused AI call): given the recon + a NUMBERED list of real modules,
// ask the model to pick the best ones. Small models handle this narrow task well.
// Falls back to the top relevance-ranked modules if the model picks nothing.
async function selectModulesWithAI(reconCtx, ip, candidates) {
    if (!candidates.length) return [];
    // Bias toward recall: prefer service-relevant modules but keep a wide list so
    // the model doesn't miss anything. Relevant ones lead; the rest follow.
    const relevant = candidates.filter(c => c._relevant);
    const rest = candidates.filter(c => !c._relevant);
    const top = (relevant.length ? [...relevant, ...rest] : candidates).slice(0, 30);
    const list = top.map((m, i) =>
        `${i+1}. ${m.fullname} [${m.type}${m.rank ? '/'+m.rank : ''}] ${(m.description||'').slice(0,110)}`).join('\n');

    const SYS = `You are a Metasploit module selector. You are given recon data and a numbered list of REAL Metasploit modules that exist on this system. Choose every module that could plausibly work against this target — favor recall, it is better to include a borderline module than to miss a useful one.
Rules (follow exactly):
- Respond with ONLY a JSON object. No prose, no markdown.
- Only choose modules from the numbered list. Copy the module path EXACTLY as shown.
- Pick up to 6, best first. Include scanners, login/brute, and enumeration auxiliary modules too — not just exploits. If a module plausibly relates to ANY service on the target, include it.
- Return an empty picks array ONLY if truly nothing in the list relates to any detected service.`;
    const USR = `Target IP: ${ip}
Recon:
${reconCtx}

Numbered modules to choose from:
${list}

Respond in exactly this shape:
{"picks":[{"module":"<exact path from the list above>","confidence":"high|medium|low","rport":"<port number or empty>","rationale":"<one short sentence>"}]}`;

    const valid = new Set(top.map(m => m.fullname));
    const byName = Object.fromEntries(top.map(m => [m.fullname, m]));
    let picks = [];
    for (let attempt = 0; attempt < 2 && !picks.length; attempt++) {
        try {
            const parsed = JSON.parse(extractJsonBlock(await callOllama(SYS, USR)));
            const arr = Array.isArray(parsed) ? parsed : (parsed.picks || parsed.modules || []);
            picks = (arr || []).filter(p => p && typeof p.module === 'string' && valid.has(p.module));
        } catch { picks = []; }
    }

    let modules = picks.slice(0, 6).map((p, i) => {
        const c = byName[p.module] || {};
        return {
            module: p.module, type: c.type || p.module.split('/', 1)[0],
            priority: i+1, confidence: p.confidence || 'medium',
            rationale: p.rationale || c.description || '',
            options: { RHOSTS: ip, RPORT: p.rport || '', PAYLOAD: '' }
        };
    });

    // Deterministic safety net: never show "nothing" when relevant modules exist.
    // Bias to recall: surface the top service-relevant modules so nothing useful is missed.
    if (!modules.length) {
        const rel = top.filter(m => m._relevant);
        const pool = rel.length ? rel : top;
        modules = pool.slice(0, 5).map((m, i) => ({
            module: m.fullname, type: m.type, priority: i+1,
            confidence: i === 0 ? 'medium' : 'low',
            rationale: (m.description || 'Matches a detected service on this target.') + ' (auto-selected)',
            options: { RHOSTS: ip, RPORT: '', PAYLOAD: '' }
        }));
    }
    return modules;
}

function aiScrollToBottom() {
    const out = document.getElementById('ai-output');
    out.scrollTop = out.scrollHeight;
}

function aiHideEmpty() {
    const el = document.getElementById('ai-empty-state');
    if (el) el.style.display = 'none';
    document.getElementById('ai-clear-btn').classList.remove('hidden');
}

function aiAddMessage(role, htmlContent, label) {
    // role: 'assistant' | 'user' | 'system-inject'
    aiHideEmpty();
    const out = document.getElementById('ai-output');
    const wrap = document.createElement('div');
    const ts   = new Date().toLocaleTimeString([], {hour12:false, hour:'2-digit', minute:'2-digit'});

    if (role === 'user') {
        wrap.className = 'flex justify-end';
        wrap.innerHTML = `
            <div class="max-w-[85%] flex flex-col gap-1 items-end">
                <div class="text-[9px] text-gray-600 font-mono pr-1">${ts}</div>
                <div class="bg-violet-600/20 border border-violet-500/25 rounded-xl rounded-tr-sm px-3 py-2 text-xs text-gray-200 font-mono leading-relaxed whitespace-pre-wrap break-words">${htmlContent}</div>
            </div>`;
    } else if (role === 'system-inject') {
        wrap.className = 'flex justify-center';
        wrap.innerHTML = `
            <div class="flex items-center gap-2 text-[10px] text-gray-600 font-mono border border-[#1f222a] bg-[#0a0c10] rounded-full px-3 py-1">
                <svg class="w-3 h-3 text-cyan-500/60" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
                ${htmlContent}
            </div>`;
    } else {
        // assistant
        wrap.className = 'flex justify-start';
        wrap.innerHTML = `
            <div class="max-w-[100%] flex flex-col gap-1">
                <div class="text-[9px] text-violet-500/60 font-mono flex items-center gap-1.5">
                    <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
                    Kroft.AI${label ? ' · ' + label : ''} · ${ts}
                </div>
                <div class="bg-[#14171d] border border-[#1f222a] rounded-xl rounded-tl-sm px-4 py-3 text-xs text-gray-300 leading-relaxed space-y-3 ai-msg-body">${htmlContent}</div>
            </div>`;
    }
    out.appendChild(wrap);
    aiScrollToBottom();
    return wrap;
}

function aiAddThinkingIndicator() {
    const out = document.getElementById('ai-output');
    const wrap = document.createElement('div');
    wrap.id = 'ai-typing-indicator';
    wrap.className = 'flex justify-start';
    wrap.innerHTML = `
        <div class="flex flex-col gap-1">
            <div class="text-[9px] text-violet-500/60 font-mono flex items-center gap-1.5">
                <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
                Kroft.AI · thinking…
            </div>
            <div class="bg-[#14171d] border border-violet-500/20 rounded-xl rounded-tl-sm px-4 py-3 flex items-center gap-2">
                <span class="inline-block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style="animation-delay:0ms"></span>
                <span class="inline-block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style="animation-delay:150ms"></span>
                <span class="inline-block w-1.5 h-1.5 bg-violet-400 rounded-full animate-bounce" style="animation-delay:300ms"></span>
            </div>
        </div>`;
    out.appendChild(wrap);
    aiScrollToBottom();
}

function aiRemoveThinkingIndicator() {
    const el = document.getElementById('ai-typing-indicator');
    if (el) el.remove();
}

function aiLog(html) {
    // Legacy: append raw html as an assistant message chunk
    const out = document.getElementById('ai-output');
    out.innerHTML += html;
    aiScrollToBottom();
}

function aiSetOutput(html) {
    // Legacy: only used for simple status messages now
    document.getElementById('ai-output').innerHTML = html;
}

function clearAiConversation() {
    aiConversationHistory = [];
    aiSystemPrompt = null;
    aiHasAnalysis = false;
    const out = document.getElementById('ai-output');
    out.innerHTML = `<div id="ai-empty-state" class="flex flex-col items-center justify-center h-full gap-4 text-center">
        <svg class="w-12 h-12 text-violet-500/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
        <div class="text-gray-600 text-sm">Conversation cleared. Select a target and click <span class="text-violet-400">Analyze &amp; Plan</span> to start fresh.</div>
    </div>`;
    document.getElementById('ai-clear-btn').classList.add('hidden');
    document.getElementById('ai-exploit-list').innerHTML = '<div class="text-xs text-gray-600 italic px-1">Waiting for analysis…</div>';
    document.getElementById('ai-scan-card').style.display = 'none';
    document.getElementById('ai-module-config-card').style.display = 'none';
}

// Chat input handlers
function aiChatAutoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function aiChatKeydown(e) {
    // Enter without shift sends; shift+enter inserts newline
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAiChatMessage();
    }
}

async function sendAiChatMessage() {
    const input = document.getElementById('ai-chat-input');
    const text  = input.value.trim();
    if (!text || aiIsThinking) return;

    input.value = '';
    aiChatAutoResize(input);

    // If no analysis yet, we need context
    if (!aiHasAnalysis && !aiCurrentTarget) {
        aiAddMessage('assistant',
            `<div class="text-yellow-400">⚠ No target selected or analysis run yet. Pick a target above and click <span class="text-violet-300">Analyze &amp; Plan</span> first, or paste recon/exploit output here and I'll analyze it directly.</div>`);
        return;
    }

    // Show user message
    aiAddMessage('user', escHtml(text).replace(/\n/g, '<br>'));

    // Add to history
    aiConversationHistory.push({ role: 'user', content: text });

    await runAiFollowUp();
}

async function runAiFollowUp() {
    if (aiIsThinking) return;
    aiIsThinking = true;
    document.getElementById('ai-thinking-badge').classList.remove('hidden');
    const sendBtn = document.getElementById('ai-chat-send-btn');
    sendBtn.disabled = true;
    aiAddThinkingIndicator();

    const sysPrompt = aiSystemPrompt || `You are Kroft.AI, an expert offensive-security AI embedded in a penetration testing platform called KROFT Security Matrix.
You help operators analyze recon data, interpret exploit outputs, and plan next steps.
Use markdown formatting: **bold** for emphasis, ## headers to separate sections, bullet lists for findings, numbered lists for steps.
When you give Metasploit console commands to run a module, put the ENTIRE sequence — the \`use\` line, every \`set\` line, and the final \`run\` (or \`exploit\`) — together in ONE single \`\`\`msf fenced code block. Never split one module's commands across multiple code blocks or numbered steps; the operator runs the whole block with one click. Use a separate \`\`\`msf block only for a genuinely different module.
When recommending a post or auxiliary module, always write the full module path (e.g. post/multi/manage/shell_to_meterpreter) so the UI can auto-fill it.
If given raw exploit or shell output, extract and summarize the key security-relevant findings — be concise, focus on actionable results.
Before recommending another nmap scan, check whether that information is already in the recon data you were given — only suggest a scan that would yield genuinely new information, and prefer acting on what is already known.
IMPORTANT: Always provide a response. If output is very long or repetitive (e.g. a module scanning thousands of entries), summarize the key findings rather than listing everything. Never respond with just "(no response)" or leave the reply empty.`;

    // Build messages array
    const messages = [
        { role: 'system', content: sysPrompt },
        ...aiConversationHistory
    ];

    // Stream state: the assistant bubble is created lazily on the first token so
    // the "thinking…" indicator stays up until the model actually starts replying.
    let msgWrap = null, bodyEl = null, rafPending = false, latest = '', streamDone = false;
    const CARET = '<span class="inline-block w-1.5 h-3.5 ml-px -mb-0.5 bg-violet-400/70 rounded-sm animate-pulse"></span>';

    const renderStream = () => {
        rafPending = false;
        if (streamDone || !bodyEl) return;  // final render owns the DOM once done
        const stick = aiIsNearBottom();
        bodyEl.innerHTML = formatAiReply(latest) + CARET;
        if (stick) aiScrollToBottom();
    };
    const onDelta = (full) => {
        latest = full;
        if (!bodyEl) {
            aiRemoveThinkingIndicator();
            msgWrap = aiAddMessage('assistant', '');
            bodyEl  = msgWrap.querySelector('.ai-msg-body');
        }
        if (!rafPending) { rafPending = true; requestAnimationFrame(renderStream); }
    };

    try {
        const raw = await streamOllamaChat(
            messages,
            ollamaOptions({ temperature: 0.3, top_p: 0.9, repeat_penalty: 1.1 }),
            onDelta
        );
        let reply = (raw || '').trim();

        // If the model returned empty (context overflow, refusal, etc.), don't show a blank bubble
        if (!reply || reply === '(no response)') {
            // Pop the last user message so context doesn't grow stale
            aiConversationHistory.pop();
            if (msgWrap) msgWrap.remove();
            aiRemoveThinkingIndicator();
            aiAddMessage('assistant',
                `<div class="text-yellow-400/80 text-xs">⚠ The model returned an empty response — the output fed to it may have been too large for its context window. Try asking a focused follow-up question instead, e.g. <span class="text-violet-300">"What are the top 3 privesc vectors from that scan?"</span></div>`);
            return;
        }

        // Add to history
        aiConversationHistory.push({ role: 'assistant', content: reply });

        // Final render: drop the streaming caret and settle any partial markdown
        const formatted = formatAiReply(reply);
        if (bodyEl) {
            bodyEl.innerHTML = formatted;
            if (aiIsNearBottom()) aiScrollToBottom();
        } else {
            aiRemoveThinkingIndicator();
            aiAddMessage('assistant', formatted);
        }

        // Surface any modules the AI suggested into the panels (exploits + post/aux)
        kaiHarvestSuggestions(reply);
    } catch (err) {
        if (msgWrap) msgWrap.remove();
        aiRemoveThinkingIndicator();
        aiConversationHistory.pop(); // remove failed user message from history
        aiAddMessage('assistant',
            `<div class="text-red-400">⚠ Error: ${escHtml(err.message)}</div>`);
    } finally {
        streamDone = true;  // stop any pending rAF from re-rendering the caret
        aiIsThinking = false;
        document.getElementById('ai-thinking-badge').classList.add('hidden');
        sendBtn.disabled = false;
    }
}

