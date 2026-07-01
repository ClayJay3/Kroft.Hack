// Post/Auxiliary Module Panel
let postCurrentModule  = null;
let postCurrentType    = 'post';
let postCurrentOptions = {};
let postCurrentJobId   = null;
let _postSearchTimer   = null;

function aiRightTab(tab) {
    const panels = ['exploits', 'post'];
    const tabBtns = { exploits: 'rtab-exploits', post: 'rtab-post' };
    panels.forEach(t => {
        const panel = document.getElementById('ai-panel-' + t);
        const btn   = document.getElementById(tabBtns[t]);
        if (t === tab) {
            panel.classList.remove('hidden'); panel.classList.add('flex');
            if (t === 'exploits') {
                btn.className = 'flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg border transition-all bg-red-500/10 border-red-500/25 text-red-300';
            } else {
                btn.className = 'flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg border transition-all bg-green-500/10 border-green-500/25 text-green-300';
            }
        } else {
            panel.classList.add('hidden'); panel.classList.remove('flex');
            btn.className = 'flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg border transition-all bg-[#0f1116] border-[#1f222a] text-gray-500 hover:text-gray-300 hover:border-[#2a2f3a]';
        }
    });
    if (tab === 'post') refreshPostSessions();
}

function setPostModuleType(t) {
    postCurrentType = t;
    ['post','auxiliary'].forEach(type => {
        const btn = document.getElementById('post-type-' + type);
        if (type === t) {
            btn.className = 'text-[9px] font-bold uppercase px-2 py-1 rounded border transition-all bg-green-500/10 border-green-500/25 text-green-300';
        } else {
            btn.className = 'text-[9px] font-bold uppercase px-2 py-1 rounded border transition-all bg-[#050608] border-[#1f222a] text-gray-600 hover:text-gray-300';
        }
    });
    // Clear search
    document.getElementById('post-module-search').value = '';
    document.getElementById('post-search-results').classList.add('hidden');
}

function postModuleSearch(q, immediate) {
    clearTimeout(_postSearchTimer);
    if (!q || q.trim().length < 2) {
        document.getElementById('post-search-results').classList.add('hidden');
        return;
    }
    const delay = immediate ? 0 : 500;
    _postSearchTimer = setTimeout(async () => {
        try {
            const res = await fetch(`/api/msf/modules/search?q=${encodeURIComponent(q)}&type=${postCurrentType}`);
            const results = await res.json();
            const box = document.getElementById('post-search-results');
            if (!Array.isArray(results) || !results.length) {
                box.innerHTML = '<div class="text-xs text-gray-600 italic p-1">No results.</div>';
                box.classList.remove('hidden'); return;
            }
            box.innerHTML = results.slice(0, 20).map(m => {
                const name = m.fullname || m.name || '';
                return `<button onclick="postSelectModule('${escHtml(name)}')"
                    class="w-full text-left px-2 py-1.5 rounded hover:bg-green-500/10 hover:text-green-200 transition-all group">
                    <div class="font-mono text-[10px] text-orange-300 truncate">${escHtml(name)}</div>
                    <div class="text-[9px] text-gray-600 group-hover:text-gray-500 truncate">${escHtml(m.description || '')}</div>
                </button>`;
            }).join('');
            box.classList.remove('hidden');
        } catch { /* silent */ }
    }, delay);
}

function postQuickPick(modulePath) {
    // Detect type from path prefix
    postCurrentType = modulePath.startsWith('auxiliary') ? 'auxiliary' : 'post';
    setPostModuleType(postCurrentType);
    postSelectModule(modulePath);
}

async function postSelectModule(modulePath, aiFill) {
    postCurrentModule = modulePath;
    document.getElementById('post-search-results').classList.add('hidden');
    document.getElementById('post-module-name').textContent = modulePath;
    document.getElementById('post-reload-btn').classList.remove('hidden');
    document.getElementById('post-module-options').innerHTML =
        `<div class="text-xs ${aiFill ? 'text-violet-400/70' : 'text-gray-600'} animate-pulse">${aiFill ? 'Loading & AI-filling options…' : 'Loading options…'}</div>`;
    document.getElementById('post-output-wrap').classList.add('hidden');
    document.getElementById('post-feed-ai-btn').classList.add('hidden');
    await postLoadModuleInfo(aiFill);
}

