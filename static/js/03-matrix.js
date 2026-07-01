// Asset matrix
let _knownHostIps = null;   // null until first load, then a Set for diffing
async function fetchHosts() {
    try {
        const res = await fetch('/api/hosts');
        allHosts = await res.json();

        // Diff against the last view to highlight + announce newly discovered hosts.
        const currentIps = allHosts.map(h => h.ip);
        if (_knownHostIps !== null) {
            const fresh = currentIps.filter(ip => !_knownHostIps.has(ip));
            if (fresh.length) {
                window._newHostIps = new Set([...(window._newHostIps || []), ...fresh]);
                kaiNotify('New host discovered', fresh.join(', '));
            }
        }
        _knownHostIps = new Set(currentIps);

        const tbody = document.getElementById('host-table');
        if (!allHosts.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center py-20 text-gray-600">No assets discovered. Run a scan to populate the matrix.</td></tr>';
            return;
        }
        tbody.innerHTML = allHosts.map(h => {
            const isNew = window._newHostIps && window._newHostIps.has(h.ip);
            const tagChips = (h.tags || '').split(',').map(t => t.trim()).filter(Boolean)
                .map(t => `<span class="text-[9px] bg-violet-500/10 border border-violet-500/25 text-violet-300 rounded px-1.5 py-0.5">${escHtml(t)}</span>`).join(' ');
            return `
            <tr class="hover:bg-[#0a0c10] transition-colors group ${isNew ? 'bg-green-500/[0.04]' : ''}">
                <td class="px-5 py-3.5 font-mono text-blue-400 font-semibold text-sm">${h.ip}${isNew ? ' <span class="text-[8px] font-bold text-green-400 bg-green-500/15 border border-green-500/30 rounded px-1 align-middle">NEW</span>' : ''}</td>
                <td class="px-5 py-3.5">
                    <div class="text-gray-200 text-sm">${h.hostname || 'Unknown'}</div>
                    <div class="text-[10px] text-gray-600 font-mono mt-0.5">${h.mac || '-'}</div>
                </td>
                <td class="px-5 py-3.5 text-xs text-gray-400 font-mono max-w-[180px]">${h.os || 'Unknown'}</td>
                <td class="px-5 py-3.5">
                    <div class="text-[11px] text-gray-500 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto custom-scrollbar leading-relaxed">${h.ports || '-'}</div>
                </td>
                <td class="px-5 py-3.5">
                    <div class="flex items-center gap-1 flex-wrap">${tagChips}</div>
                    <button onclick="editHostTags(${h.id}, ${JSON.stringify(h.tags || '').replace(/"/g, '&quot;')})" class="text-[9px] text-gray-600 hover:text-violet-400 transition-colors mt-1">+ tag</button>
                </td>
                <td class="px-5 py-3.5 text-[11px] text-gray-600 font-mono">${h.last_seen || '-'}</td>
                <td class="px-4 py-3.5">
                    <div class="flex items-center gap-2">
                        <button onclick="showHostCves('${h.ip}')" title="Look up known CVEs" class="text-gray-600 hover:text-amber-400 transition-colors p-1 rounded hover:bg-amber-500/10">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"/></svg>
                        </button>
                        <button onclick="switchToPentest('${h.ip}')" title="Pentest this host" class="text-gray-600 hover:text-red-400 transition-colors p-1 rounded hover:bg-red-500/10">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        </button>
                        <button onclick="deleteHost(${h.id}, this)" title="Delete" class="text-gray-600 hover:text-red-400 transition-colors p-1 rounded hover:bg-red-500/10">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                        </button>
                    </div>
                </td>
            </tr>`; }).join('');
    } catch(e) { console.error(e); }
    // keep AI dropdown in sync
    if (document.getElementById('kroftai').classList.contains('flex')) populateAiTargetDropdown();
}

async function deleteHost(id, btn) {
    if (btn && btn.dataset.confirming !== 'true') {
        btn.dataset.confirming = 'true';
        const origHtml = btn.innerHTML;
        btn.innerHTML = '<span class="text-red-400 text-[9px] font-bold">Confirm?</span>';
        setTimeout(() => { btn.dataset.confirming = 'false'; btn.innerHTML = origHtml; }, 3000);
        return;
    }
    await fetch('/api/hosts/'+id, {method:'DELETE'});
    fetchHosts();
}

async function editHostTags(id, current) {
    const tags = prompt('Tags (comma-separated):', current || '');
    if (tags === null) return;
    try {
        await fetch(`/api/hosts/${id}/tags`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ tags })
        });
    } catch {}
    fetchHosts();
}

function switchToPentest(ip) {
    switchTab('pentest');
    setTimeout(() => {
        document.getElementById('pt-target-manual').value = ip;
        ptTargetChanged();
    }, 100);
}

