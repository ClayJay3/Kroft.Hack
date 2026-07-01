// MSF command block execution
let _msfCmdCounter = 0;

async function runMsfCommandBlock(btnEl, commands) {
    const blockId = btnEl.dataset.blockId;
    const outputEl = document.getElementById('msf-out-' + blockId);
    btnEl.disabled = true;
    btnEl.innerHTML = `<svg class="animate-spin w-3 h-3 inline mr-1" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Running…`;
    outputEl.textContent = '';
    outputEl.classList.remove('hidden');
    // Remove any previous truncation note
    const prevNote = document.getElementById('msf-trunc-' + blockId);
    if (prevNote) prevNote.remove();

    try {
        const res = await fetch('/api/msf/console_exec', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);

        const out = data.output || '(no output)';
        const truncated = data.truncated || false;
        const fullLen = data.full_length || out.length;
        outputEl.textContent = out;

        // Show truncation warning below the output box
        if (truncated) {
            const note = document.createElement('div');
            note.id = 'msf-trunc-' + blockId;
            note.className = 'px-3 py-1.5 text-[10px] text-yellow-500/70 font-mono bg-yellow-500/5 border-t border-yellow-500/15';
            note.textContent = `⚠ Large output (${fullLen.toLocaleString()} chars) — head + tail shown. AI received a summarized version.`;
            outputEl.parentElement.insertBefore(note, outputEl.nextSibling);
        }

        const label = (data.commands_sent || commands.filter(c => c.trim() && !c.trim().startsWith('#'))).join('; ').slice(0, 80);
        aiAddMessage('system-inject',
            `MSF console ran: <span class="text-cyan-400 font-mono">${escHtml(label)}</span>${truncated ? ' <span class="text-yellow-500/70 ml-1">(output summarized for AI)</span>' : ''}`);

        if (aiHasAnalysis || aiCurrentTarget) {
            // Cap AI feed at 10000 chars to avoid blowing context window
            const AI_MAX = 10000;
            let aiFeed = out;
            if (aiFeed.length > AI_MAX) {
                aiFeed = aiFeed.slice(0, 1500)
                    + `\n\n[...middle omitted — ${fullLen.toLocaleString()} chars total — showing head + tail only...]\n\n`
                    + aiFeed.slice(-1200);
            }
            const feedContent = `[MSF console output for: ${label}]\n\n${aiFeed}\n\nAnalyze this output concisely. What are the key findings and recommended next steps?`;
            aiConversationHistory.push({ role: 'user', content: feedContent });
            await runAiFollowUp();
        }
    } catch (e) {
        outputEl.textContent = 'Error: ' + e.message;
    } finally {
        btnEl.disabled = false;
        btnEl.innerHTML = `<svg class="w-3 h-3 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/></svg> Run again`;
    }
}

// Detect whether a fenced code block looks like MSF console commands
function isMsfCommandBlock(lang, code) {
    if (lang && ['msf','msfconsole','metasploit','console'].includes(lang.toLowerCase())) return true;
    // Heuristic: lines that are MSF console commands
    const lines = code.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    const msfPatterns = /^(use |set |run|exploit|sessions|back|search |info |check |jobs|load |unload |resource )/i;
    const matchCount = lines.filter(l => msfPatterns.test(l) || l === 'run' || l === 'exploit').length;
    return matchCount > 0 && matchCount >= Math.ceil(lines.length * 0.4);
}

function renderMsfCommandBlock(code) {
    const id = ++_msfCmdCounter;
    const commands = code.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const cmdHtml = commands.map(c =>
        `<div class="flex items-center gap-1.5"><span class="text-green-500 select-none">msf&gt;</span><span class="text-cyan-300">${escHtml(c)}</span></div>`
    ).join('');
    return `<div class="my-2 rounded-lg border border-cyan-500/20 bg-[#050608] overflow-hidden">
        <div class="flex items-center justify-between px-3 py-1.5 bg-cyan-500/5 border-b border-cyan-500/15">
            <span class="text-[9px] font-bold uppercase tracking-widest text-cyan-500/70 flex items-center gap-1.5">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                MSF Console · click to run
            </span>
            <button data-block-id="${id}"
                onclick="runMsfCommandBlock(this, ${escHtml(JSON.stringify(commands))})"
                class="text-[10px] font-bold text-cyan-300 bg-cyan-500/15 hover:bg-cyan-500/30 border border-cyan-500/25 rounded px-2.5 py-1 transition-all flex items-center gap-1">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/></svg>
                Run in MSF
            </button>
        </div>
        <div class="px-3 py-2.5 font-mono text-[11px] space-y-0.5">${cmdHtml}</div>
        <pre id="msf-out-${id}" class="hidden px-3 pb-2.5 text-[10px] font-mono text-green-300 whitespace-pre-wrap break-words border-t border-[#1f222a] pt-2 mt-0 leading-relaxed max-h-48 overflow-y-auto"></pre>
    </div>`;
}

function formatAiReply(text) {
    // Remove <think>...</think> blocks (Qwen3 chain-of-thought)
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Drop an unterminated <think> (mid-stream or truncated output) so the
    // chain-of-thought never flashes into the reply while tokens arrive.
    const _openThink = text.indexOf('<think>');
    if (_openThink !== -1) text = text.slice(0, _openThink).trim();

    const parts = [];
    // Split on fenced code blocks first
    const fenced = text.split(/(```[\s\S]*?```)/g);
    fenced.forEach(chunk => {
        if (chunk.startsWith('```')) {
            const firstNewline = chunk.indexOf('\n');
            const lang = firstNewline > 3 ? chunk.slice(3, firstNewline).trim() : '';
            const inner = chunk.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
            if (isMsfCommandBlock(lang, inner)) {
                parts.push(renderMsfCommandBlock(inner));
            } else {
                parts.push(`<div class="bg-[#050608] border border-[#1f222a] rounded-lg px-3 py-2 font-mono text-[11px] text-cyan-300 overflow-x-auto my-1 whitespace-pre">${escHtml(inner)}</div>`);
            }
        } else {
            // Process markdown in prose chunks line-by-line
            parts.push(renderMarkdownProse(chunk));
        }
    });
    return parts.join('');
}