async function postLoadModuleInfo(aiFill) {
    if (!postCurrentModule) return;
    try {
        const res = await fetch(`/api/msf/modules/info?module=${encodeURIComponent(postCurrentModule)}&type=${postCurrentType}`);
        const info = await res.json();
        if (info.error) throw new Error(info.error);

        const schema = info.options || {};
        postCurrentOptions = {};
        // Pre-fill defaults; default RHOSTS to the AI target if present.
        Object.entries(schema).forEach(([k, v]) => {
            postCurrentOptions[k] = v.default || '';
        });
        if ('RHOSTS' in schema && aiCurrentTarget) postCurrentOptions.RHOSTS = aiCurrentTarget;

        const html = Object.entries(schema).map(([k, v]) => {
            const req = v.required ? '<span class="text-red-500">*</span>' : '';
            const placeholder = v.description ? v.description.slice(0, 50) : '';
            return `<div class="flex gap-2 items-start">
                <label class="text-gray-500 w-20 flex-shrink-0 font-mono text-[10px] pt-2.5">${escHtml(k)} ${req}</label>
                <input type="text" data-opt="${escHtml(k)}" value="${escHtml(postCurrentOptions[k] || '')}" placeholder="${escHtml(placeholder)}"
                    class="form-input-box flex-1 text-xs font-mono py-1.5"
                    onchange="postCurrentOptions['${k}']=this.value"
                    oninput="postCurrentOptions['${k}']=this.value">
            </div>`;
        }).join('') || '<div class="text-xs text-gray-600 italic">No configurable options.</div>';

        document.getElementById('post-module-options').innerHTML = html;

        // Auto-fill SESSION if there's only one active session
        refreshPostSessions(true);

        // Have the AI fill the rest of the option values from recon.
        if (aiFill) {
            const vals = await kaiAiFillOptions(postCurrentModule, postCurrentType, schema);
            kaiApplyOptionValues('post-module-options', postCurrentOptions, vals);
        }
    } catch (e) {
        document.getElementById('post-module-options').innerHTML =
            `<div class="text-xs text-red-400">Failed to load options: ${escHtml(e.message)}</div>`;
    }
}

function refreshPostSessions(autoFill) {
    const sel = document.getElementById('post-session-select');
    fetch('/api/msf/sessions').then(r => r.json()).then(sessions => {
        const cur = sel.value;
        sel.innerHTML = '<option value="">choose active session</option>';
        sessions.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `Session ${s.id} - ${s.type} - ${s.target}`;
            sel.appendChild(opt);
        });
        if (cur) sel.value = cur;
        // Auto-fill if only one session and SESSION option exists
        if (autoFill && sessions.length === 1 && postCurrentOptions.hasOwnProperty('SESSION')) {
            sel.value = sessions[0].id;
            postCurrentOptions['SESSION'] = sessions[0].id;
            // Also update the SESSION input if visible
            const inputs = document.querySelectorAll('#post-module-options input');
            inputs.forEach(inp => {
                const label = inp.closest('div')?.querySelector('label');
                if (label && label.textContent.trim().startsWith('SESSION')) {
                    inp.value = sessions[0].id;
                }
            });
        }
    }).catch(() => {});
}

