// Cyberspace: live 3D attack visualizer
// A three.js scene built from Kroft's real telemetry. Your network shows up as
// nodes around the Kroft core, a green AI drone moves between them poking ports
// and firing exploits, owned hosts turn green and pivot to their neighbours, and
// every DB touch streaks a packet to or from the core.
//
// Two clocks run here:
//   - a recorder polls the normal API every couple seconds (always, even when this
//     tab is hidden) and writes a timeline of everything that happens.
//   - the three.js render loop only runs while the tab is visible, so we don't
//     waste GPU.
// Because the recorder keeps a full timeline, the scrubber at the bottom can replay
// the whole engagement.

// Tunables
const CY_POLL_MS      = 2000;     // recorder cadence
const CY_STATUS_COLORS = {
    down:     0x1e293b,
    up:       0x3b82f6,
    scanning: 0xf59e0b,
    attack:   0xef4444,
    owned:    0x22c55e,
};

// Packet gravity sim
// Packets are real bodies: launched with an impulse, then pulled by the gravity of
// the planets (each has mass) and their destination, with light drag so the orbit
// decays and they spiral in. Tuned so a packet reliably arrives in a few seconds.
const CY_CORE_MASS = 1500;        // the Kroft core is heavy
const CY_G         = 1.7;         // gravitational constant
const CY_DRAG      = 0.16;        // orbital decay (per second)
const CY_SOFT2     = 9;           // softening, avoids singular acceleration up close
const CY_PERTURB   = 0.22;        // how much *other* planets tug on a passing packet
const CY_CAPTURE   = 2.2;         // distance at which a packet is swallowed
const CY_MAXV      = 64;          // speed clamp (stops escape/blowup)
function cyNodeMass(ports) { return 240 + (ports ? ports.length : 0) * 36; }  // mass grows with port count

// Module state
let cyScene, cyCamera, cyRenderer, cyClock, cyResizeObs;
let cyBuilt = false, cyVisible = false, cyRaf = null;
let cyCore, cyInternet, cyDrone, cyDroneTrail, cyStars;
let cyNodeRoot, cyFxRoot;
const cyNodes = new Map();        // ip -> node record (mesh + history)
let cyPackets = [];               // live packet sprites
let cyBeams = [];                 // transient attack/scan/pivot beams
let cyTrailPts = [];              // drone trail positions
let cyCoreShards = [];            // colored data shards accumulating inside the core
let cyCoreShardGroup = null;
let cyLiveSeen = 0;               // # of events already emitted in live mode
let cyPanels = new Map();         // ip -> floating 3D info dossier
let cyRay = null;                 // raycaster for click-picking nodes
let cyDownPos = null;             // mousedown position (to tell click from drag)

// camera orbit
let cyTheta = 0.7, cyPhi = 1.15, cyRadius = 54, cyDragging = false, cyLastMouse = null;

// recorder / timeline
let cyEventSeq = 0;               // last /api/events seq seen
let cySessionHist = [];           // [{host, open, close|null}]
let cyPktEvents = [];             // [{t, kind, host, detail}] from /api/events
let cyT0 = Date.now() / 1000;     // engagement start (first telemetry)
let cyLiveScan = new Set();       // host strings with a running nmap job  (live)
let cyLiveExploit = null;         // {host,label} of newest active msf job (live)
let cyLiveSessions = new Set();   // host ips with an open session         (live)
let cyHaveData = false;
let cyPktTimes = [];              // timestamps of recent packet spawns (for PKT/S)

// playback
let cyLiveMode = true;            // true = follow real time
let cyPlaying = false;            // replay play/pause (only meaningful when !cyLiveMode)
let cySpeed = 1;
let cyPlayhead = Date.now() / 1000;
let cyCursorT = cyPlayhead;       // last time we emitted packets up to

// Tab hooks (called from switchTab in 01-core.js)
function cyberOnTabOpen() {
    if (typeof THREE === 'undefined') return;          // CDN failed to load
    if (!cyBuilt) cyBuild();
    cyVisible = true;
    if (cyLiveMode) cyLiveSeen = cyPktEvents.length;  // only animate events that arrive from now on
    cyResize();
    if (!cyRaf) cyRaf = requestAnimationFrame(cyAnimate);
}

function cyberOnTabClose() {
    cyVisible = false;
    if (cyRaf) { cancelAnimationFrame(cyRaf); cyRaf = null; }
}

// Scene construction
function cyBuild() {
    const mount = document.getElementById('cy-canvas');
    if (!mount) return;
    const w = mount.clientWidth || 800, h = mount.clientHeight || 600;

    cyScene = new THREE.Scene();
    cyScene.fog = new THREE.FogExp2(0x04070a, 0.0095);

    cyCamera = new THREE.PerspectiveCamera(55, w / h, 0.1, 4000);

    cyRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    cyRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    cyRenderer.setSize(w, h);
    cyRenderer.setClearColor(0x04070a, 1);
    mount.appendChild(cyRenderer.domElement);

    cyClock = new THREE.Clock();
    cyRay = new THREE.Raycaster();
    cyNodeRoot = new THREE.Group(); cyScene.add(cyNodeRoot);
    cyFxRoot   = new THREE.Group(); cyScene.add(cyFxRoot);

    cyBuildGrid();
    cyBuildStars();
    cyBuildCore();
    cyBuildInternet();
    cyBuildDrone();
    cyBindCamera(mount);

    // observe size changes of the stage
    cyResizeObs = new ResizeObserver(() => cyResize());
    cyResizeObs.observe(mount);

    cyBuilt = true;
    // Build meshes for everything the recorder already discovered while hidden.
    cyNodes.forEach(n => cyEnsureMesh(n));
    cyLayout();
}