function renderMarkdownProse(text) {
    // Process line by line for headers, lists, tables, bold, inline code
    const lines = text.split('\n');
    let html = '';
    let inUl = false, inOl = false;
    let tableLines = [];   // buffer for table rows

    const closeList = () => {
        if (inUl) { html += '</ul>'; inUl = false; }
        if (inOl) { html += '</ol>'; inOl = false; }
    };

    const flushTable = () => {
        if (!tableLines.length) return;
        // First line = header, second line = separator (---|---), rest = data rows
        const rows = tableLines.filter(l => !l.match(/^\s*\|?[\s\-:]+\|/));
        if (!rows.length) { tableLines = []; return; }

        const parseRow = (l) =>
            l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

        const [header, ...body] = rows;
        const heads = parseRow(header);
        const headHtml = heads.map(h =>
            `<th class="px-3 py-1.5 text-left text-[9px] font-bold uppercase tracking-wider text-gray-400 border-b border-[#1f222a] whitespace-nowrap">${renderInline(escHtml(h))}</th>`
        ).join('');

        const bodyHtml = body.map(row => {
            const cells = parseRow(row);
            const tdHtml = cells.map((c, i) =>
                `<td class="px-3 py-1.5 text-[11px] text-gray-300 border-b border-[#1f222a]/50 align-top${i === 0 ? ' font-mono text-orange-300' : ''}">${renderInline(escHtml(c))}</td>`
            ).join('');
            return `<tr class="hover:bg-white/[0.02]">${tdHtml}</tr>`;
        }).join('');

        html += `<div class="my-2 rounded-lg border border-[#1f222a] overflow-hidden overflow-x-auto">
            <table class="w-full text-left text-xs">
                <thead class="bg-[#0a0c10]"><tr>${headHtml}</tr></thead>
                <tbody>${bodyHtml}</tbody>
            </table>
        </div>`;
        tableLines = [];
    };

    const renderInline = (s) => {
        s = s.replace(/\*\*(.+?)\*\*/g, '<strong class="text-gray-100 font-semibold">$1</strong>');
        s = s.replace(/__(.+?)__/g, '<strong class="text-gray-100 font-semibold">$1</strong>');
        s = s.replace(/\*([^*\n]+?)\*/g, '<em class="text-gray-300">$1</em>');
        s = s.replace(/`([^`\n]+?)`/g, (_, c) => {
            const t = c.trim();
            // A module path becomes a clickable chip that re-autofills the panel.
            if (/^(exploit|auxiliary|post|payload|encoder|nop)\/[\w\/.-]+$/.test(t)) return moduleChip(t);
            return `<code class="bg-[#050608] border border-[#1f222a] rounded px-1 font-mono text-orange-300 text-[11px]">${escHtml(c)}</code>`;
        });
        return s;
    };

    lines.forEach(line => {
        // Table rows (lines containing |)
        if (line.trim().startsWith('|') || (line.includes('|') && line.trim().match(/^\|?[^|]+\|/))) {
            closeList();
            tableLines.push(line);
            return;
        } else {
            flushTable();
        }

        const h3 = line.match(/^### (.+)/);
        const h2 = line.match(/^## (.+)/);
        const h1 = line.match(/^# (.+)/);
        const ul = line.match(/^[\*\-] (.+)/);
        const ol = line.match(/^\d+\. (.+)/);

        if (h1) {
            closeList();
            html += `<div class="text-sm font-bold text-gray-100 mt-3 mb-1">${renderInline(escHtml(h1[1]))}</div>`;
        } else if (h2) {
            closeList();
            html += `<div class="text-xs font-bold uppercase tracking-wide mt-2.5 mb-1 text-violet-300/80">${renderInline(escHtml(h2[1]))}</div>`;
        } else if (h3) {
            closeList();
            html += `<div class="text-xs font-semibold text-gray-300 mt-2 mb-0.5">${renderInline(escHtml(h3[1]))}</div>`;
        } else if (ul) {
            if (inOl) { html += '</ol>'; inOl = false; }
            if (!inUl) { html += '<ul class="space-y-0.5 my-1 ml-2">'; inUl = true; }
            html += `<li class="flex gap-2 text-gray-400"><span class="text-violet-500 flex-shrink-0 mt-0.5">›</span><span>${renderInline(escHtml(ul[1]))}</span></li>`;
        } else if (ol) {
            if (inUl) { html += '</ul>'; inUl = false; }
            if (!inOl) { html += '<ol class="space-y-0.5 my-1 ml-2 list-none">'; inOl = true; }
            const num = line.match(/^(\d+)\./)[1];
            html += `<li class="flex gap-2 text-gray-400"><span class="text-gray-600 flex-shrink-0 w-5 text-right font-mono">${num}.</span><span>${renderInline(escHtml(ol[1]))}</span></li>`;
        } else if (line.trim() === '') {
            closeList();
            html += '<div class="h-1.5"></div>';
        } else {
            closeList();
            html += `<div class="text-gray-300 leading-relaxed">${renderInline(escHtml(line))}</div>`;
        }
    });

    flushTable();
    closeList();
    return html;
}

// A clickable module path: re-autofills the right-side panel for that module.
function moduleChip(path) {
    return `<button type="button" onclick="kaiAutofillModule('${path}')" title="Click to load this module into the panel" class="inline-flex items-center align-baseline gap-1 bg-[#050608] border border-violet-500/25 hover:border-violet-400/60 hover:bg-violet-500/10 rounded px-1.5 font-mono text-orange-300 text-[11px] transition-all cursor-pointer">${path}<svg class="w-2.5 h-2.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>`;
}