async function runPostModule() {
    if (!postCurrentModule) {
        aiRightTab('post');
        document.getElementById('post-module-search').focus();
        return;
    }

    // Merge SESSION from selector
    const sessionSel = document.getElementById('post-session-select').value;
    if (sessionSel) postCurrentOptions['SESSION'] = sessionSel;

    // For post modules, SESSION is required
    if (postCurrentType === 'post' && !postCurrentOptions['SESSION']) {
        document.getElementById('post-session-select').classList.add('border-red-500','ring-1','ring-red-500/30');
        setTimeout(() => document.getElementById('post-session-select').classList.remove('border-red-500','ring-1','ring-red-500/30'), 2000);
        return;
    }

    const btn = document.getElementById('post-run-btn');
    btn.disabled = true;
    btn.innerHTML = `<svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Running…`;

    const outputWrap = document.getElementById('post-output-wrap');
    const outputLog  = document.getElementById('post-output-log');
    outputLog.textContent = 'Dispatching…';
    outputWrap.classList.remove('hidden');
    document.getElementById('post-feed-ai-btn').classList.add('hidden');

    try {
        const res = await fetch('/api/msf/post', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({
                module: postCurrentModule,
                options: { ...postCurrentOptions },
                type: postCurrentType
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);

        postCurrentJobId = data.job_id;
        outputLog.textContent = `Job ${data.job_id} dispatched. Polling for output…`;

        // Also inject into AI conversation
        aiAddMessage('system-inject',
            `Post/Aux module dispatched: <span class="text-green-400 font-mono">${escHtml(postCurrentModule)}</span> → job <span class="text-gray-400 font-mono">${data.job_id.slice(0,8)}…</span>`);

        // Poll for result
        await pollPostJobOutput(data.job_id, outputLog);
    } catch (e) {
        outputLog.textContent = 'Error: ' + e.message;
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Run Module`;
    }
}

async function pollPostJobOutput(jobId, outputEl) {
    const deadline = Date.now() + 120000; // 2 min max
    // Snapshot sessions before the module runs so we can detect new ones
    let sessionsBefore = new Set();
    try {
        const r = await fetch('/api/msf/sessions');
        const s = await r.json();
        sessionsBefore = new Set(s.map(x => x.id));
    } catch {}

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const res  = await fetch(`/api/msf/jobs/${jobId}/output`);
            const data = await res.json();
            if (data.output) outputEl.textContent = data.output;
            const done = ['succeeded','completed','failed','timed_out'].includes(data.status);
            if (done) {
                document.getElementById('post-feed-ai-btn').classList.remove('hidden');
                // Refresh sessions and check for newly opened ones
                const r2 = await fetch('/api/msf/sessions').catch(() => null);
                if (r2 && r2.ok) {
                    const sessionsAfter = await r2.json();
                    // Update the session list UI with fresh data
                    await fetchSessions();
                    const newSessions = sessionsAfter.filter(s => !sessionsBefore.has(s.id));
                    if (newSessions.length) {
                        const ns = newSessions[0];
                        activateSession(ns.id);
                        if (ns.type === 'meterpreter') {
                            aiAddMessage('system-inject',
                                `New <span class="text-purple-400 font-bold">Meterpreter</span> session opened: Session <span class="font-mono text-gray-300">${ns.id}</span> on <span class="font-mono text-blue-400">${ns.target}</span>`);
                        }
                    }
                }
                return data.output || '';
            }
        } catch { /* keep polling */ }
    }
    outputEl.textContent += '\n[Timeout, check job queue]';
    return outputEl.textContent;
}

function postFeedToAI() {
    const output = document.getElementById('post-output-log').textContent;
    if (!output || output.includes('Dispatching') || output.includes('Polling')) return;
    feedJobOutputToAI(
        postCurrentJobId || 'manual',
        postCurrentModule,
        output
    );
}

async function feedJobFromQueue(jobId, label, kind) {
    if (!jobId) return;
    // Switch to AI tab
    switchTab('kroftai');
    let output = '';
    try {
        // Only MSF jobs have an /output endpoint; nmap jobs don't expose raw output via API
        if (kind === 'msf') {
            const endpoint = `/api/msf/jobs/${jobId}/output`;
            const res = await fetch(endpoint);
            if (res.ok) {
                const data = await res.json();
                output = typeof data === 'string' ? data : (data.output || data.result || '');
            }
        }
    } catch {}
    if (!output || output.trim().length < 10) {
        const inp = document.getElementById('ai-chat-input');
        inp.placeholder = `Paste the output from job "${label}" here and press Enter…`;
        inp.focus();
        aiAddMessage('system-inject',
            `Ready for output from <span class="font-mono text-gray-400">${escHtml(label)}</span> — paste it in the input below`);
        return;
    }
    await feedJobOutputToAI(jobId, label + ' [' + kind + ']', output);
}

// Job detail modal (click a job in the sidebar)
let _jobDetailCurrent = null;

function jobStatusStyle(status) {
    const s = (status || '').toLowerCase();
    if (['running', 'queued', 'launched'].includes(s)) return 'text-blue-400 border-blue-500/30 bg-blue-500/10';
    if (['completed', 'succeeded'].includes(s)) return 'text-green-400 border-green-500/30 bg-green-500/10';
    if (s === 'timed_out') return 'text-yellow-400 border-yellow-500/30 bg-yellow-500/10';
    return 'text-red-400 border-red-500/30 bg-red-500/10';
}

function jobConfigRows(obj) {
    const entries = Object.entries(obj || {}).filter(([k, v]) => v !== '' && v != null);
    if (!entries.length) return '<div class="text-gray-600 italic text-[11px]">No configuration recorded.</div>';
    return '<div class="bg-[#050608] border border-[#1f222a] rounded-lg divide-y divide-[#14171d]">' +
        entries.map(([k, v]) =>
            `<div class="grid grid-cols-[10rem_1fr] gap-3 px-3 py-1.5"><span class="text-gray-500 break-words min-w-0">${escHtml(k)}</span><span class="text-gray-200 break-all min-w-0">${escHtml(String(v))}</span></div>`
        ).join('') + '</div>';
}

async function openJobDetail(jid, kind) {
    const job = (window._jobsById || {})[jid];
    if (!job) return;
    _jobDetailCurrent = { jid, kind, label: (job.module || job.target || '').split('/').slice(-1)[0] || 'job' };

    document.getElementById('job-detail-title').textContent = job.module || job.target || jid;
    const sub = [];
    if (job.module && job.target) sub.push(job.target);
    if (job.type) sub.push(job.type);
    if (job.started_at) sub.push('started ' + job.started_at);
    if (job.finished_at) sub.push('finished ' + job.finished_at);
    sub.push(kind.toUpperCase());
    document.getElementById('job-detail-sub').textContent = sub.join('  ·  ');

    const stEl = document.getElementById('job-detail-status');
    stEl.textContent = job.status || '?';
    stEl.className = 'text-[10px] font-bold uppercase px-2 py-1 rounded border ' + jobStatusStyle(job.status);

    document.getElementById('job-detail-config').innerHTML = (kind === 'msf')
        ? jobConfigRows(job.options)
        : jobConfigRows({ target: job.target, args: job.args_used, hosts_found: job.hosts_found });

    const outEl = document.getElementById('job-detail-output');
    outEl.textContent = job.result || job.output || 'Loading…';

    const terminal = !['running', 'queued', 'launched'].includes((job.status || '').toLowerCase());
    document.getElementById('job-detail-feed').classList.toggle('hidden', !(kind === 'msf' && terminal));

    const modal = document.getElementById('job-detail-modal');
    modal.classList.remove('hidden'); modal.classList.add('flex');

    // MSF jobs expose full output via an endpoint; nmap jobs only have summary fields.
    const running = ['running', 'queued', 'launched'].includes((job.status || '').toLowerCase());
    if (kind === 'msf') {
        const refresh = async () => {
            try {
                const res = await fetch(`/api/msf/jobs/${jid}/output`);
                if (!res.ok) return;
                const d = await res.json();
                const full = (typeof d === 'string') ? d : (d.output || d.result || '');
                if (full && full.trim()) outEl.textContent = full;
                else if (!(job.result || job.output)) outEl.textContent = running ? 'Running…' : '(no output captured)';
                // Update status badge live + stop polling when the job ends.
                if (d.status) {
                    const stEl = document.getElementById('job-detail-status');
                    stEl.textContent = d.status;
                    stEl.className = 'text-[10px] font-bold uppercase px-2 py-1 rounded border ' + jobStatusStyle(d.status);
                    if (!['running', 'queued', 'launched'].includes(String(d.status).toLowerCase()) && _jobDetailTimer) {
                        clearInterval(_jobDetailTimer); _jobDetailTimer = null;
                        document.getElementById('job-detail-feed').classList.remove('hidden');
                    }
                }
            } catch { /* keep last */ }
        };
        await refresh();
        if (running) {
            if (_jobDetailTimer) clearInterval(_jobDetailTimer);
            _jobDetailTimer = setInterval(refresh, 1500);
        }
    } else if (!(job.result || job.output)) {
        const parts = [];
        if (job.hosts_found != null) parts.push('Hosts found: ' + job.hosts_found);
        if (Array.isArray(job.warnings) && job.warnings.length) parts.push('Warnings:\n' + job.warnings.join('\n'));
        if (job.error) parts.push('Error: ' + job.error);
        outEl.textContent = parts.join('\n\n') || '(nmap jobs do not expose raw output here)';
    }
}

let _jobDetailTimer = null;
function closeJobDetail() {
    const modal = document.getElementById('job-detail-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
    _jobDetailCurrent = null;
    if (_jobDetailTimer) { clearInterval(_jobDetailTimer); _jobDetailTimer = null; }
}

function jobDetailFeed() {
    if (!_jobDetailCurrent) return;
    const { jid, label, kind } = _jobDetailCurrent;
    closeJobDetail();
    feedJobFromQueue(jid, label, kind);
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('job-detail-modal').classList.contains('hidden')) closeJobDetail();
});

// Post / Auxiliary Console (standalone tab)
let paCurrentModule  = null;
let paCurrentType    = 'post';
let paCurrentOptions = {};
let _paSearchTimer   = null;

function paOnTabOpen() {
    paRefreshSessions(false);
}

function paSetType(t) {
    paCurrentType = t;
    ['post', 'auxiliary'].forEach(type => {
        const btn = document.getElementById('pa-type-' + type);
        btn.className = type === t
            ? 'text-[9px] font-bold uppercase px-2 py-1 rounded border transition-all bg-green-500/10 border-green-500/25 text-green-300'
            : 'text-[9px] font-bold uppercase px-2 py-1 rounded border transition-all bg-[#050608] border-[#1f222a] text-gray-600 hover:text-gray-300';
    });
    document.getElementById('pa-search-input').value = '';
    document.getElementById('pa-search-results').classList.add('hidden');
}

function paSearch(q, immediate) {
    clearTimeout(_paSearchTimer);
    const box = document.getElementById('pa-search-results');
    if (!q || q.trim().length < 2) { box.classList.add('hidden'); return; }
    const delay = immediate ? 0 : 450;
    _paSearchTimer = setTimeout(async () => {
        try {
            box.innerHTML = '<div class="text-xs text-gray-600 animate-pulse p-1">Searching…</div>';
            box.classList.remove('hidden');
            const res = await fetch(`/api/msf/modules/search?q=${encodeURIComponent(q)}&type=${paCurrentType}`);
            const results = await res.json();
            if (!Array.isArray(results) || !results.length) {
                box.innerHTML = '<div class="text-xs text-gray-600 italic p-1">No results.</div>';
                return;
            }
            box.innerHTML = results.slice(0, 25).map(m => {
                const name = m.fullname || m.name || '';
                const rank = (m.rank || 'normal').toLowerCase();
                const rankColor = rank === 'excellent' ? 'text-green-400' : rank === 'great' ? 'text-blue-400' : rank === 'good' ? 'text-yellow-400' : 'text-gray-500';
                return `<button onclick="paSelectModule('${escHtml(name)}')"
                    class="w-full text-left px-2 py-1.5 rounded hover:bg-green-500/10 transition-all group flex items-center justify-between gap-2">
                    <div class="min-w-0">
                        <div class="font-mono text-[10px] text-orange-300 truncate">${escHtml(name)}</div>
                        <div class="text-[9px] text-gray-600 group-hover:text-gray-500 truncate">${escHtml(m.description || '')}</div>
                    </div>
                    <span class="text-[9px] font-bold uppercase ${rankColor} flex-shrink-0">${rank}</span>
                </button>`;
            }).join('');
        } catch { box.innerHTML = '<div class="text-xs text-red-400 p-1">Search failed.</div>'; }
    }, delay);
}

function paQuickPick(modulePath) {
    paCurrentType = modulePath.startsWith('auxiliary') ? 'auxiliary' : 'post';
    paSetType(paCurrentType);
    paSelectModule(modulePath);
}

async function paSelectModule(modulePath) {
    paCurrentModule = modulePath;
    document.getElementById('pa-search-results').classList.add('hidden');
    document.getElementById('pa-module-name').textContent = modulePath;
    document.getElementById('pa-reload-btn').classList.remove('hidden');
    document.getElementById('pa-module-options').innerHTML =
        '<div class="text-xs text-gray-600 animate-pulse">Loading options…</div>';
    await paLoadModuleInfo();
}

async function paLoadModuleInfo() {
    if (!paCurrentModule) return;
    try {
        const res = await fetch(`/api/msf/modules/info?module=${encodeURIComponent(paCurrentModule)}&type=${paCurrentType}`);
        const info = await res.json();
        if (info.error) throw new Error(info.error);

        paCurrentOptions = {};
        Object.entries(info.options || {}).forEach(([k, v]) => {
            paCurrentOptions[k] = v.default || '';
        });

        // Sort: required first, then optional
        const required = Object.entries(info.options || {}).filter(([, v]) => v.required);
        const optional = Object.entries(info.options || {}).filter(([, v]) => !v.required);
        const sorted   = [...required, ...optional];

        if (!sorted.length) {
            document.getElementById('pa-module-options').innerHTML =
                '<div class="text-xs text-gray-600 italic">No configurable options.</div>';
        } else {
            document.getElementById('pa-module-options').innerHTML = sorted.map(([k, v]) => {
                const req  = v.required ? '<span class="text-red-500">*</span>' : '';
                const desc = v.description ? v.description.slice(0, 70) : '';
                const isBoolean = v.type === 'bool' || v.default === 'true' || v.default === 'false';
                const input = isBoolean
                    ? `<select class="form-select-box text-xs py-1.5" style="max-width:120px"
                            onchange="paCurrentOptions['${k}']=this.value">
                           <option value="">Default</option>
                           <option value="true" ${v.default==='true'?'selected':''}>true</option>
                           <option value="false" ${v.default==='false'?'selected':''}>false</option>
                       </select>`
                    : `<input type="text" value="${escHtml(v.default || '')}" placeholder="${escHtml(desc)}"
                           class="form-input-box flex-1 text-xs font-mono py-1.5"
                           onchange="paCurrentOptions['${k}']=this.value"
                           oninput="paCurrentOptions['${k}']=this.value">`;
                return `<div class="flex gap-2 items-start">
                    <label class="text-gray-500 w-24 flex-shrink-0 font-mono text-[10px] pt-2">${escHtml(k)} ${req}</label>
                    ${input}
                </div>`;
            }).join('');
        }

        // Auto-fill SESSION
        paRefreshSessions(true);
    } catch (e) {
        document.getElementById('pa-module-options').innerHTML =
            `<div class="text-xs text-red-400">Failed to load options: ${escHtml(e.message)}</div>`;
    }
}

function paSessionChanged() {
    const v = document.getElementById('pa-session-select').value;
    if (v) paCurrentOptions['SESSION'] = v;
}

function paRefreshSessions(autoFill) {
    const sel = document.getElementById('pa-session-select');
    fetch('/api/msf/sessions').then(r => r.json()).then(sessions => {
        const cur = sel.value;
        sel.innerHTML = '<option value="">choose active session</option>';
        sessions.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `Session ${s.id} - ${s.type} - ${s.target}`;
            sel.appendChild(opt);
        });
        if (cur) sel.value = cur;
        if (autoFill && sessions.length === 1 && paCurrentOptions.hasOwnProperty('SESSION')) {
            sel.value = sessions[0].id;
            paCurrentOptions['SESSION'] = sessions[0].id;
            // Sync into the SESSION text input if visible
            document.querySelectorAll('#pa-module-options input').forEach(inp => {
                const lbl = inp.closest('div')?.querySelector('label');
                if (lbl && lbl.textContent.trim().startsWith('SESSION')) inp.value = sessions[0].id;
            });
        }
    }).catch(() => {});
}

function paSetStatus(label, colorClass) {
    const badge = document.getElementById('pa-status-badge');
    badge.textContent = label;
    badge.className = `text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded border ${colorClass}`;
    badge.classList.remove('hidden');
}

function paClearOutput() {
    document.getElementById('pa-output-log').innerHTML =
        '<span class="text-gray-700 italic">No output yet. Select a module and click Run Module.</span>';
    const badge = document.getElementById('pa-status-badge');
    badge.classList.add('hidden');
}

async function paRunModule() {
    if (!paCurrentModule) {
        document.getElementById('pa-search-input').focus();
        return;
    }

    // Sync SESSION from dropdown
    const sessionSel = document.getElementById('pa-session-select').value;
    if (sessionSel) paCurrentOptions['SESSION'] = sessionSel;

    // SESSION required for post modules
    if (paCurrentType === 'post' && !paCurrentOptions['SESSION']) {
        const sel = document.getElementById('pa-session-select');
        sel.classList.add('border-red-500', 'ring-1', 'ring-red-500/30');
        setTimeout(() => sel.classList.remove('border-red-500', 'ring-1', 'ring-red-500/30'), 2000);
        paSetStatus('SESSION required', 'text-red-400 bg-red-500/10 border-red-500/20');
        return;
    }

    const btn = document.getElementById('pa-run-btn');
    const log = document.getElementById('pa-output-log');
    btn.disabled = true;
    btn.innerHTML = `<svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Running…`;
    paSetStatus('dispatching…', 'text-blue-400 bg-blue-500/10 border-blue-500/20');
    log.textContent = `[${new Date().toLocaleTimeString()}] Dispatching ${paCurrentModule}…\n`;

    try {
        const res = await fetch('/api/msf/post', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                module: paCurrentModule,
                options: { ...paCurrentOptions },
                type: paCurrentType
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.statusText);

        const jobId = data.job_id;
        log.textContent += `Job ${jobId} dispatched. Polling for output…\n`;
        paSetStatus('running', 'text-blue-400 bg-blue-500/10 border-blue-500/20');
        fetchJobs();

        // Poll for completion
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const outRes  = await fetch(`/api/msf/jobs/${jobId}/output`);
                const outData = await outRes.json();
                if (outData.output) log.textContent = outData.output;
                // Scroll to bottom
                log.scrollTop = log.scrollHeight;

                const done = ['succeeded', 'completed', 'failed', 'timed_out'].includes(outData.status);
                if (done) {
                    const ok = ['succeeded', 'completed'].includes(outData.status);
                    paSetStatus(outData.status,
                        ok  ? 'text-green-400 bg-green-500/10 border-green-500/20'
                            : 'text-red-400 bg-red-500/10 border-red-500/20');
                    fetchJobs();
                    // Refresh sessions in case a new one appeared
                    paRefreshSessions(false);
                    break;
                }
            } catch { /* keep polling */ }
        }
    } catch (e) {
        log.textContent += `\n[error] ${e.message}`;
        paSetStatus('error', 'text-red-400 bg-red-500/10 border-red-500/20');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Run Module`;
    }
}

function escHtml(str) {
    return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