function cyBuildGrid() {
    const grid = new THREE.GridHelper(240, 60, 0x0e7490, 0x0a3a44);
    grid.position.y = -18;
    grid.material.transparent = true;
    grid.material.opacity = 0.32;
    cyScene.add(grid);
    const grid2 = new THREE.GridHelper(240, 12, 0x155e75, 0x103e48);
    grid2.position.y = -17.9;
    grid2.material.transparent = true;
    grid2.material.opacity = 0.5;
    cyScene.add(grid2);
}

function cyBuildStars() {
    const n = 700, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        const r = 120 + Math.random() * 300;
        const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
        pos[i*3+1] = r * Math.cos(ph) * 0.6;
        pos[i*3+2] = r * Math.sin(ph) * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    cyStars = new THREE.Points(g, new THREE.PointsMaterial({
        color: 0x1e6b7a, size: 0.7, transparent: true, opacity: 0.7, depthWrite: false }));
    cyScene.add(cyStars);
}

function cyBuildCore() {
    cyCore = new THREE.Group();
    cyCore.position.set(0, 0, 0);
    const inner = new THREE.Mesh(
        new THREE.IcosahedronGeometry(3.2, 1),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.9 }));
    const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(4.6, 1),
        new THREE.MeshBasicMaterial({ color: 0x0891b2, wireframe: true, transparent: true, opacity: 0.4 }));
    shell.userData.spin = 0.2;
    cyCore.add(inner, shell);
    cyCore.add(cyGlow(0x22d3ee, 22));
    cyCoreShardGroup = new THREE.Group();      // stored-data shards live in here
    cyCore.add(cyCoreShardGroup);
    cyCore.userData = { inner, shell };
    cyCore.add(cyLabel('KROFT CORE', '#67e8f9', 1.5));
    cyCore.children[cyCore.children.length - 1].position.set(0, 7, 0);
    cyScene.add(cyCore);
}

function cyBuildInternet() {
    cyInternet = new THREE.Group();
    cyInternet.position.set(0, 34, -38);
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(4, 0.25, 8, 36),
        new THREE.MeshBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.7 }));
    ring.rotation.x = Math.PI / 2;
    cyInternet.add(ring, cyGlow(0x64748b, 14));
    const lbl = cyLabel('INTERNET / NVD', '#94a3b8', 1.2); lbl.position.set(0, 6, 0);
    cyInternet.add(lbl);
    cyInternet.userData = { ring };
    cyScene.add(cyInternet);
}

function cyBuildDrone() {
    cyDrone = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.1, 0),
        new THREE.MeshBasicMaterial({ color: 0x4ade80, wireframe: true }));
    body.userData.spin = 2.5;
    cyDrone.add(body, cyGlow(0x22c55e, 9));
    cyDrone.userData = { body, vel: new THREE.Vector3() };
    cyDrone.position.set(0, 10, 10);
    cyScene.add(cyDrone);

    // trail line
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(40 * 3), 3));
    cyDroneTrail = new THREE.Line(g, new THREE.LineBasicMaterial({
        color: 0x22c55e, transparent: true, opacity: 0.45, depthWrite: false }));
    cyScene.add(cyDroneTrail);
}

// small mesh helpers
let _cyGlowTex = null;
function cyGlowSprite() {
    if (!_cyGlowTex) {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const x = c.getContext('2d');
        const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g; x.fillRect(0, 0, 128, 128);
        _cyGlowTex = new THREE.CanvasTexture(c);
    }
    return _cyGlowTex;
}
function cyGlow(color, size) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cyGlowSprite(), color, transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    s.scale.set(size, size, 1);
    return s;
}
function cyLabel(text, color, scale) {
    const c = document.createElement('canvas'), pad = 8, font = 44;
    const x = c.getContext('2d');
    x.font = `bold ${font}px 'Fira Code', monospace`;
    c.width = Math.ceil(x.measureText(text).width) + pad * 2;
    c.height = font + pad * 2;
    const xx = c.getContext('2d');
    xx.font = `bold ${font}px 'Fira Code', monospace`;
    xx.textBaseline = 'middle';
    xx.shadowColor = color; xx.shadowBlur = 12;
    xx.fillStyle = color; xx.fillText(text, pad, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: 0.92 }));
    const k = (scale || 1) * 0.04;
    spr.scale.set(c.width * k, c.height * k, 1);
    return spr;
}

// camera orbit (lightweight, no OrbitControls dependency)
function cyBindCamera(mount) {
    const el = cyRenderer.domElement;
    el.addEventListener('mousedown', e => { cyDragging = true; cyLastMouse = [e.clientX, e.clientY]; cyDownPos = [e.clientX, e.clientY]; });
    window.addEventListener('mouseup', e => {
        cyDragging = false;
        if (cyDownPos) {
            const moved = Math.hypot(e.clientX - cyDownPos[0], e.clientY - cyDownPos[1]);
            if (moved < 6) cyPick(e.clientX, e.clientY);   // a click, not an orbit-drag
            cyDownPos = null;
        }
    });
    window.addEventListener('mousemove', e => {
        if (!cyDragging || !cyLastMouse) return;
        cyTheta -= (e.clientX - cyLastMouse[0]) * 0.005;
        cyPhi   -= (e.clientY - cyLastMouse[1]) * 0.005;
        cyPhi = Math.max(0.25, Math.min(Math.PI - 0.25, cyPhi));
        cyLastMouse = [e.clientX, e.clientY];
    });
    el.addEventListener('wheel', e => {
        e.preventDefault();
        cyRadius = Math.max(16, Math.min(160, cyRadius + e.deltaY * 0.03));
    }, { passive: false });
}
function cyUpdateCamera(dt) {
    if (!cyDragging) cyTheta += dt * 0.04;            // slow cinematic auto-orbit
    const cx = 0, cy = 4, cz = 0;
    cyCamera.position.set(
        cx + cyRadius * Math.sin(cyPhi) * Math.cos(cyTheta),
        cy + cyRadius * Math.cos(cyPhi),
        cz + cyRadius * Math.sin(cyPhi) * Math.sin(cyTheta));
    cyCamera.lookAt(cx, cy, cz);
}