// Route a clicked/selected module to the correct panel and load it (AI-filling options).
async function kaiAutofillModule(path, planOpts) {
    if (!path) return;
    const mtype = path.startsWith('auxiliary/') ? 'auxiliary'
                : path.startsWith('post/') ? 'post' : 'exploit';
    if (mtype === 'exploit') {
        await kaiLoadExploitModule(path, planOpts);
    } else {
        setPostModuleType(mtype);
        aiRightTab('post');
        await postSelectModule(path, true);   // true = AI-fill options
    }
}

// Ask the model to fill option VALUES for a module against the current target,
// using the recon. Returns { OPTION: value }, validated against the schema.
async function kaiAiFillOptions(modulePath, mtype, schema) {
    const target = aiCurrentTarget || '';
    const entries = Object.entries(schema || {});
    if (!entries.length) return {};
    const host = allHosts.find(h => h.ip === target);
    const recon = host ? buildReconContext(host) : `Target IP: ${target}`;
    const ordered = entries.slice().sort((a, b) => (b[1].required ? 1 : 0) - (a[1].required ? 1 : 0)).slice(0, 40);
    const list = ordered.map(([k, v]) =>
        `${k}${v.required ? ' (required)' : ''}${(v.default != null && v.default !== '') ? ` [default ${v.default}]` : ''} - ${(v.description || '').slice(0, 70)}`
    ).join('\n');
    const SYS = `You configure Metasploit module options for ONE specific target. Respond with ONLY a JSON object mapping option names to string values.
- Always set RHOSTS (and RHOST if listed) to the target IP.
- Set RPORT to the correct port for this target's service when you can tell from the recon.
- Fill any option you can reasonably determine from the recon.
- Do NOT invent credentials, file paths, or values you are unsure about — omit those.
- Use ONLY option names from the provided list.`;
    const USR = `Target IP: ${target}
Recon:
${recon}

Module: ${modulePath} (${mtype})
Available options:
${list}

Return JSON, e.g. {"RHOSTS":"${target}","RPORT":"80"}`;
    try {
        const parsed = JSON.parse(extractJsonBlock(await callOllama(SYS, USR)));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const valid = new Set(entries.map(([k]) => k));
            const out = {};
            for (const [k, v] of Object.entries(parsed)) {
                if (valid.has(k) && v != null && String(v).trim() !== '') out[k] = String(v).trim();
            }
            return out;
        }
    } catch { /* fall through */ }
    return {};
}

// Render option input rows (shared by the exploit panel). stateVar is the global
// options object name used by the inline handlers. data-opt enables later updates.
function renderOptionInputs(keys, valuesObj, stateVar, schema) {
    return keys.map(k => {
        const meta = (schema && schema[k]) || {};
        const req = meta.required ? ' <span class="text-red-500">*</span>' : '';
        const ph  = k === 'PAYLOAD' ? '(auto-selected)' : (meta.description ? meta.description.slice(0, 50) : '');
        return `<div class="flex gap-2 items-center">
            <label class="text-gray-500 w-24 flex-shrink-0 font-mono text-[10px]">${escHtml(k)}${req}</label>
            <input type="text" data-opt="${escHtml(k)}" value="${escHtml(valuesObj[k] || '')}" placeholder="${escHtml(ph)}"
                   class="form-input-box flex-1 text-xs font-mono py-1.5"
                   onchange="${stateVar}['${k}']=this.value" oninput="${stateVar}['${k}']=this.value">
        </div>`;
    }).join('');
}

