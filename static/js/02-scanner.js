// nmap scanner
function buildArgs() {
    const parts = [];
    document.querySelectorAll('.nmap-sel').forEach(el => { if (el.value) parts.push(el.value); });
    document.querySelectorAll('.nmap-sel-val').forEach(el => { if (el.value && el.dataset.arg) parts.push(el.dataset.arg + ' ' + el.value); });
    document.querySelectorAll('.nmap-chk').forEach(el => { if (el.checked && el.dataset.arg) parts.push(el.dataset.arg); });
    document.querySelectorAll('.nmap-txt').forEach(el => { const v = el.value.trim(); if (v && el.dataset.arg) parts.push(el.dataset.arg + ' ' + v); });
    document.querySelectorAll('.nmap-txtval').forEach(el => { const v = el.value.trim(); if (v && el.dataset.arg) parts.push(el.dataset.arg + v); });
    return parts;
}
function getCommandString() {
    const target = document.getElementById('target-ip').value.trim() || '<target>';
    return 'nmap ' + buildArgs().join(' ') + ' ' + target;
}
function updatePreview() {
    document.getElementById('cmd-preview').innerText = getCommandString();
}
document.getElementById('nmap-config').addEventListener('change', updatePreview);
document.getElementById('nmap-config').addEventListener('keyup', updatePreview);
updatePreview();

async function triggerScan() {
    const target = document.getElementById('target-ip').value.trim();
    if (!target) {
        const inp = document.getElementById('target-ip');
        inp.focus();
        inp.classList.add('border-red-500','ring-1','ring-red-500/30');
        setTimeout(() => inp.classList.remove('border-red-500','ring-1','ring-red-500/30'), 2000);
        return;
    }
    const rawArgs = buildArgs().join(' ');
    const btn = document.getElementById('scan-btn');
    const origHtml = btn.innerHTML;
    const statusEl = document.getElementById('scan-status');
    btn.disabled = true; btn.classList.add('opacity-70','cursor-not-allowed');
    btn.innerHTML = `<svg class="animate-spin w-4 h-4 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/></svg> Dispatching...`;
    try {
        const res = await fetch('/api/scan', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({target, custom_args: rawArgs})
        });
        const data = await res.json();
        if (!res.ok) {
            statusEl.textContent = '✗ Scan error: ' + (data.error || res.statusText);
            statusEl.className = 'text-xs text-red-400 mb-3 font-mono bg-red-500/10 border border-red-500/20 p-2 rounded self-start';
            statusEl.classList.remove('hidden');
            return;
        }
        statusEl.textContent = '[+] Scan payload dispatched to background worker.';
        statusEl.className = 'text-xs text-green-400 mb-3 font-mono bg-green-500/10 border border-green-500/20 p-2 rounded self-start';
        statusEl.classList.remove('hidden');
        setTimeout(() => statusEl.classList.add('hidden'), 5000);
        fetchJobs();
        setTimeout(() => switchTab('matrix'), 800);
    } catch(e) {
        statusEl.textContent = '✗ Failed to reach backend: ' + e.message;
        statusEl.className = 'text-xs text-red-400 mb-3 font-mono bg-red-500/10 border border-red-500/20 p-2 rounded self-start';
        statusEl.classList.remove('hidden');
    }
    finally { btn.disabled = false; btn.classList.remove('opacity-70','cursor-not-allowed'); btn.innerHTML = origHtml; }
}

// Jobs queue
async function fetchJobs() {
    try {
        const [nmapRes, msfRes] = await Promise.all([fetch('/api/jobs'), fetch('/api/msf/jobs')]);
        const nmapJobs = await nmapRes.json();
        const msfJobs  = await msfRes.json().catch(() => []);
        const all = [
            ...nmapJobs.map(j => ({...j, _kind:'nmap'})),
            ...msfJobs.map(j => ({...j, _kind:'msf'}))
        ].sort((a,b) => (b.started_at||'').localeCompare(a.started_at||'')).slice(0, 12);

        const el = document.getElementById('job-queue');
        if (!all.length) { el.innerHTML = '<div class="text-xs text-gray-600 italic px-1">No active jobs</div>'; return; }

        window._jobsById = {};
        el.innerHTML = all.map(job => {
            const jid = job.id || job.job_id || '';
            window._jobsById[jid] = job;
            const running   = job.status === 'Running' || job.status === 'running' || job.status === 'queued' || job.status === 'launched';
            const succeeded = job.status === 'Completed' || job.status === 'succeeded';
            const color = running ? 'text-blue-400' : succeeded ? 'text-green-400' : 'text-red-400';
            const bg    = running ? 'border-blue-500/20 bg-blue-500/5' : succeeded ? 'border-green-900/30 bg-green-500/5' : 'border-[#1f222a] bg-[#0f1116]';
            const kindColor = job._kind === 'msf' ? 'text-orange-500' : 'text-blue-500';
            const icon = running
                ? `<svg class="animate-spin w-3 h-3 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>`
                : succeeded ? `<svg class="w-3 h-3 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`
                : `<svg class="w-3 h-3 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>`;
            const label = (job.module || job.target || '').split('/').slice(-1)[0] || '-';
            const canFeed = (succeeded || job.status === 'Failed' || job.status === 'failed' || job.status === 'TIMED_OUT' || job.status === 'timed_out');
            const feedBtn = canFeed
                ? `<button onclick="event.stopPropagation();feedJobFromQueue('${jid}','${escHtml(label)}','${job._kind}')" title="Feed output to Kroft.AI" class="text-[9px] text-violet-500/60 hover:text-violet-400 border border-violet-500/20 hover:border-violet-400/40 rounded px-1.5 py-0.5 transition-all font-mono mt-0.5 self-start">AI ↑</button>`
                : '';
            return `<div onclick="openJobDetail('${jid}','${job._kind}')" title="Click for config & output" class="border rounded px-2 py-1.5 flex flex-col gap-0.5 cursor-pointer hover:brightness-125 transition-all ${bg}">
                <div class="flex items-center justify-between gap-1">
                    <span class="text-[10px] font-mono text-gray-300 truncate flex-1" title="${job.target||job.module||''}">${label}</span>
                    ${icon}
                </div>
                <div class="flex items-center justify-between">
                    <span class="text-[9px] ${color} font-bold uppercase">${job.status}</span>
                    <span class="text-[9px] ${kindColor} font-bold uppercase">${job._kind}</span>
                </div>
                ${feedBtn}
            </div>`;
        }).join('');
    } catch(e) { /* silent */ }
}