function cyResize() {
    const mount = document.getElementById('cy-canvas');
    if (!mount || !cyRenderer) return;
    const w = mount.clientWidth, h = mount.clientHeight;
    if (!w || !h) return;
    cyCamera.aspect = w / h; cyCamera.updateProjectionMatrix();
    cyRenderer.setSize(w, h);
}

// Node lifecycle + layout
// Pure data record (no three.js), safe to create from the recorder at any time,
// even before the tab is ever opened. The visual mesh is attached lazily.
function cyEnsureData(ip, ports, os) {
    let n = cyNodes.get(ip);
    if (n) {
        if (ports && ports.length) { n.ports = ports; n.mass = cyNodeMass(ports); if (n.grp) cyBuildPortRing(n); }
        if (os) n.os = os;
        return n;
    }
    const now = Date.now() / 1000;
    n = {
        ip, ports: ports || [], os: os || '', up: true, mass: cyNodeMass(ports),
        basePos: { x: 0, y: 0, z: 0 }, phase: Math.random() * Math.PI * 2,
        discovered: now, statusHist: [{ t: now, status: 'up' }],
        grp: null, mesh: null, glow: null, ring: null, bot: null,
        curColor: null, targetScale: 1, bodyStatus: 'up',
    };
    cyNodes.set(ip, n);
    if (cyBuilt) { cyEnsureMesh(n); cyLayout(); }
    return n;
}

// Attach the three.js representation to a data record (called once the scene exists).
function cyEnsureMesh(n) {
    if (n.grp || !cyBuilt) return;
    const grp = new THREE.Group();
    const mesh = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1.7, 0),
        new THREE.MeshBasicMaterial({ color: CY_STATUS_COLORS.up, wireframe: true, transparent: true, opacity: 0.95 }));
    const glow = cyGlow(CY_STATUS_COLORS.up, 7);
    const ring = new THREE.Group();           // port dots
    const bot  = new THREE.Mesh(              // little "AI inside" bot, shown when owned
        new THREE.TetrahedronGeometry(0.55, 0),
        new THREE.MeshBasicMaterial({ color: 0x86efac, wireframe: true, transparent: true, opacity: 0 }));
    // invisible, generous click target so hosts are easy to pick
    const hit = new THREE.Mesh(
        new THREE.SphereGeometry(3.2, 10, 10),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    hit.userData.ip = n.ip;
    grp.add(mesh, glow, ring, bot, hit);
    const lbl = cyLabel(n.ip, '#cbd5e1', 0.85); lbl.position.set(0, 3, 0);
    grp.add(lbl);
    grp.scale.setScalar(0.01);               // warp-in
    cyNodeRoot.add(grp);
    n.grp = grp; n.mesh = mesh; n.glow = glow; n.ring = ring; n.bot = bot; n.hit = hit;
    n.curColor = new THREE.Color(CY_STATUS_COLORS.up);
    cyBuildPortRing(n);
}

function cyBuildPortRing(n) {
    while (n.ring.children.length) n.ring.remove(n.ring.children[0]);
    const ports = (n.ports || []).slice(0, 14);
    ports.forEach((p, i) => {
        const a = (i / Math.max(ports.length, 1)) * Math.PI * 2;
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.16, 6, 6),
            new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.85 }));
        dot.position.set(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0);
        n.ring.add(dot);
    });
}

// place nodes on a fibonacci shell around the core (clamped above the grid)
function cyLayout() {
    const ips = [...cyNodes.keys()].sort(cyIpCmp);
    const N = ips.length, R = Math.min(14 + N * 1.4, 34);
    const ga = Math.PI * (3 - Math.sqrt(5));
    ips.forEach((ip, i) => {
        const n = cyNodes.get(ip);
        const y = 1 - (i / Math.max(N - 1, 1)) * 2;       // 1..-1
        const rad = Math.sqrt(Math.max(0, 1 - y * y));
        const th = ga * i;
        n.basePos.x = Math.cos(th) * rad * R;
        n.basePos.y = 4 + y * R * 0.7;
        n.basePos.z = Math.sin(th) * rad * R;
        if (n.basePos.y < -14) n.basePos.y = -14 + Math.random() * 4;
    });
}
function cyIpCmp(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pa[i]||0) - (pb[i]||0); }
    return 0;
}

// Recorder: always-on polling that feeds the timeline (runs even when the tab is hidden)
async function cyPoll() {
    try {
        const [hosts, jobs, mjobs, sessions] = await Promise.all([
            cyGet('/api/hosts'), cyGet('/api/jobs'),
            cyGet('/api/msf/jobs'), cyGet('/api/msf/sessions'),
        ]);
        cyIngest(hosts || [], jobs || [], mjobs || [], sessions || []);
        await cyPollEvents();
    } catch (e) { /* offline, ignore */ }
}
async function cyGet(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return r.json();
}
async function cyPollEvents() {
    const data = await cyGet('/api/events?since=' + cyEventSeq);
    if (!data || !data.events) return;
    for (const ev of data.events) {
        cyPktEvents.push({ t: ev.ts, kind: ev.kind, host: ev.host || '', detail: ev.detail || '' });
    }
    if (cyPktEvents.length > 4000) {
        const drop = cyPktEvents.length - 4000;
        cyPktEvents.splice(0, drop);
        cyLiveSeen = Math.max(0, cyLiveSeen - drop);   // keep the live cursor aligned
    }
    if (typeof data.last_seq === 'number') cyEventSeq = data.last_seq;
}