// Apply AI-chosen values to a rendered options container + its state object.
function kaiApplyOptionValues(containerId, stateObj, values) {
    Object.entries(values || {}).forEach(([k, v]) => {
        stateObj[k] = v;
        const sel = (window.CSS && CSS.escape) ? CSS.escape(k) : k.replace(/"/g, '\\"');
        const inp = document.querySelector(`#${containerId} input[data-opt="${sel}"]`);
        if (inp) inp.value = v;
    });
}

// Load an exploit module into the AI exploit config card: full schema + AI-filled values.
async function kaiLoadExploitModule(path, planOpts) {
    aiRightTab('exploits');
    aiCurrentModule = path;
    document.getElementById('ai-module-name').textContent = path;
    const optsEl = document.getElementById('ai-module-options');
    optsEl.innerHTML = '<div class="text-xs text-violet-400/70 animate-pulse">Loading & AI-filling options…</div>';
    document.getElementById('ai-module-config-card').style.display = '';

    let schema = {};
    try {
        const res = await fetch(`/api/msf/modules/info?module=${encodeURIComponent(path)}&type=exploit`);
        const info = await res.json();
        if (!info.error && info.options) schema = info.options;
    } catch { /* schema stays empty */ }

    // Base values from defaults + target + plan-provided options.
    const values = {};
    Object.entries(schema).forEach(([k, v]) => { if (v.default != null && v.default !== '') values[k] = String(v.default); });
    if ('RHOSTS' in schema) values.RHOSTS = aiCurrentTarget || values.RHOSTS || '';
    if ('RHOST'  in schema) values.RHOST  = aiCurrentTarget || values.RHOST  || '';
    Object.entries(planOpts || {}).forEach(([k, v]) => { if (v) values[k] = String(v); });

    // AI fills the rest from recon.
    Object.assign(values, await kaiAiFillOptions(path, 'exploit', schema));
    if ('RHOSTS' in schema) values.RHOSTS = aiCurrentTarget || values.RHOSTS || '';

    // Show required options, anything that got a value, and the key network fields.
    const show = new Set();
    Object.entries(schema).forEach(([k, v]) => { if (v.required) show.add(k); });
    Object.keys(values).forEach(k => { if (values[k] !== '') show.add(k); });
    ['RHOSTS', 'RHOST', 'RPORT', 'LHOST', 'LPORT'].forEach(k => { if (k in schema) show.add(k); });
    show.add('PAYLOAD');

    aiCurrentOptions = {};
    [...show].forEach(k => { aiCurrentOptions[k] = (k === 'PAYLOAD') ? (values.PAYLOAD || '') : (values[k] || ''); });
    optsEl.innerHTML = renderOptionInputs([...show], aiCurrentOptions, 'aiCurrentOptions', schema)
        || '<div class="text-xs text-gray-600 italic">No options.</div>';
}

// Inject job output into AI conversation
async function feedJobOutputToAI(jobId, label, outputText) {
    if (aiInjectedJobIds.has(jobId)) return;
    aiInjectedJobIds.add(jobId);

    if (!aiHasAnalysis && !aiCurrentTarget) return; // no context yet

    const content = `[Job output received: ${label}]\n\n${outputText}\n\nAnalyze this output. What did we learn? What are the next recommended steps?`;

    aiAddMessage('system-inject', `Job output injected: <span class="text-cyan-400 font-mono">${escHtml(label)}</span>`);
    aiConversationHistory.push({ role: 'user', content });
    await runAiFollowUp();
    // In the background, mine the output for credentials/keys/hashes into Findings.
    kaiExtractLoot(label, outputText, aiCurrentTarget);
}

async function callOllama(systemPrompt, userPrompt) {
    if (!kroftConfig.ollama_base) throw new Error('Ollama endpoint not configured — set it in Settings.');
    const body = {
        model: getActiveOllamaModel(),
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt }
        ],
        stream: false,
        options: ollamaOptions({
            temperature: 0.2,
            top_p: 0.9,
            repeat_penalty: 1.1
        })
    };
    const res = await fetch(kroftConfig.ollama_base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return (data.message && data.message.content) ? data.message.content : '';
}

// Streaming variant of the /api/chat call. Reads Ollama's newline-delimited
// JSON stream and invokes onDelta(fullText) as content accumulates so the UI
// can render the reply progressively. Returns the complete text.
async function streamOllamaChat(messages, options, onDelta) {
    if (!kroftConfig.ollama_base) throw new Error('Ollama endpoint not configured — set it in Settings.');
    const res = await fetch(kroftConfig.ollama_base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: getActiveOllamaModel(), messages, stream: true, options })
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full   = '';

    const consumeLine = (line) => {
        line = line.trim();
        if (!line) return;
        let obj;
        try { obj = JSON.parse(line); } catch { return; }
        if (obj.error) throw new Error(obj.error);
        const piece = (obj.message && obj.message.content) ? obj.message.content : '';
        if (piece) { full += piece; onDelta(full, piece); }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            consumeLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
        }
    }
    consumeLine(buffer);  // trailing line without a newline
    return full;
}

function aiIsNearBottom() {
    const out = document.getElementById('ai-output');
    return out.scrollHeight - out.scrollTop - out.clientHeight < 80;
}

function extractJsonBlock(text) {
    // Try to extract JSON from a markdown code block or raw JSON in the response
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return fenced[1].trim();
    // Try to extract raw { ... } or [ ... ] block
    const obj = text.match(/(\{[\s\S]*\})/);
    if (obj) return obj[1].trim();
    return text.trim();
}

