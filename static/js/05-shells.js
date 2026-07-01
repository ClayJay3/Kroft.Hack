// Shells / xterm
function initTerminal() {
    if (terminalInstance) return;
    const container = document.getElementById('terminal-container');
    terminalInstance = new Terminal({
        theme: {
            background: '#050608', foreground: '#c0caf5',
            cursor: '#7aa2f7', cursorAccent: '#050608',
            black: '#15161e', red: '#f7768e', green: '#9ece6a',
            yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7',
            cyan: '#7dcfff', white: '#a9b1d6',
            brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
            brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
            brightCyan: '#7dcfff', brightWhite: '#c0caf5',
        },
        fontFamily: "'Fira Code', 'Cascadia Code', monospace",
        fontSize: 13, lineHeight: 1.5, cursorBlink: true,
        scrollback: 5000, allowTransparency: true,
        convertEol: true,
    });

    const fitAddon = new FitAddon.FitAddon();
    terminalFit = fitAddon;
    terminalInstance.loadAddon(fitAddon);
    terminalInstance.open(container);

    // fit() MUST run after the element has been painted with real dimensions
    requestAnimationFrame(() => {
        fitAddon.fit();
        terminalInstance.focus();
        terminalInstance.writeln('\x1b[36m╔════════════════════════════════════════╗\x1b[0m');
        terminalInstance.writeln('\x1b[36m║   \x1b[32mKROFT Shell Terminal  \x1b[33mv2.0\x1b[36m            ║\x1b[0m');
        terminalInstance.writeln('\x1b[36m╚════════════════════════════════════════╝\x1b[0m');
        terminalInstance.writeln('\x1b[90mSelect a session from the list to activate.\x1b[0m');
        terminalInstance.writeln('');
    });

    // Use onData (handles ALL keypresses: printable, backspace, enter, ctrl-c, arrows)
    let inputBuffer = '';
    terminalInstance.onData(data => {
        if (!activeSessionId) return;

        // Ctrl-C: send interrupt
        if (data === '\x03') {
            terminalInstance.writeln('^C');
            sendToSession('\x03');
            inputBuffer = '';
            return;
        }
        // Enter
        if (data === '\r' || data === '\n') {
            const cmd = inputBuffer;
            inputBuffer = '';
            sendToSession(cmd);
            return;
        }
        // Backspace / DEL
        if (data === '\x7f' || data === '\b') {
            if (inputBuffer.length > 0) {
                inputBuffer = inputBuffer.slice(0, -1);
                terminalInstance.write('\b \b');
            }
            return;
        }
        // Ignore escape sequences (arrow keys, F-keys, etc.); they start with \x1b
        if (data.startsWith('\x1b')) return;

        // Regular printable characters
        inputBuffer += data;
        terminalInstance.write(data);
    });

    // Re-fit whenever the container resizes (e.g. window resize)
    new ResizeObserver(() => {
        if (terminalFit) {
            try { terminalFit.fit(); } catch(e) { /* ignore */ }
        }
    }).observe(container);

    // Click on terminal to ensure focus
    container.addEventListener('click', () => terminalInstance.focus());
}

async function sendToSession(cmd) {
    if (!activeSessionId || !cmd.trim()) { terminalInstance.writeln(''); writePrompt(); return; }
    terminalInstance.writeln('');  // move off the input line
    terminalInstance.writeln(`\x1b[36m$ ${cmd}\x1b[0m`);
    terminalInstance.writeln('\x1b[90m…\x1b[0m');
    try {
        const res = await fetch(`/api/msf/sessions/${activeSessionId}/exec`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({cmd})
        });
        const data = await res.json();
        // Clear the "…" line (move up and erase)
        terminalInstance.write('\x1b[1A\x1b[2K');
        if (data.error) {
            terminalInstance.writeln('\x1b[31m[error] ' + data.error + '\x1b[0m');
        } else if (data.output) {
            printOutput(data.output);
        } else {
            terminalInstance.writeln('\x1b[90m(no output)\x1b[0m');
        }
    } catch(e) { terminalInstance.writeln('\x1b[31m[request failed: ' + e.message + ']\x1b[0m'); }
    writePrompt();
}

function writePrompt() {
    if (!activeSessionId) return;
    // Find the session type for the right prompt style
    fetch('/api/msf/sessions').then(r=>r.json()).then(sessions => {
        const s = sessions.find(x => x.id === activeSessionId);
        const isMeterp = s && s.type === 'meterpreter';
        const promptColor = isMeterp ? '\x1b[35m' : '\x1b[33m';
        const promptSuffix = isMeterp ? 'meterpreter >' : 'shell $';
        terminalInstance.write(`${promptColor}[session-${activeSessionId}]\x1b[0m \x1b[36m${promptSuffix}\x1b[0m `);
    }).catch(() => {
        terminalInstance.write(`\x1b[33m[session-${activeSessionId}]\x1b[0m \x1b[36m$\x1b[0m `);
    });
}

function clearTerminal() {
    if (terminalInstance) terminalInstance.clear();
}