function cyIngest(hosts, jobs, mjobs, sessions) {
    const now = Date.now() / 1000;
    if (!cyHaveData && (hosts.length || jobs.length)) { cyHaveData = true; cyT0 = now; }

    // ensure a data record for every host; record first-sighting as a discovery event
    hosts.forEach(h => {
        const ip = h.ip; if (!ip) return;
        const had = cyNodes.has(ip);
        const n = cyEnsureData(ip, h.ports_json || [], h.os || '');
        n.up = (h.status === 'up');
        n.hostname = h.hostname || '';
        n.mac = h.mac || '';
        if (!had) cyPktEvents.push({ t: now, kind: 'host_discovered', host: ip, detail: '' });
    });

    // live activity sets
    cyLiveScan = new Set();
    jobs.forEach(j => { if ((j.status || '') === 'Running' && j.target) cyLiveScan.add(String(j.target)); });

    cyLiveExploit = null;
    const active = mjobs.filter(j => ['queued','running','launched'].includes(j.status));
    if (active.length) {
        const j = active[active.length - 1];
        const t = (j.type && j.type !== 'exploit') ? j.type.toUpperCase() : 'EXPLOIT';
        cyLiveExploit = { host: String(j.target || ''), label: t + ' · ' + cyShortMod(j.module || '') };
    }

    // sessions -> owned set + open/close history
    const liveSet = new Set();
    sessions.forEach(s => { const ip = String(s.target || ''); if (ip && ip !== '?') liveSet.add(ip); });
    liveSet.forEach(ip => {
        if (!cyLiveSessions.has(ip)) cySessionHist.push({ host: ip, open: now, close: null });
    });
    cyLiveSessions.forEach(ip => {
        if (!liveSet.has(ip)) { const s = cySessionHist.find(x => x.host === ip && x.close === null); if (s) s.close = now; }
    });
    cyLiveSessions = liveSet;

    // record status transitions into each node's history (for playback), always
    cyNodes.forEach(n => {
        const st = cyComputeStatus(n.ip, cyLiveScan, cyLiveExploit, cyLiveSessions, n.up);
        const last = n.statusHist[n.statusHist.length - 1];
        if (!last || last.status !== st) n.statusHist.push({ t: now, status: st });
    });
}
function cyShortMod(m) { const p = String(m).split('/'); return p[p.length - 1] || m; }
function cyComputeStatus(ip, scan, exploit, owned, up) {
    if (owned.has(ip)) return 'owned';
    if (exploit && exploit.host === ip) return 'attack';
    for (const t of scan) { if (t === ip || t.indexOf(ip) !== -1) return 'scanning'; }
    return up ? 'up' : 'down';
}

// State reconstruction at an arbitrary time T (the heart of live + playback)
function cyStatusAt(n, T) {
    let st = 'down';
    for (const e of n.statusHist) { if (e.t <= T) st = e.status; else break; }
    return st;
}
function cySessionsAt(T) {
    const s = new Set();
    cySessionHist.forEach(x => { if (x.open <= T && (x.close === null || x.close > T)) s.add(x.host); });
    return s;
}

// Packets & beams
function cyPosOf(key, host) {
    if (key === 'core')     return cyCore.position.clone();
    if (key === 'internet') return cyInternet.position.clone();
    if (key === 'drone')    return cyDrone.position.clone();
    const n = host && cyNodes.get(host);
    return n ? n.grp.position.clone() : cyDrone.position.clone();
}
const CY_PKT_MAP = {
    loot_stored:      { from: 'host',     to: 'core',     color: 0xfbbf24 },
    host_discovered:  { from: 'host',     to: 'core',     color: 0x38bdf8 },
    module_lookup:    { from: 'core',     to: 'drone',    color: 0x22d3ee },
    report:           { from: 'core',     to: 'host',     color: 0x22d3ee },
    cve_lookup:       { from: 'core',     to: 'core', via:'internet', color: 0xef4444 },
    exploit_dispatch: { from: 'core',     to: 'host',     color: 0xfb923c },
    scan_dispatch:    { from: 'core',     to: 'host',     color: 0xfb923c },
    module_run:       { from: 'core',     to: 'drone',    color: 0xfb923c },
    console_exec:     { from: 'core',     to: 'drone',    color: 0xa78bfa },
    session_cmd:      { from: 'core',     to: 'drone',    color: 0x4ade80 },
};
function cySpawnEventPacket(ev) {
    const m = CY_PKT_MAP[ev.kind]; if (!m) return;
    cySpawnPacket(cyPosOf(m.from, ev.host), m.to, ev.host || '',
                  m.via ? cyPosOf(m.via, ev.host) : null, m.color, 1.0, m.to === 'core');
    cyPktTimes.push(performance.now());
}

function cyMassOf(kind, host) {
    if (kind === 'core') return CY_CORE_MASS;
    if (kind === 'host') { const n = cyNodes.get(host); return n ? n.mass : 400; }
    return 700;   // drone / internet
}
// Add the gravitational pull of a body at `to` (mass M) on a point at `from`.
function cyGravity(acc, from, to, M) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const r2 = dx*dx + dy*dy + dz*dz + CY_SOFT2;
    const f = (CY_G * M) / (r2 * Math.sqrt(r2));      // G*M / r^3 times the direction vector gives 1/r^2 acceleration
    acc.x += dx * f; acc.y += dy * f; acc.z += dz * f;
}
// Launch impulse: mostly tangential (so it enters an orbit) plus an outward + up
// kick so the packet visibly "shoots off" its source before gravity reels it in.
function cyLaunch(p, destPos) {
    const toDest = destPos.clone().sub(p.pos);
    const r0 = Math.max(4, toDest.length());
    toDest.normalize();
    const up = Math.abs(toDest.y) > 0.85 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const t1 = new THREE.Vector3().crossVectors(toDest, up).normalize();
    const t2 = new THREE.Vector3().crossVectors(toDest, t1).normalize();
    const a = Math.random() * Math.PI * 2;
    const tangent = t1.multiplyScalar(Math.cos(a)).add(t2.multiplyScalar(Math.sin(a)));
    const vorb = Math.sqrt(CY_G * p.destMass0 / r0);
    p.vel.copy(tangent).multiplyScalar(vorb * (1.05 + Math.random() * 0.4));
    p.vel.addScaledVector(toDest, -vorb * 0.3);   // push outward so it shoots off
    p.vel.y += vorb * 0.25;
}