async function runKroftAnalysis() {
    const ip = aiCurrentTarget ||
               document.getElementById('ai-target-select').value;
    if (!ip) {
        document.getElementById('ai-target-select').classList.add('border-red-500', 'ring-1', 'ring-red-500/30');
        setTimeout(() => document.getElementById('ai-target-select').classList.remove('border-red-500','ring-1','ring-red-500/30'), 2000);
        return;
    }
    aiCurrentTarget = ip;
    const host = allHosts.find(h => h.ip === ip);

    // If target is in matrix but no port data, remind user to scan first
    if (host && !host.ports) {
        aiHideEmpty();
        aiAddMessage('assistant',
            `<div class="text-yellow-400">⚠ No port data for <span class="text-violet-300">${escHtml(ip)}</span>. Run a scan first from the Advanced Scanner tab, then come back.</div>`);
        return;
    }

    // Reset conversation for new target
    aiConversationHistory = [];
    aiHasAnalysis = false;
    const out = document.getElementById('ai-output');
    out.innerHTML = `<div id="ai-empty-state" style="display:none"></div>`;

    // UI: start loading
    const btn = document.getElementById('ai-analyze-btn');
    btn.disabled = true; btn.classList.add('opacity-70','cursor-not-allowed');
    document.getElementById('ai-thinking-badge').classList.remove('hidden');
    document.getElementById('ai-clear-btn').classList.remove('hidden');
    document.getElementById('ai-scan-card').style.removeProperty('display');
    document.getElementById('ai-scan-card').style.display = 'none';
    document.getElementById('ai-module-config-card').style.display = 'none';
    document.getElementById('ai-exploit-list').innerHTML = '<div class="text-xs text-gray-600 italic px-1 animate-pulse">Querying Kroft.AI…</div>';

    aiAddThinkingIndicator();

    const reconCtx = host ? buildReconContext(host) : `Target IP: ${ip}\nNo nmap data available.`;

    // Stage A: analysis only. We don't ask the small model for module paths here
    // (it hallucinates them). It just describes the target and lists the search
    // terms it would use to find exploits, an easy task. Real modules are looked
    // up in code (stage B) and chosen in a focused follow-up call (stage C).
    const SYSTEM = `You are Kroft.AI, an expert offensive-security AI embedded in a penetration testing platform called KROFT Security Matrix.
Analyze nmap recon data and produce a precise, structured JSON attack plan.

RULES (follow them absolutely):
1. Respond ONLY with a single valid JSON object — no preamble, no explanation, no markdown outside the JSON block.
2. Never add text before or after the JSON.
3. Every string value must be on one line (no literal newlines inside JSON strings).
4. Base everything on the actual ports and services present in the recon data.
5. Do NOT output Metasploit module paths — instead, in "search_terms", give the keywords you would search Metasploit for (product/service names like "vsftpd", "samba", "webdav", "drupal"). One term per attackable service.
6. Treat the recon data above as the source of truth — it reflects everything already gathered and stored. Inspect what is ALREADY known (open ports, service versions, OS) before proposing any new scan.
7. Only fill "nmap_followup" when a new scan would reveal information that is NOT already present AND that materially advances the attack — e.g. the OS is still unknown, an attackable service has no version, or a targeted vuln NSE script (ftp-vuln*, smb-vuln*, http-enum, etc.) has not been run. Do NOT re-request OS detection if the OS is already identified, and do NOT re-scan ports/services already enumerated with versions.
8. If the recon data is already sufficient to proceed, set "nmap_followup" to an empty string "" and use "nmap_reason" to state briefly why no further scan is needed (e.g. "OS and all service versions already enumerated").
9. When you do recommend one, "nmap_followup" must be a single complete nmap command string starting with 'nmap'.
10. Keep reasoning concise but technically accurate.`;

    const USER = `Here is the nmap recon data for the target:

${reconCtx}

Produce a JSON object with exactly this structure:
{
  "target_ip": "<ip>",
  "threat_summary": "<2-3 sentence technical summary of the attack surface>",
  "key_findings": ["<finding 1>", "<finding 2>", ...],
  "attack_vector": "<most promising initial access vector>",
  "nmap_followup": "<full nmap command ONLY if it would gather info not already in the recon data above (e.g. nmap -sV -p 21 --script ftp-vuln* ${ip}); otherwise an empty string \"\">",
  "nmap_reason": "<if scanning: 1 sentence on what NEW info it targets; if empty: 1 sentence on why the existing recon data is already sufficient>",
  "search_terms": ["<metasploit search keyword per attackable service>"],
  "post_exploitation": ["<post-exploitation step 1>", "<post-exploitation step 2>"]
}`;

    // Store the system prompt for follow-up turns; replace it with a conversational version
    aiSystemPrompt = `You are Kroft.AI, an expert offensive-security AI embedded in a penetration testing platform called KROFT Security Matrix.
You are analyzing target ${ip}${host && host.os ? ' (' + host.os + ')' : ''}.
You have already performed an initial analysis. Continue the conversation, answering follow-up questions and analyzing any exploit/scan output the operator feeds you.
Use markdown formatting: **bold** for emphasis, ## headers to separate sections, bullet lists for findings, numbered lists for steps.
When you give Metasploit console commands to run a module, put the ENTIRE sequence — the \`use\` line, every \`set\` line, and the final \`run\` (or \`exploit\`) — together in ONE single \`\`\`msf fenced code block. Never split one module's commands across multiple code blocks or numbered steps; the operator runs the whole block with one click. Use a separate \`\`\`msf block only for a genuinely different module.
When recommending a post or auxiliary module, always write the full module path (e.g. post/multi/manage/shell_to_meterpreter) so the UI can auto-fill the Post panel.
Only recommend Metasploit modules you are confident exist with that EXACT path. The platform validates every module before running it: if a name is wrong it returns "could not be loaded" along with "Did you mean…" suggestions — when you see that, pick one of the suggested real module paths instead of repeating the invalid one.
If given shell or exploit output, extract the security-relevant findings and recommend next steps — be concise and focus on actionable items.
Before recommending another nmap scan, check whether that information is already in the recon data you were given — only suggest a scan that would yield genuinely new information, and prefer acting on what is already known.
IMPORTANT: Always provide a response. If output is very long or repetitive (e.g. scanning thousands of entries), summarize the key findings. Never respond with just "(no response)" or leave the reply empty.`;

    try {
        // Stage A: recon analysis
        const raw  = await callOllama(SYSTEM, USER);
        const json = extractJsonBlock(raw);
        let plan;
        try {
            plan = JSON.parse(json);
        } catch (parseErr) {
            const cleaned = json.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/,\s*([}\]])/g, '$1');
            plan = JSON.parse(cleaned);
        }

        // Stage B: look up REAL modules (search_terms + recon-derived keywords)
        const candidates = await gatherCandidates(host, plan.search_terms);
        // Stage C: focused selection from the real list (+ deterministic fallback)
        plan.modules = await selectModulesWithAI(reconCtx, ip, candidates);

        // Seed conversation history with a natural summary of the analysis
        const analysisSummary = `I analyzed ${ip} and found the following:\n\nThreat Summary: ${plan.threat_summary || ''}\n\nKey Findings:\n${(plan.key_findings||[]).map((f,i)=>`${i+1}. ${f}`).join('\n')}\n\nBest Attack Vector: ${plan.attack_vector || ''}\n\nTop recommended module: ${(plan.modules||[])[0]?.module || 'none'}\n\nPost-exploitation: ${(plan.post_exploitation||[]).join('; ')}`;
        aiConversationHistory.push({ role: 'user', content: `Analyze this target: ${reconCtx}` });
        aiConversationHistory.push({ role: 'assistant', content: analysisSummary });
        aiHasAnalysis = true;

        aiRemoveThinkingIndicator();
        renderAiPlan(plan, ip);
    } catch (err) {
        aiRemoveThinkingIndicator();
        aiAddMessage('assistant',
            `<div class="text-red-400">
                <div class="font-bold mb-2">⚠ Kroft.AI Error</div>
                <div class="text-gray-400">${escHtml(err.message)}</div>
                <div class="text-gray-600 text-[10px] mt-2">Check that the Ollama endpoint <span class="text-violet-400">${escHtml(kroftConfig.ollama_base || '(not set — configure in Settings)')}</span> is reachable and the model <span class="text-violet-400">${escHtml(getActiveOllamaModel() || '(not set)')}</span> is loaded.</div>
            </div>`);
        document.getElementById('ai-exploit-list').innerHTML = '<div class="text-xs text-red-500/60 italic px-1">Analysis failed.</div>';
    } finally {
        btn.disabled = false; btn.classList.remove('opacity-70','cursor-not-allowed');
        document.getElementById('ai-thinking-badge').classList.add('hidden');
    }
}