let _knownSessionIds = null;   // null until first poll, then a Set
async function fetchSessions() {
    try {
        const res = await fetch('/api/msf/sessions');
        const sessions = await res.json();
        const list = document.getElementById('session-list');
        const badge = document.getElementById('session-badge');

        if (sessions.length) {
            badge.textContent = sessions.length;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }

        // Detect newly-opened sessions, then notify and kick off auto post-recon.
        const ids = sessions.map(s => String(s.id));
        if (_knownSessionIds !== null) {
            sessions.filter(s => !_knownSessionIds.has(String(s.id))).forEach(s => {
                kaiNotify('Session opened', `Session ${s.id} (${s.type}) on ${s.target}`);
                kaiAutoPostRecon(s.id, s.type, s.target);
            });
        }
        _knownSessionIds = new Set(ids);

        if (!sessions.length) {
            list.innerHTML = '<div class="text-xs text-gray-600 italic px-1">No active sessions.</div>';
            return;
        }
        list.innerHTML = sessions.map(s => {
            const active = s.id === activeSessionId;
            const typeColor = s.type === 'meterpreter' ? 'text-purple-400' : 'text-green-400';
            return `<div onclick="activateSession('${s.id}')"
                class="cursor-pointer rounded-lg border px-3 py-2.5 transition-all
                    ${active ? 'border-green-500/40 bg-green-500/10' : 'border-[#1f222a] bg-[#050608] hover:border-green-500/20 hover:bg-green-500/5'}">
                <div class="flex items-center justify-between mb-1">
                    <span class="text-xs font-mono text-gray-200">Session ${s.id}</span>
                    <span class="text-[10px] font-bold uppercase ${typeColor}">${s.type}</span>
                </div>
                <div class="text-[10px] text-gray-500 font-mono">${s.target}</div>
            </div>`;
        }).join('');
    } catch(e) { /* silent */ }
}

function activateSession(sid) {
    activeSessionId = sid;
    document.getElementById('active-session-id').textContent = `#${sid}`;
    document.getElementById('terminal-session-label').textContent = `session ${sid}`;
    document.getElementById('kill-btn').disabled = false;

    // Refresh session list first so type is up-to-date, then render info panel
    fetch('/api/msf/sessions').then(r=>r.json()).then(sessions => {
        const s = sessions.find(x => x.id === sid);
        if (!s) return;
        const typeColor = s.type === 'meterpreter' ? 'purple' : 'green';
        const typeBg    = s.type === 'meterpreter' ? 'bg-purple-500/10 border-purple-500/25 text-purple-300' : 'bg-green-500/10 border-green-500/25 text-green-300';
        const body = document.getElementById('session-info-body');
        body.innerHTML = `
            <div><div class="form-label">Type</div>
                <div class="inline-flex items-center gap-1.5 font-mono text-xs font-bold uppercase px-2 py-0.5 rounded border ${typeBg}">
                    ${s.type === 'meterpreter' ? '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>' : '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3"/></svg>'}
                    ${s.type}
                </div>
            </div>
            <div><div class="form-label">Target</div><div class="font-mono text-xs text-blue-400">${s.target}</div></div>
            <div><div class="form-label">Tunnel</div><div class="font-mono text-xs text-gray-400">${s.tunnel||'-'}</div></div>
            <div><div class="form-label">Module</div><div class="font-mono text-xs text-gray-400 truncate">${s.module||'-'}</div></div>
            <div><div class="form-label">Opened</div><div class="font-mono text-xs text-gray-400">${s.opened_at||'-'}</div></div>
            <div><div class="form-label">Info</div><div class="font-mono text-xs text-gray-400">${s.info||'-'}</div></div>`;
        // Re-render session list tabs to reflect any type change
        fetchSessions();
    });

    if (!terminalInstance) initTerminal();
    terminalInstance.writeln('');
    terminalInstance.writeln(`\x1b[33m[*]\x1b[0m Activated session \x1b[32m${sid}\x1b[0m, type commands below`);

    // Replay any previously logged commands for this session
    fetch('/api/msf/sessions').then(r=>r.json()).then(sessions => {
        const s = sessions.find(x => x.id === sid);
        if (s && s.log && s.log.length) {
            terminalInstance.writeln('\x1b[90m─── replay ───\x1b[0m');
            s.log.forEach(entry => {
                terminalInstance.writeln(`\x1b[36m$ ${entry.cmd}\x1b[0m`);
                if (entry.output) printOutput(entry.output);
            });
            terminalInstance.writeln('\x1b[90m─── live ─────\x1b[0m');
        }
        // Drain any buffered banner/prompt from the shell
        drainSessionOutput(sid).then(() => {
            if (terminalInstance) terminalInstance.focus();
        });
    });
}

// Read any pending output from the session without sending a command (banner, prompt, etc.)
async function drainSessionOutput(sid) {
    if (sid !== activeSessionId) return;
    try {
        const res = await fetch(`/api/msf/sessions/${sid}/read`);
        const data = await res.json();
        if (data.output && data.output.trim()) {
            printOutput(data.output);
        }
    } catch(e) { /* silent */ }
    writePrompt();
}

function printOutput(text) {
    if (!text) return;
    // Strip carriage returns, split on newlines, write each line
    text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').forEach(line => {
        // Pass through ANSI escape codes if present, otherwise colour green
        if (/\x1b\[/.test(line)) {
            terminalInstance.writeln(line);
        } else {
            terminalInstance.writeln('\x1b[32m' + line + '\x1b[0m');
        }
    });
}

async function killActiveSession(btn) {
    if (!activeSessionId) return;
    if (btn && btn.dataset.confirming !== 'true') {
        btn.dataset.confirming = 'true';
        const orig = btn.textContent;
        btn.textContent = 'Confirm kill?';
        btn.classList.add('bg-red-700/60');
        setTimeout(() => { btn.dataset.confirming = 'false'; btn.textContent = orig; btn.classList.remove('bg-red-700/60'); }, 3000);
        return;
    }
    await fetch(`/api/msf/sessions/${activeSessionId}/kill`, {method:'POST'});
    terminalInstance.writeln(`\x1b[31m[!] Session ${activeSessionId} terminated.\x1b[0m`);
    activeSessionId = null;
    document.getElementById('active-session-id').textContent = '-';
    document.getElementById('terminal-session-label').textContent = 'No session';
    document.getElementById('kill-btn').disabled = true;
    fetchSessions();
}