function cySpawnPacket(fromPos, destKind, destHost, viaPos, color, scale, deposit) {
    if (cyPackets.length > 160) return;
    const sc = scale || 1;
    // bright colored halo + white-hot core = very visible
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cyGlowSprite(), color, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.set(5.4 * sc, 5.4 * sc, 1);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: cyGlowSprite(), color: 0xffffff, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    core.scale.set(2.0 * sc, 2.0 * sc, 1);
    cyFxRoot.add(halo); cyFxRoot.add(core);
    // long comet trail
    const N = 22;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    cyFxRoot.add(trail);

    const destPos = cyPosOf(destKind, destHost);
    const p = {
        halo, core, trail, trailN: N, trailPts: [], color, deposit: !!deposit,
        via: viaPos || null, from: fromPos.clone(), destKind, destHost,
        destMass0: cyMassOf(destKind, destHost),
        pos: fromPos.clone(), vel: new THREE.Vector3(),
        t0: performance.now(), maxLife: 11000,
    };
    if (!viaPos) cyLaunch(p, destPos);
    cyPackets.push(p);
}

function cyUpdatePackets(dt) {
    const now = performance.now();
    // Snapshot of all massive bodies (core + visible planets) for perturbation.
    const bodies = [{ pos: cyCore.position, mass: CY_CORE_MASS, host: null }];
    cyNodes.forEach(n => { if (n.grp && n.grp.scale.x > 0.5) bodies.push({ pos: n.grp.position, mass: n.mass, host: n.ip }); });

    for (let i = cyPackets.length - 1; i >= 0; i--) {
        const p = cyPackets[i];
        const age = (now - p.t0) / p.maxLife;
        const destPos = cyPosOf(p.destKind, p.destHost);
        const arrived = (p.pos.distanceTo(destPos) < CY_CAPTURE) || age >= 1;
        if (arrived) {
            cyFxRoot.remove(p.halo); p.halo.material.dispose();
            cyFxRoot.remove(p.core); p.core.material.dispose();
            cyFxRoot.remove(p.trail); p.trail.geometry.dispose(); p.trail.material.dispose();
            if (p.deposit) cyAddCoreShard(p.color);   // data reached the core, so store a shard
            cyPackets.splice(i, 1); continue;
        }

        if (p.via) {
            // CVE round-trip: simple two-leg cruise out to the internet node and back.
            const t = (now - p.t0) / 5200;
            p.pos.copy(t < 0.5 ? p.from.clone().lerp(p.via, t * 2)
                               : p.via.clone().lerp(destPos, (t - 0.5) * 2));
        } else {
            // n-body gravity integration toward the (mass-ramped) destination.
            const massEff = p.destMass0 * (1 + 1.8 * Math.min(age, 1));   // pull strengthens over time to guarantee capture
            const acc = new THREE.Vector3();
            cyGravity(acc, p.pos, destPos, massEff);
            for (const b of bodies) {
                const isDest = (p.destKind === 'core' && b.host === null) ||
                               (p.destKind === 'host' && b.host === p.destHost);
                if (isDest) continue;
                cyGravity(acc, p.pos, b.pos, b.mass * CY_PERTURB);
            }
            p.vel.addScaledVector(acc, dt);
            p.vel.multiplyScalar(1 - CY_DRAG * dt);
            const sp = p.vel.length();
            if (sp > CY_MAXV) p.vel.multiplyScalar(CY_MAXV / sp);
            p.pos.addScaledVector(p.vel, dt);
            if (age > 0.8) p.pos.lerp(destPos, (age - 0.8) / 0.2 * 0.1);  // gentle capture assist at the end
        }

        p.halo.position.copy(p.pos); p.core.position.copy(p.pos);
        const fade = Math.min(1, Math.sin(Math.min(age * 1.4, 1) * Math.PI) + 0.25);
        const shimmer = 0.85 + Math.sin(now * 0.02) * 0.15;
        p.halo.material.opacity = Math.min(1, 0.7 + 0.4 * fade) * shimmer;
        p.core.material.opacity = Math.min(1, 0.5 + fade);
        // comet trail
        p.trailPts.push(p.pos.clone());
        if (p.trailPts.length > p.trailN) p.trailPts.shift();
        const arr = p.trail.geometry.attributes.position.array;
        for (let j = 0; j < p.trailN; j++) {
            const v = p.trailPts[j] || p.trailPts[0] || p.pos;
            arr[j*3] = v.x; arr[j*3+1] = v.y; arr[j*3+2] = v.z;
        }
        p.trail.geometry.attributes.position.needsUpdate = true;
        p.trail.material.opacity = 0.8 * fade;
    }
}

// A small glowing crystal of stored/looted data, parked inside the core for good.
function cyAddCoreShard(color) {
    if (!cyCoreShardGroup) return;
    const m = new THREE.Mesh(
        new THREE.TetrahedronGeometry(0.34 + Math.random() * 0.18, 0),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    const r = 0.5 + Math.random() * 1.9, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    m.position.set(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th));
    m.userData.spin = 1 + Math.random() * 2;
    m.scale.setScalar(0.01);
    cyCoreShardGroup.add(m);
    cyCoreShards.push(m);
    while (cyCoreShards.length > 64) {   // cap so the core doesn't choke
        const old = cyCoreShards.shift();
        cyCoreShardGroup.remove(old); old.geometry.dispose(); old.material.dispose();
    }
}