function renderAiPlan(plan, ip) {
    // Analysis output as chat bubble
    const findings = (plan.key_findings || []).map(f =>
        `<li class="flex gap-2"><span class="text-violet-500 flex-shrink-0">›</span><span>${escHtml(f)}</span></li>`
    ).join('');
    const postEx = (plan.post_exploitation || []).map((s, i) =>
        `<li class="flex gap-2"><span class="text-gray-600 flex-shrink-0">${i+1}.</span><span>${escHtml(s)}</span></li>`
    ).join('');

    const analysisHtml = `
        <div class="space-y-4">
            <div class="border border-violet-500/20 bg-violet-500/5 rounded-lg p-3">
                <div class="text-[10px] font-bold text-violet-400 uppercase tracking-widest mb-1">Threat Summary</div>
                <div class="text-gray-300 text-xs leading-relaxed">${escHtml(plan.threat_summary || '')}</div>
            </div>
            <div>
                <div class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Key Findings</div>
                <ul class="space-y-1 text-xs text-gray-400">${findings}</ul>
            </div>
            <div class="border border-red-500/15 bg-red-500/5 rounded-lg p-3">
                <div class="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-1">Best Attack Vector</div>
                <div class="text-gray-300 text-xs">${escHtml(plan.attack_vector || '')}</div>
            </div>
            ${postEx ? `<div>
                <div class="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-2">Post-Exploitation Roadmap</div>
                <ul class="space-y-1 text-xs text-gray-400">${postEx}</ul>
            </div>` : ''}
            <div class="text-[10px] text-gray-600 border-t border-[#1f222a] pt-2 mt-1">Ask a follow-up question below or paste exploit/shell output for analysis.</div>
        </div>`;

    aiAddMessage('assistant', analysisHtml, 'Initial Analysis');

    // Followup scan
    // The model only proposes a scan when it would add info the DB doesn't already
    // have. A blank / non-command value means "existing recon is sufficient".
    const followup = (plan.nmap_followup || '').trim();
    const scanCard = document.getElementById('ai-scan-card');
    if (/^nmap\s+/i.test(followup)) {
        aiCurrentScanCmd = followup;
        document.getElementById('ai-scan-cmd').textContent = followup;
        scanCard.style.display = '';
        if (plan.nmap_reason) {
            const reasonEl = document.createElement('div');
            reasonEl.className = 'px-4 pb-2 text-[10px] text-gray-500 italic';
            reasonEl.textContent = plan.nmap_reason;
            const existing = scanCard.querySelector('.ai-scan-reason');
            if (existing) existing.remove();
            reasonEl.classList.add('ai-scan-reason');
            scanCard.appendChild(reasonEl);
        }
    } else {
        // No new scan needed; keep the existing data and just tell the operator why.
        aiCurrentScanCmd = null;
        scanCard.style.display = 'none';
        aiAddMessage('system-inject',
            `No follow-up scan needed${plan.nmap_reason ? ' — ' + escHtml(plan.nmap_reason) : ' — existing recon data is sufficient'}`);
    }

    // Exploit module list
    const modules = plan.modules || [];
    window._aiPlanModules = modules;
    renderExploitList();
    if (modules.length) selectAiModule(0);
}