function cyClearBeams() { cyBeams.forEach(b => { cyFxRoot.remove(b); b.geometry.dispose(); b.material.dispose(); }); cyBeams = []; }
function cyBeam(a, b, color, opacity) {
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({
        color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
    cyFxRoot.add(line); cyBeams.push(line); return line;
}

// Render one frame
function cyAnimate() {
    if (!cyVisible) { cyRaf = null; return; }
    cyRaf = requestAnimationFrame(cyAnimate);
    const dt = Math.min(cyClock.getDelta(), 0.05);
    const realNow = Date.now() / 1000;

    // advance the playhead
    if (cyLiveMode) { cyPlayhead = realNow; }
    else if (cyPlaying) {
        cyPlayhead += dt * cySpeed;
        if (cyPlayhead >= realNow) { cyPlayhead = realNow; cyGoLive(); }
    }
    const T = cyPlayhead;

    cyUpdateCamera(dt);
    if (cyStars) cyStars.rotation.y += dt * 0.01;

    // core + internet idle motion
    if (cyCore) {
        cyCore.userData.inner.rotation.y += dt * 0.5;
        cyCore.userData.shell.rotation.x -= dt * 0.2;
        const pulse = 1 + Math.sin(realNow * 2) * 0.04;
        cyCore.scale.setScalar(pulse);
        // stored-data shards swirl inside the core
        cyCoreShardGroup.rotation.y += dt * 0.45;
        cyCoreShards.forEach(s => {
            s.rotation.x += dt * s.userData.spin;
            s.rotation.y += dt * s.userData.spin * 0.7;
            if (s.scale.x < 1) s.scale.setScalar(Math.min(1, s.scale.x + dt * 2.5));
        });
    }
    if (cyInternet) cyInternet.userData.ring.rotation.z += dt * 0.3;

    // reconstruct scene state at T
    const sessions = cySessionsAt(T);
    let target = null;          // active node the drone services
    cyNodes.forEach(n => {
        if (!n.grp) return;
        const visible = n.discovered <= T + 0.001;
        n.targetScale = visible ? 1 : 0.01;
        const st = visible ? cyStatusAt(n, T) : 'down';
        n.bodyStatus = st;
        if (st === 'attack' || (st === 'scanning' && !target)) {
            if (st === 'attack') target = n; else if (!target) target = n;
        }
    });
    // prefer an attack target over a scan target
    let attackNode = null; cyNodes.forEach(n => { if (n.bodyStatus === 'attack') attackNode = n; });
    if (attackNode) target = attackNode;

    // animate nodes
    const ownedNodes = [];
    cyNodes.forEach(n => {
        if (!n.grp) return;
        const col = CY_STATUS_COLORS[n.bodyStatus] || CY_STATUS_COLORS.up;
        n.curColor.lerp(new THREE.Color(col), 0.12);
        n.mesh.material.color.copy(n.curColor);
        n.glow.material.color.copy(n.curColor);
        n.glow.material.opacity = (n.bodyStatus === 'down') ? 0.15 : 0.6;
        // bob + spin + warp-in scale
        const sc = n.grp.scale.x + (n.targetScale - n.grp.scale.x) * 0.15;
        n.grp.scale.setScalar(sc);
        n.grp.position.set(
            n.basePos.x,
            n.basePos.y + Math.sin(realNow * 0.8 + n.phase) * 0.6,
            n.basePos.z);
        n.mesh.rotation.y += dt * 0.6; n.mesh.rotation.x += dt * 0.25;
        n.ring.rotation.z += dt * (n.bodyStatus === 'scanning' ? 1.8 : 0.4);
        if (n.bodyStatus === 'attack') {                      // shake under fire
            n.grp.position.x += Math.sin(realNow * 40) * 0.18;
            n.grp.position.z += Math.cos(realNow * 37) * 0.18;
        }
        const ownedNow = n.bodyStatus === 'owned';
        n.bot.material.opacity += ((ownedNow ? 0.95 : 0) - n.bot.material.opacity) * 0.1;
        if (ownedNow) {
            n.bot.rotation.y += dt * 3;
            n.bot.position.set(Math.cos(realNow * 2) * 0.6, Math.sin(realNow * 3) * 0.4, Math.sin(realNow * 2) * 0.6);
            ownedNodes.push(n);
        }
    });

    // drone movement
    cyClearBeams();
    let dronePos;
    if (target) {
        const tp = target.grp.position;
        dronePos = new THREE.Vector3(tp.x, tp.y + 3.5, tp.z + 3.5);
    } else if (ownedNodes.length) {
        const o = ownedNodes[0].grp.position; dronePos = new THREE.Vector3(o.x, o.y + 3, o.z + 3);
    } else {
        const a = realNow * 0.5; dronePos = new THREE.Vector3(Math.cos(a) * 10, 9, Math.sin(a) * 10);
    }
    cyDrone.position.lerp(dronePos, 0.06);
    cyDrone.userData.body.rotation.y += dt * 2.5;
    cyDrone.userData.body.rotation.x += dt * 1.5;
    cyDroneTrailPush(cyDrone.position);

    // attack / scan beams from drone to target's ports
    if (target) {
        const col = target.bodyStatus === 'attack' ? 0xef4444 : 0xf59e0b;
        const flick = 0.4 + Math.abs(Math.sin(realNow * 12)) * 0.5;
        const dots = target.ring.children.length ? target.ring.children : [target.mesh];
        dots.slice(0, 6).forEach(d => {
            const wp = new THREE.Vector3(); d.getWorldPosition(wp);
            cyBeam(cyDrone.position.clone(), wp, col, flick);
        });
        // pivot beam: if owned host elsewhere, show traffic owned -> target
        if (ownedNodes.length) {
            const piv = ownedNodes.find(o => o.ip !== target.ip);
            if (piv) cyBeam(piv.grp.position.clone(), target.grp.position.clone(), 0x4ade80, 0.5 + Math.sin(realNow*6)*0.2);
        }
    }

    // emit packets. live: spawn each newly-arrived event; replay: as the playhead crosses it
    if (cyLiveMode) {
        while (cyLiveSeen < cyPktEvents.length) cySpawnEventPacket(cyPktEvents[cyLiveSeen++]);
    } else if (cyPlaying) {
        cyEmitReplayUpTo(T);
    }

    cyUpdatePackets(dt);
    cyUpdatePanels(dt);
    cyHud(T, sessions, target);
    cyRenderer.render(cyScene, cyCamera);
}

function cyDroneTrailPush(p) {
    cyTrailPts.push(p.clone());
    if (cyTrailPts.length > 40) cyTrailPts.shift();
    const arr = cyDroneTrail.geometry.attributes.position.array;
    for (let i = 0; i < 40; i++) {
        const v = cyTrailPts[i] || cyTrailPts[0] || p;
        arr[i*3] = v.x; arr[i*3+1] = v.y; arr[i*3+2] = v.z;
    }
    cyDroneTrail.geometry.attributes.position.needsUpdate = true;
}

function cyEmitReplayUpTo(T) {
    // replay: spawn packet animations for events with cyCursorT < t <= T
    if (T < cyCursorT) { cyCursorT = T; return; }   // scrubbed backward: don't replay
    for (const ev of cyPktEvents) {
        if (ev.t > cyCursorT && ev.t <= T) cySpawnEventPacket(ev);
    }
    cyCursorT = T;
}

// HUD + timeline controls
function cyHud(T, sessions, target) {
    const visCount = [...cyNodes.values()].filter(n => n.discovered <= T + 0.001).length;
    cySet('cy-stat-hosts', visCount);
    cySet('cy-stat-owned', sessions.size);
    // pkt/s
    const cut = performance.now() - 1000;
    cyPktTimes = cyPktTimes.filter(t => t > cut);
    cySet('cy-stat-pkts', cyPktTimes.length);

    const empty = document.getElementById('cy-empty');
    if (empty) empty.style.display = visCount ? 'none' : 'flex';

    // AI action readout
    const dot = document.getElementById('cy-action-dot');
    const act = document.getElementById('cy-action');
    let label = 'STANDBY', color = '#6b7280';
    if (cyLiveMode || cyPlaying) {
        if (target && target.bodyStatus === 'attack') { label = 'EXPLOITING ' + target.ip; color = '#ef4444'; }
        else if (target && target.bodyStatus === 'scanning') { label = 'SCANNING ' + target.ip; color = '#f59e0b'; }
        else if (sessions.size) { label = 'PIVOTING · ' + sessions.size + ' SHELL' + (sessions.size>1?'S':''); color = '#22c55e'; }
        else if (visCount) { label = 'RECON'; color = '#22d3ee'; }
    }
    if (act) { act.textContent = label; }
    if (dot) { dot.style.background = color; dot.style.boxShadow = '0 0 8px ' + color; }

    // timeline
    const realNow = Date.now() / 1000;
    const span = Math.max(realNow - cyT0, 1);
    const frac = Math.max(0, Math.min(1, (T - cyT0) / span));
    const scrub = document.getElementById('cy-scrub');
    if (scrub && !cyScrubbing) { scrub.value = Math.round(frac * 1000); scrub.style.setProperty('--cy-fill', (frac*100)+'%'); }
    cySet('cy-clock', cyFmt(T - cyT0) + ' / ' + cyFmt(span));

    const live = document.getElementById('cy-live');
    if (live) live.classList.toggle('cy-replaying', !cyLiveMode);
}
function cySet(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function cyFmt(s) { s = Math.max(0, Math.floor(s)); const m = (s/60)|0; return String(m).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }

let cyScrubbing = false;
function cyScrubInput(v) {
    cyScrubbing = true; cyLiveMode = false; cyPlaying = false;
    const realNow = Date.now() / 1000;
    const span = Math.max(realNow - cyT0, 1);
    cyPlayhead = cyT0 + (v / 1000) * span;
    cyCursorT = cyPlayhead;                 // don't retro-spawn packets while dragging
    const scrub = document.getElementById('cy-scrub');
    if (scrub) scrub.style.setProperty('--cy-fill', (v/10)+'%');
    cySetPlayIcon(false);
    clearTimeout(cyScrubTimer); cyScrubTimer = setTimeout(() => { cyScrubbing = false; }, 250);
}
let cyScrubTimer = null;
function cyTogglePlay() {
    if (cyLiveMode) { // pause live -> freeze at now and allow replay from here
        cyLiveMode = false; cyPlaying = false; cySetPlayIcon(false); return;
    }
    cyPlaying = !cyPlaying; cySetPlayIcon(cyPlaying);
}
function cySetSpeed(v) { cySpeed = parseFloat(v) || 1; }
function cyGoLive() {
    cyLiveMode = true; cyPlaying = false; cyScrubbing = false;
    cyPlayhead = Date.now() / 1000; cyCursorT = cyPlayhead;
    cyLiveSeen = cyPktEvents.length;        // don't replay backlog when snapping to live
    cySetPlayIcon(false);
}
function cySetPlayIcon(playing) {
    const i = document.getElementById('cy-play-icon');
    if (i) i.innerHTML = playing
        ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'    // pause
        : '<path d="M8 5v14l11-7z"/>';                 // play
}

// Host dossier panels: click a node to open a floating 3D info sheet, click again to close
function cyPick(clientX, clientY) {
    if (!cyRay || !cyRenderer || !cyVisible) return;
    const rect = cyRenderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1);
    cyRay.setFromCamera(ndc, cyCamera);
    const hits = [];
    cyNodes.forEach(n => { if (n.hit && n.grp && n.grp.scale.x > 0.5) hits.push(n.hit); });
    const isect = cyRay.intersectObjects(hits, false);
    if (isect.length) cyTogglePanel(isect[0].object.userData.ip);
}
function cyTogglePanel(ip) {
    if (cyPanels.has(ip)) { cyClosePanel(ip); return; }
    const n = cyNodes.get(ip);
    if (n && n.grp) cyMakePanel(n);
}
function cyClosePanel(ip) {
    const pa = cyPanels.get(ip); if (!pa) return;
    cyFxRoot.remove(pa.sprite); pa.tex.dispose(); pa.sprite.material.dispose();
    cyFxRoot.remove(pa.line); pa.line.geometry.dispose(); pa.line.material.dispose();
    cyPanels.delete(ip);
}
function cyHostInfoLines(n) {
    const out = [];
    out.push('IP    ' + n.ip);
    out.push('HOST  ' + (n.hostname || '-'));
    out.push('OS    ' + (n.os || 'Unknown'));
    out.push('MAC   ' + (n.mac && n.mac !== 'Unknown' ? n.mac : '-'));
    out.push('STATE ' + (n.up ? 'UP' : 'DOWN'));
    out.push('');
    const ports = n.ports || [];
    out.push('OPEN PORTS [' + ports.length + ']');
    ports.slice(0, 16).forEach(p => {
        const svc = p.service || '?';
        const detail = ((p.product || '') + ' ' + (p.version || '')).trim();
        out.push('  ' + (p.port + '/' + p.proto).padEnd(11) + svc + (detail ? '  ' + detail : ''));
    });
    if (ports.length > 16) out.push('  …+' + (ports.length - 16) + ' more');
    return out;
}
function cyMakePanel(n) {
    const lines = cyHostInfoLines(n);
    const W = 540, lineH = 30, padTop = 92, padBot = 26;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = padTop + lines.length * lineH + padBot;
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    spr.material.fog = false;
    const k = 0.034;                       // canvas px -> world units
    spr.scale.set(W * k, canvas.height * k, 1);
    const off = new THREE.Vector3(7, 6 + canvas.height * k * 0.5, 0);
    spr.position.copy(n.grp.position).add(off);
    cyFxRoot.add(spr);
    const lg = new THREE.BufferGeometry().setFromPoints([n.grp.position.clone(), spr.position.clone()]);
    const line = new THREE.Line(lg, new THREE.LineBasicMaterial({
        color: 0x22d3ee, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.material.fog = false;
    cyFxRoot.add(line);
    const pa = { ip: n.ip, node: n, sprite: spr, line, canvas, ctx: canvas.getContext('2d'),
                 tex, full: lines.join('\n'), lines, shown: 0, lastT: performance.now(),
                 offset: off, lineH, padTop };
    cyPanels.set(n.ip, pa);
    cyDrawPanel(pa);
}
function cyRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function cyDrawPanel(pa) {
    const ctx = pa.ctx, W = pa.canvas.width, H = pa.canvas.height;
    ctx.clearRect(0, 0, W, H);
    // body + border
    ctx.fillStyle = 'rgba(5,12,16,0.88)';
    cyRoundRect(ctx, 3, 3, W - 6, H - 6, 16); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(34,211,238,0.55)';
    cyRoundRect(ctx, 3, 3, W - 6, H - 6, 16); ctx.stroke();
    // header
    ctx.fillStyle = 'rgba(34,211,238,0.12)';
    cyRoundRect(ctx, 3, 3, W - 6, 60, 16); ctx.fill();
    ctx.fillStyle = '#67e8f9'; ctx.font = "bold 26px 'Fira Code', monospace";
    ctx.textBaseline = 'middle'; ctx.fillText('▸ HOST DOSSIER', 24, 34);
    ctx.fillStyle = 'rgba(34,211,238,0.5)'; ctx.font = "16px 'Fira Code', monospace";
    ctx.fillText('nmap', W - 78, 34);
    // typewriter body
    const revLines = pa.full.slice(0, pa.shown).split('\n');
    ctx.font = "22px 'Fira Code', monospace";
    for (let i = 0; i < revLines.length; i++) {
        const src = pa.lines[i] || '';
        ctx.fillStyle = src.startsWith('  ') ? '#9fe7f5'
            : (src.startsWith('OPEN PORTS') ? '#67e8f9' : '#d6eef6');
        ctx.fillText(revLines[i], 24, pa.padTop + i * pa.lineH);
    }
    // typing cursor
    if (pa.shown < pa.full.length) {
        const ci = revLines.length - 1;
        const cw = ctx.measureText(revLines[ci] || '').width;
        ctx.fillStyle = '#67e8f9';
        ctx.fillRect(24 + cw + 3, pa.padTop + ci * pa.lineH - 11, 11, 22);
    }
    pa.tex.needsUpdate = true;
}
function cyUpdatePanels() {
    const now = performance.now();
    cyPanels.forEach(pa => {
        if (pa.shown < pa.full.length) {
            pa.shown = Math.min(pa.full.length, pa.shown + Math.max(1, Math.round((now - pa.lastT) / 14)));
            cyDrawPanel(pa);
        }
        pa.lastT = now;
        if (pa.node && pa.node.grp) {           // stay glued to the bobbing node
            pa.sprite.position.copy(pa.node.grp.position).add(pa.offset);
            const a = pa.node.grp.position, b = pa.sprite.position;
            const arr = pa.line.geometry.attributes.position.array;
            arr[0] = a.x; arr[1] = a.y; arr[2] = a.z; arr[3] = b.x; arr[4] = b.y; arr[5] = b.z;
            pa.line.geometry.attributes.position.needsUpdate = true;
        }
    });
}

// Boot: the recorder always runs; rendering waits for the tab to open
cyPoll();
setInterval(cyPoll, CY_POLL_MS);