// Render the proposed-module list from window._aiPlanModules. newIdx (a Set) marks
// freshly-suggested entries with a NEW badge + highlight.
function renderExploitList(newIdx) {
    const modules = window._aiPlanModules || [];
    const el = document.getElementById('ai-exploit-list');
    if (!modules.length) {
        el.innerHTML = '<div class="text-xs text-gray-600 italic px-1 leading-relaxed">No Metasploit modules matched the detected services. Try the recommended follow-up scan for deeper version detection, then re-analyze.</div>';
        return;
    }
    el.innerHTML = modules.map((m, idx) => {
        const conf = m.confidence || 'medium';
        const confColor = conf === 'high' ? 'text-green-400 bg-green-500/10 border-green-500/25'
            : conf === 'medium' ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/25'
            : 'text-red-400 bg-red-500/10 border-red-500/25';
        const pri = m.priority || idx+1;
        const isNew = newIdx && newIdx.has(idx);
        const typeBadge = (m.type && m.type !== 'exploit')
            ? `<span class="text-[9px] text-cyan-400/80 font-mono uppercase">${escHtml(m.type)}</span>` : '';
        const newBadge = isNew
            ? '<span class="text-[9px] font-bold text-violet-300 bg-violet-500/15 border border-violet-500/30 rounded px-1.5">NEW</span>' : '';
        return `<div class="border ${isNew ? 'border-violet-500/40 bg-violet-500/5' : 'border-[#1f222a]'} hover:border-violet-500/30 rounded-lg p-3 cursor-pointer transition-all group" onclick="selectAiModule(${idx})" data-idx="${idx}">
            <div class="flex items-center gap-2 mb-1.5">
                <span class="text-[10px] font-bold text-gray-600 bg-[#1f222a] rounded px-1.5 py-0.5">#${pri}</span>
                <span class="badge-exploit ${confColor} border">${conf}</span>
                ${typeBadge}${newBadge}
                <span class="ml-auto text-gray-700 group-hover:text-violet-400 transition-colors text-[10px]">→ Autofill</span>
            </div>
            <div class="font-mono text-[11px] text-orange-300 truncate mb-1">${escHtml(m.module || '–')}</div>
            <div class="text-[10px] text-gray-500 leading-snug line-clamp-2">${escHtml(m.rationale || '')}</div>
        </div>`;
    }).join('');
}

// As the conversation continues, surface any modules the AI mentions into the
// panels automatically: new exploits join the proposals list, and the first
// aux/post module loads into the Post/Aux panel.
async function kaiHarvestSuggestions(replyText) {
    const found = (replyText.match(/\b(exploit|auxiliary|post)\/[\w\/.\-]+/g) || [])
        .map(s => s.replace(/[).,;:]+$/, ''));
    if (!found.length) return;
    const uniq = [...new Set(found)];
    const existing = new Set((window._aiPlanModules || []).map(m => m.module));

    const newExploits = uniq.filter(p => p.startsWith('exploit/') && !existing.has(p));
    const auxPost = uniq.find(p => p.startsWith('auxiliary/') || p.startsWith('post/'));

    if (newExploits.length) {
        const base = window._aiPlanModules || [];
        const added = newExploits.map(p => ({
            module: p, type: 'exploit', confidence: 'medium',
            rationale: 'Suggested from the latest analysis.',
            options: { RHOSTS: aiCurrentTarget || '', RPORT: '', PAYLOAD: '' }
        }));
        window._aiPlanModules = [...base, ...added];
        renderExploitList(new Set(added.map((_, i) => base.length + i)));
        aiRightTab('exploits');
        selectAiModule(base.length);          // loads + AI-fills the first new exploit
        aiAddMessage('system-inject',
            `New module${added.length > 1 ? 's' : ''} suggested: ${added.map(a => moduleChip(a.module)).join(' ')} — added to Exploit Modules`);
    }
    if (auxPost) {
        const mtype = auxPost.startsWith('auxiliary/') ? 'auxiliary' : 'post';
        if (!newExploits.length) {
            await kaiAutofillModule(auxPost);  // visible: switch tab + AI-fill
            aiAddMessage('system-inject',
                `Post/Aux panel auto-filled: ${moduleChip(auxPost)} — review options and click <span class="text-green-300">Run Module</span>`);
        } else {
            setPostModuleType(mtype);          // preload quietly behind the exploit tab
            postSelectModule(auxPost, false);
        }
    }
}

function selectAiModule(idx) {
    const modules = window._aiPlanModules || [];
    const m = modules[idx];
    if (!m) return;

    // Highlight selected card
    document.querySelectorAll('#ai-exploit-list [data-idx]').forEach(el => {
        el.classList.toggle('border-violet-500/40', el.dataset.idx === String(idx));
        el.classList.toggle('bg-violet-500/5', el.dataset.idx === String(idx));
    });

    // Load the module into the right panel with full schema + AI-filled options.
    kaiAutofillModule(m.module, m.options);
}

async function launchAiExploit() {
    if (!aiCurrentModule) return;
    const ip = aiCurrentTarget;
    if (!ip) { alert('No target selected.'); return; }
    const opts = { ...aiCurrentOptions };
    if (opts.PAYLOAD) { opts._payload = opts.PAYLOAD; delete opts.PAYLOAD; }

    const btn = document.getElementById('ai-launch-btn');
    btn.disabled = true; btn.textContent = 'Launching…';
    try {
        // Pre-validate the module so a hallucinated name surfaces real
        // alternatives instead of dispatching a job that can only fail.
        const mtype = aiCurrentModule.startsWith('auxiliary/') ? 'auxiliary'
                    : aiCurrentModule.startsWith('post/') ? 'post' : 'exploit';
        try {
            const vres = await fetch(`/api/msf/modules/validate?module=${encodeURIComponent(aiCurrentModule)}&type=${mtype}`);
            const vdata = await vres.json();
            if (vres.ok && vdata.valid === false) {
                const sugg = (vdata.suggestions || []).map(s => s.fullname);
                aiAddMessage('system-inject',
                    `⚠ <span class="text-orange-400 font-mono">${escHtml(aiCurrentModule)}</span> is not a valid module (${escHtml(vdata.detail||'not found')}).` +
                    (sugg.length ? ` Real alternatives: <span class="text-green-400 font-mono">${sugg.slice(0,4).map(escHtml).join(', ')}</span>` : ''));
                if (sugg.length) {
                    aiConversationHistory.push({ role: 'user', content: `The module ${aiCurrentModule} does not exist. Valid alternatives for this service are: ${sugg.join(', ')}. Pick the best one and tell me which to run.` });
                }
                return;
            }
        } catch { /* validation is best-effort; fall through to dispatch */ }

        const res = await fetch('/api/msf/exploit', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ target_ip: ip, module: aiCurrentModule, options: opts })
        });
        const data = await res.json();
        if (!res.ok) { alert('Launch error: ' + (data.error || res.statusText)); return; }
        const jobId = data.job_id;
        aiAddMessage('system-inject',
            `Exploit dispatched: ${moduleChip(aiCurrentModule)} → job <span class="text-gray-400 font-mono">${escHtml(jobId)}</span>`);
        // Seed context about this attempt
        aiConversationHistory.push({ role: 'user', content: `I just launched ${aiCurrentModule} against ${ip} (job ${jobId}). I'll paste the output once it completes.` });
        aiConversationHistory.push({ role: 'assistant', content: `Got it. Once the job completes, paste the console output here and I'll analyze the results and suggest next steps.` });
        fetchJobs();
        // Start polling for this job's completion
        monitorJobForAI(jobId, aiCurrentModule);
    } catch(e) { alert('Failed: ' + e.message); }
    finally { btn.disabled = false; btn.innerHTML = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Launch'; }
}

async function launchAiScan() {
    if (!aiCurrentScanCmd) return;
    // Parse nmap <args> <target> from the AI-generated command
    const parts = aiCurrentScanCmd.replace(/^nmap\s+/,'').trim();
    // Last token is the target
    const tokens = parts.split(/\s+/);
    const target  = aiCurrentTarget || tokens[tokens.length - 1];
    const args    = tokens.slice(0, -1).join(' ');
    const btn = document.getElementById('ai-scan-launch-btn');
    btn.disabled = true;
    try {
        const res = await fetch('/api/scan', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ target, custom_args: args })
        });
        if (!res.ok) { alert('Scan error'); return; }
        const data = await res.json();
        const jobId = data.job_id || data.id || target;
        aiAddMessage('system-inject',
            `Follow-up scan dispatched: <span class="text-cyan-400 font-mono">${escHtml(aiCurrentScanCmd)}</span>`);
        // Seed awareness into conversation
        aiConversationHistory.push({ role: 'user', content: `I ran the follow-up scan: ${aiCurrentScanCmd}. I'll share the results when it completes.` });
        aiConversationHistory.push({ role: 'assistant', content: `Good. Paste the nmap output here when it's done and I'll analyze the new findings.` });
        fetchJobs();
        monitorJobForAI(jobId, 'nmap: ' + aiCurrentScanCmd);
    } catch(e) { alert('Failed: ' + e.message); }
    finally { btn.disabled = false; }
}

// Job completion monitoring for AI
const _jobMonitors = {};
function monitorJobForAI(jobId, label) {
    if (_jobMonitors[jobId]) return;
    _jobMonitors[jobId] = setInterval(async () => {
        try {
            const [nmapRes, msfRes] = await Promise.all([fetch('/api/jobs'), fetch('/api/msf/jobs')]);
            const nmapJobs = await nmapRes.json().catch(() => []);
            const msfJobs  = await msfRes.json().catch(() => []);
            const all = [...nmapJobs, ...msfJobs];
            const job = all.find(j => j.id === jobId || j.job_id === jobId);
            if (!job) return;
            const done = ['Completed', 'completed', 'succeeded', 'Failed', 'failed', 'timed_out', 'TIMED_OUT'].includes(job.status);
            if (!done) return;

            clearInterval(_jobMonitors[jobId]);
            delete _jobMonitors[jobId];

            // Try to fetch output
            let output = '';
            try {
                const outRes = await fetch(`/api/jobs/${jobId}/output`);
                if (outRes.ok) output = await outRes.text();
            } catch {}
            if (!output) {
                try {
                    const outRes = await fetch(`/api/msf/jobs/${jobId}/output`);
                    if (outRes.ok) output = await outRes.text();
                } catch {}
            }

            const status = job.status;
            const statusColor = ['Completed','completed','succeeded'].includes(status) ? 'text-green-400' : 'text-red-400';

            if (output && output.trim().length > 20) {
                await feedJobOutputToAI(jobId, label + ' [' + status + ']', output);
            } else {
                // No output available, just notify and offer to paste
                aiAddMessage('system-inject',
                    `Job <span class="font-mono text-gray-400">${escHtml(label)}</span> finished: <span class="${statusColor}">${escHtml(status)}</span> — paste output below for AI analysis`);
            }
        } catch { /* silent */ }
    }, 4000);
    // Stop after 5 min regardless
    setTimeout(() => { clearInterval(_jobMonitors[jobId]); delete _jobMonitors[jobId]; }, 300000);
}

function sendToConsole() {
    if (!aiCurrentModule) return;
    switchTab('pentest');
    setTimeout(() => {
        if (aiCurrentTarget) {
            document.getElementById('pt-target-manual').value = aiCurrentTarget;
            ptTargetChanged();
        }
        document.getElementById('module-search-input').value = aiCurrentModule.split('/').pop();
        searchModules();
    }, 150);
}

