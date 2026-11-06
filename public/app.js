// Light Type client, the sweep app. Wire contract: PROTOCOL.md ("Sweep channels").
// During a run the phone shows one narrow vertical strip of dot-matrix columns. The words scroll through the
// strip from right to left while the walker carries the phone sideways, so a long exposure records the line.
// A requestAnimationFrame loop reads serverNow() against a schedule that is identical on every phone; audio
// cues are scheduled on the AudioContext clock mapped to server time.
// Screens: INSTALL (browser tab on a phone) -> CHECK (once per phone) -> DIAL -> RUN (the stage).
'use strict';
(() => {
  const BUILD = '2026-11-06a';   // the same stamp is in sw.js; scripts/stamp.mjs sets both
  const $ = (id) => document.getElementById(id);
  // write text only when it changes: WebKit drops a tap on a button whose text node is replaced mid-tap
  const setText = (node, v) => { v = String(v); if (node.textContent !== v) node.textContent = v; };

  // ------------------------------------------------------------------ storage (prefix lts.; /simple uses lt.)
  const store = {
    get(k, d) { try { const v = localStorage.getItem('lts.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('lts.' + k, JSON.stringify(v)); } catch (e) {} },
  };
  const clampNum = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const clampInt = (v, lo, hi, d) => clampNum(Math.round(Number(v)), lo, hi, d);
  const randId = () => {
    try { const a = new Uint8Array(9); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); }
    catch (e) { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  };

  let clientId = store.get('id', null);
  if (!clientId) { clientId = randId(); store.set('id', clientId); }
  let myName = store.get('name', '');
  const display = Object.assign({ size: 98, level: 100 }, store.get('display', {}));
  const params = new URLSearchParams(location.search);
  let ch = clampInt(params.get('ch') || store.get('ch', 1), 1, 99, 1);

  // ------------------------------------------------------------------ state
  let S = null;              // channel state from the server (or the cached copy)
  let here = 0;
  let you = null;            // this socket's join order, from the server
  let partChoice = store.get('part.' + ch, null);   // chosen line in TOGETHER (null = default)
  let armed = false;
  let mode = 'dial';         // 'dial' | 'run' | 'test-light'
  let R = null;              // the active run
  let leftRunId = null;      // a run this phone left (do not rejoin it automatically)
  let testedOnce = false;

  // channels 1 and 2 are fixed; their words are built in so a phone with no signal still has them
  const FIXED = {
    1: 'I FEEL MYSELF THINKING\nI THINK MYSELF FEELING',
    2: 'I FEEL MYSELF THINKING\nI THINK MYSELF FEELING\nI AM MYSELF BECOMING',
  };
  const COLOURS = ['white', 'warm', 'yellow', 'cyan', 'magenta', 'cycle'];
  const DEFAULT_SETTINGS = { speed: 2, dir: 'alt', gap: 3, font: 'dot7', dots: 'round', light: 1, colour: 'white', caps: true, formation: 'one' };
  // the same clamping as the server, so a bad cached state cannot break a run
  function normSettings(st) {
    st = st || {};
    return {
      speed: clampNum(Math.round(Number(st.speed) * 10) / 10, 0.5, 5, 2),
      dir: ['ltr', 'rtl', 'alt'].includes(st.dir) ? st.dir : 'alt',
      gap: clampInt(st.gap, 0, 30, 3),
      font: st.font === 'vga16' ? 'vga16' : 'dot7',
      dots: st.dots === 'square' ? 'square' : 'round',
      light: clampInt(st.light, 1, 4, 1),
      colour: COLOURS.includes(st.colour) ? st.colour : 'white',
      caps: st.caps !== false,
      formation: st.formation === 'together' ? 'together' : 'one',
    };
  }
  function cachedState(c) {
    const s = store.get('state.' + c, null);
    const base = { ch: c, kind: 'sweep', text: FIXED[c] || 'LIGHT TYPE', locked: !!FIXED[c], settings: Object.assign({}, DEFAULT_SETTINGS), conductor: null, run: null };
    const out = Object.assign(base, s || {}, { cached: true });
    if (FIXED[c]) { out.text = FIXED[c]; out.locked = true; }
    return out;
  }
  function saveState() {
    if (!S) return;
    const { here: _h, now: _n, you: _y, cached: _c, t: _t, ...rest } = S;
    store.set('state.' + ch, rest);
  }

  // ------------------------------------------------------------------ clock
  const samples = [];        // {rtt, off} from the last 16 pongs
  let offset = 0, bestRtt = Infinity, synced = false;
  { const c = store.get('clock', null); if (c && Number.isFinite(c.offset)) { offset = c.offset; bestRtt = c.rtt || Infinity; } }
  const serverNow = () => Date.now() + offset;
  function onPong(m) {
    const now = Date.now(), rtt = now - m.c;
    if (!(rtt >= 0) || rtt > 10000) return;
    samples.push({ rtt, off: m.s - (m.c + rtt / 2) });
    while (samples.length > 16) samples.shift();
    let best = samples[0];
    for (const s of samples) if (s.rtt < best.rtt) best = s;
    offset = best.off; bestRtt = best.rtt; synced = true;
    lastPongAt = now;
    store.set('clock', { offset, rtt: bestRtt, at: now });
    renderSync();
  }

  // ------------------------------------------------------------------ socket
  let ws = null, wsOpen = false, backoff = 500, reconnectTimer = null, pingTimer = null, burstTimers = [];
  let lastPongAt = 0, watchdog = null;
  function wsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws?ch=' + ch + '&kind=sweep'; }
  function send(o) { if (ws && wsOpen) { try { ws.send(JSON.stringify(o)); return true; } catch (e) {} } return false; }
  function connect() {
    clearTimeout(reconnectTimer);
    if (ws) { const old = ws; ws = null; try { old.onclose = old.onmessage = old.onerror = null; old.close(); } catch (e) {} }
    wsOpen = false; renderConn();
    let sock;
    try { sock = new WebSocket(wsUrl()); } catch (e) { scheduleReconnect(); return; }
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      wsOpen = true; backoff = 500; renderConn();
      send({ t: 'hello', id: clientId, name: myName || undefined });
      pingBurst();
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ t: 'ping', c: Date.now() }), 10000);
    };
    sock.onmessage = (ev) => { if (ws !== sock) return; let m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMessage(m); };
    sock.onclose = () => { if (ws !== sock) return; wsOpen = false; ws = null; clearInterval(pingTimer); renderConn(); scheduleReconnect(); };
    sock.onerror = () => { try { sock.close(); } catch (e) {} };
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(8000, Math.round(backoff * 1.7));
  }
  function pingBurst() {
    burstTimers.forEach(clearTimeout); burstTimers = [];
    for (let i = 0; i < 8; i++) burstTimers.push(setTimeout(() => send({ t: 'ping', c: Date.now() }), i * 150));
  }
  // after a return from background the socket can look open but be dead: expect a pong within 2.5 s
  function checkAlive() {
    if (!ws || !wsOpen) { backoff = 500; connect(); return; }
    const asked = Date.now();
    pingBurst();
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { if (lastPongAt < asked) { backoff = 500; connect(); } }, 2500);
  }

  function onMessage(m) {
    switch (m.t) {
      case 'state': {
        if (!synced && typeof m.now === 'number') offset = m.now - Date.now();
        if (typeof m.here === 'number') here = m.here;
        if (m.you) you = m.you;
        if (textLocal()) m.text = el.text.value;
        S = m;
        // a setting changed here and not yet sent stays on screen
        if (Object.keys(stPending).length) S.settings = Object.assign({}, S.settings, stPending);
        saveState();
        renderDial();
        syncRun(S.run);
        break;
      }
      case 'pong': onPong(m); break;
      case 'run': if (S) { S.run = m.run; saveState(); } syncRun(m.run); renderDial(); break;
      case 'stop': if (S) { S.run = null; saveState(); } pending = null; remoteStop(); renderDial(); break;
      case 'here': here = m.here; renderPresence(); break;
      case 'error': onError(m); break;
    }
  }
  const ERR = {
    locked: 'This channel’s words are fixed.',
    too_long: 'Too long: 3 lines, 40 letters each.',
    running: 'A run is already going.',
    slow: 'Too many taps. Wait a moment.',
    conductor: 'Someone else is conducting.',
    empty: 'The words cannot be empty.',
  };
  function onError(m) { toast(ERR[m.code] || m.msg || m.code || 'error'); }

  // ------------------------------------------------------------------ text -> cells
  const seg = (window.Intl && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const graphemes = (s) => seg ? Array.from(seg.segment(s), (x) => x.segment) : Array.from(s);
  function splitLines(text, caps) {
    return String(text || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
      .map((s) => graphemes(caps ? s.toUpperCase() : s));
  }
  function defaultPart(nLines) {
    const o = you && Number.isFinite(you.order) ? you.order : 0;
    return nLines ? ((o % nLines) + nLines) % nLines : 0;
  }
  function myPart(nLines) {
    if (!nLines) return 0;
    if (partChoice != null && partChoice < nLines) return partChoice;
    return defaultPart(nLines);
  }
  const isPlain = (c) => /^[\x20-\x7e]$/.test(c);

  // ------------------------------------------------------------------ bitmaps
  // A glyph is an array of columns; each column lists its lit rows (0 = top).
  // dot7: cells 6 columns (5 + 1 blank), 7 rows, row 7 for descenders. vga16: cells 9 x 16.
  const FONT = { dot7: { cc: 6, gw: 5, gh: 7 }, vga16: { cc: 9, gw: 9, gh: 16 } };
  const DOT7 = globalThis.LT_DOT7 || {};
  const ALIAS = { '’': "'", '‘': "'", '‚': ',', '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '−': '-', '\u00a0': ' ' };
  // Px437 IBM VGA 9x16 covers ASCII and these (from its cmap); anything else falls back to the system font
  const VGA_EXTRA = ' ¡¢£¥§ª«¬°±²µ¶·º»¼½¿ÄÅÆÇÉÑÖÜßàáâäåæçèéêëìíîïñòóôö÷ùúûüÿƒΓΘΣΦΩαδεπστφ•‼ⁿ₧←↑→↓↔↕↨∙√∞∟∩≈≡≤≥⌂⌐⌠⌡─│┌┐└┘├┤┬┴┼═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬▀▄█▌▐░▒▓■▬▲►▼◄○◘◙☺☻☼♀♂♠♣♥♦♪♫';
  const vgaHas = (c) => isPlain(c) || (c.length === 1 && VGA_EXTRA.includes(c));
  const VGA_FAM = '"IBM VGA"';
  const SYS_FAM = '-apple-system, "Helvetica Neue", "Hiragino Sans", "Apple Symbols", system-ui, sans-serif';
  let vgaReady = false;
  let vgaMetric = { capTop: 2, base: 12 };   // rows of the VGA cap height, measured once the font loads
  const glyphCache = { dot7: new Map(), vga16: new Map() };
  const rc = document.createElement('canvas');
  const rctx = () => rc.getContext('2d', { willReadFrequently: true });

  const hasDesc = (c) => { const g = DOT7[ALIAS[c] || c]; return !!(g && g[7] && g[7].includes('#')); };
  function fromTable(g) {
    const cols = [];
    for (let x = 0; x < 5; x++) { const rs = []; g.forEach((row, r) => { if (row[x] === '#') rs.push(r); }); cols.push(rs); }
    return cols;
  }
  function rasterVGA(c) {
    rc.width = 9; rc.height = 16;
    const x = rctx();
    x.clearRect(0, 0, 9, 16);
    x.font = `16px ${VGA_FAM}`; x.textAlign = 'left'; x.textBaseline = 'alphabetic'; x.fillStyle = '#fff';
    x.fillText(c, 0, 12);                     // ascent 1200 of 1600 units: baseline 12 px down
    const d = x.getImageData(0, 0, 9, 16).data, cols = [];
    for (let i = 0; i < 9; i++) { const rs = []; for (let r = 0; r < 16; r++) if (d[(r * 9 + i) * 4 + 3] >= 128) rs.push(r); cols.push(rs); }
    return cols;
  }
  // a glyph the font lacks: drawn at 8x in the system font with its cap height on the letter rows,
  // area-averaged into the cell, threshold 0.45
  function rasterFallback(c, gw, gh, capTop, base) {
    const K = 8, W = gw * K, H = gh * K;
    rc.width = W; rc.height = H;
    const x = rctx();
    x.clearRect(0, 0, W, H);
    x.textAlign = 'left'; x.textBaseline = 'alphabetic'; x.fillStyle = '#fff';
    x.font = `100px ${SYS_FAM}`;
    const capH = x.measureText('H').actualBoundingBoxAscent || 70;
    const m = x.measureText(c);
    const L = m.actualBoundingBoxLeft || 0, Rr = m.actualBoundingBoxRight || m.width || 0;
    const A = m.actualBoundingBoxAscent || 0, D = m.actualBoundingBoxDescent || 0;
    const cols = Array.from({ length: gw }, () => []);
    if (L + Rr <= 0 || A + D <= 0) return cols;
    const k = Math.min(((base - capTop) * K) / capH, W / (L + Rr), H / (A + D)) * 0.98;
    x.font = `${100 * k}px ${SYS_FAM}`;
    let y = base * K;
    if (y - A * k < 0) y = A * k;
    if (y + D * k > H) y = H - D * k;
    x.fillText(c, (W - (L + Rr) * k) / 2 + L * k, y);
    const d = x.getImageData(0, 0, W, H).data;
    for (let i = 0; i < gw; i++) for (let r = 0; r < gh; r++) {
      let sum = 0;
      for (let yy = r * K; yy < (r + 1) * K; yy++) for (let xx = i * K; xx < (i + 1) * K; xx++) sum += d[(yy * W + xx) * 4 + 3];
      if (sum / (K * K * 255) >= 0.45) cols[i].push(r);
    }
    return cols;
  }
  function glyph(font, c) {
    c = ALIAS[c] || c;
    const cache = glyphCache[font];
    if (cache.has(c)) return cache.get(c);
    let cols;
    if (font === 'dot7') cols = DOT7[c] ? fromTable(DOT7[c]) : rasterFallback(c, 5, 7, 0, 7);
    else if (vgaHas(c)) cols = rasterVGA(c);
    else cols = rasterFallback(c, 9, 16, vgaMetric.capTop, vgaMetric.base);
    if (font === 'dot7' || vgaReady) cache.set(c, cols);
    return cols;
  }
  // one line as columns: cols[j] = lit rows, cell[j] = cell index
  function rasterLine(cells, font) {
    const F = FONT[font], n = cells.length, lineCols = n * F.cc - (F.cc - F.gw);
    const cols = new Array(lineCols), cell = new Int16Array(lineCols);
    for (let j = 0; j < lineCols; j++) { cols[j] = null; cell[j] = Math.floor(j / F.cc); }
    cells.forEach((c, k) => {
      if (c === ' ') return;
      const g = glyph(font, c);
      for (let i = 0; i < F.gw; i++) { const j = k * F.cc + i; if (j < lineCols && g[i] && g[i].length) cols[j] = g[i]; }
    });
    return { cols, cell, lineCols };
  }
  // the TEST pattern: a checkerboard of 8 squares in two rows, one blank cell, then a bar 4 cells long
  const TEST_SQUARES = 8, TEST_BAR = 4;
  function testLine(font, rows) {
    const F = FONT[font], side = Math.floor(rows / 2);
    const board = TEST_SQUARES * side, bar0 = board + F.cc, lineCols = bar0 + TEST_BAR * F.cc;
    const top = [], bottom = [], all = [];
    for (let r = 0; r < side; r++) { top.push(r); bottom.push(rows - side + r); }
    for (let r = 0; r < rows; r++) all.push(r);
    const cols = new Array(lineCols).fill(null), cell = new Int16Array(lineCols);
    for (let j = 0; j < lineCols; j++) {
      cell[j] = Math.floor(j / F.cc);
      if (j < board) cols[j] = Math.floor(j / side) % 2 === 0 ? top : bottom;
      else if (j >= bar0) cols[j] = all;
    }
    return { cols, cell, lineCols };
  }

  // ------------------------------------------------------------------ schedule (PROTOCOL.md "Sweep schedule")
  // Every phone computes the same times from run.startAt, run.text and run.settings.
  // u is the fractional column at the strip centre; column j's centre passes it at u = j + 0.5.
  function buildSchedule(run, part) {
    const st = normSettings(run.settings);
    const F = FONT[st.font], cc = F.cc, gapCols = cc - F.gw;
    const test = !!run.test;
    const L = test ? [] : splitLines(run.text, st.caps);
    const rowsOf = (lines) => st.font === 'vga16' ? 16 : (lines.some((ln) => ln.some(hasDesc)) ? 8 : 7);
    // a TEST uses the rows of the channel's words, so its dots have the pitch of a real run
    const rows = test ? rowsOf(splitLines(run.text, st.caps)) : rowsOf(L);
    const colRate = st.speed * cc;              // columns a second
    const light = st.light;
    const together = !test && st.formation === 'together';
    const t0 = run.startAt + 1000;
    const ev = [];
    for (let n = 5; n >= 1; n--) ev.push({ at: run.startAt - n * 1000, kind: 'count', c: String(n) });
    ev.push({ at: run.startAt, kind: 'go' });
    const lines = test ? [{ test: true }] : L;
    const segs = [];
    let tLine = t0, cellBase = 0;
    lines.forEach((cells, li) => {
      const lineCols = test ? testLine(st.font, rows).lineCols : cells.length * cc - gapCols;
      const n = test ? Math.ceil(lineCols / cc) : cells.length;
      const start = together ? t0 : tLine;
      const end = start + ((lineCols + light) / colRate) * 1000;
      const rtl = st.dir === 'rtl' || (!test && st.dir === 'alt' && li % 2 === 1);
      segs.push({ li, start, end, rtl, u0: rtl ? lineCols + light / 2 : -light / 2, lineCols, n, cells: test ? null : cells, test, cellBase: together ? 0 : cellBase });
      cellBase += n;
      if (!together) tLine = end + st.gap * 1000;
    });
    const p = Math.min(Math.max(0, part | 0), Math.max(0, segs.length - 1));
    const mine = together ? segs.filter((s) => s.li === p) : segs;
    const lastEnd = Math.max(t0, ...segs.map((s) => s.end));
    const end = lastEnd + 400;
    const beat = 1000 / st.speed;               // one cell, ms
    // a soft tick as the strip reaches each cell: ltr at its left edge, rtl at its right ink edge
    mine.forEach((s) => {
      for (let k = 0; k < s.n; k++) {
        const ub = s.rtl ? Math.min(s.lineCols, k * cc + F.gw) : k * cc;
        const c = s.test ? 'X' : s.cells[k];
        ev.push({ at: s.start + (Math.abs(ub - s.u0) / colRate) * 1000, kind: 'tick', c });
      }
    });
    if (!together) {
      segs.forEach((s, i) => {
        if (i < segs.length - 1) ev.push({ at: s.end, kind: 'line' });
        if (i > 0 && st.gap * 1000 >= 2 * beat) {
          const first = s.start + (light / 2 / colRate) * 1000;
          ev.push({ at: first - 2 * beat, kind: 'blip' }, { at: first - beat, kind: 'blip' });
        }
      });
    } else if (mine[0] && mine[0].end < lastEnd - 1) ev.push({ at: mine[0].end, kind: 'line' });
    ev.push({ at: end, kind: 'end' });
    ev.sort((a, b) => a.at - b.at);
    return { ev, segs, mine, end, dur: end - run.startAt, colRate, cc, light, rows, st, together, part: p, test };
  }
  // draw data for the segments this phone shows (needs the fonts; built once per run)
  function prepareDraw(sch) {
    sch.mine.forEach((s) => { const r = s.test ? testLine(sch.st.font, sch.rows) : rasterLine(s.cells, sch.st.font); s.cols = r.cols; s.cell = r.cell; });
  }

  // ------------------------------------------------------------------ geometry
  const MM_PER_PX = 0.16;      // an iPhone's CSS px on the glass, about
  const SMALL_H = 647;         // iPhone SE letter band in CSS px (667 less the status bar): in TOGETHER every phone uses this pitch, so lines match
  const level = () => Math.max(0.05, Math.min(1, (+display.level || 100) / 100));
  const frac = () => Math.max(0.2, Math.min(1, (+display.size || 98) / 100));
  function viewH() { return isLandscape() ? window.innerWidth : window.innerHeight; }
  // the letters stay inside the safe area: the status bar (clock, Dynamic Island, tape) and the home bar
  // would hide or cover the top and bottom rows of dots
  const insetProbe = document.createElement('div');
  insetProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(insetProbe);
  function insets() { const cs = getComputedStyle(insetProbe); return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 }; }
  function band(h) { const i = insets(), H = h || viewH(); return { top: i.top, h: Math.max(100, H - i.top - i.bottom) }; }
  function pitchFor(rows, together, h) {
    const own = band(h).h * frac() / rows;
    return together ? Math.min(own, SMALL_H * frac() / rows) : own;
  }

  // ------------------------------------------------------------------ drawing
  const EGA = { white: '#ffffff', warm: '#ffd7a0', yellow: '#ffff55', cyan: '#55ffff', magenta: '#ff55ff' };
  const CYCLE = ['#ffffff', '#55ffff', '#ff55ff', '#ffff55', '#55ff55', '#5555ff', '#ff5555'];
  const colourFor = (name, i) => name === 'cycle' ? CYCLE[i % CYCLE.length] : (EGA[name] || '#ffffff');
  const stage = $('stage'), gc = $('gc');
  let stageW = 0, stageH = 0;
  function sizeStage() {
    const dpr = window.devicePixelRatio || 1, r = stage.getBoundingClientRect();
    stageW = r.width; stageH = r.height;
    gc.style.width = `${r.width}px`; gc.style.height = `${r.height}px`;
    gc.width = Math.round(r.width * dpr); gc.height = Math.round(r.height * dpr);
    blank();
  }
  function blank() { const x = gc.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.fillStyle = '#000'; x.fillRect(0, 0, gc.width, gc.height); }
  // the countdown digit, dim grey, in the VGA font (before GO, so it never reaches the photo)
  function paintDigit(c, colour, alpha) {
    const dpr = window.devicePixelRatio || 1, x = gc.getContext('2d');
    blank();
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.font = `100px ${VGA_FAM}, ui-monospace, Menlo, monospace`;
    const m = x.measureText(c);
    const gw = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) || 50, gh = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || 70;
    const k = Math.min(stageW * 0.8 / gw, stageH * 0.5 / gh);
    x.font = `${100 * k}px ${VGA_FAM}, ui-monospace, Menlo, monospace`;
    const m2 = x.measureText(c);
    x.globalAlpha = alpha; x.fillStyle = colour;
    x.fillText(c, stageW / 2 - (m2.actualBoundingBoxRight - m2.actualBoundingBoxLeft) / 2, stageH / 2 + (m2.actualBoundingBoxAscent - m2.actualBoundingBoxDescent) / 2);
    x.globalAlpha = 1;
  }
  const FEATHER = 0.25;        // strip edge ramp, in pitches, centred on each edge
  // One frame of the strip. d: {cols, cell, cellBase, lineCols, rows, pitch, light, colour, dots, colRate, dtMs, alpha}.
  // Round dots are drawn narrower by the distance the phone moves in one frame, so they print round.
  function drawStrip(d, u, trace) {
    const dpr = window.devicePixelRatio || 1, x = gc.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.globalAlpha = 1; x.fillStyle = '#000'; x.fillRect(0, 0, stageW, stageH);
    const p = d.pitch, rows = d.rows, cx = stageW / 2, bd = d.band || band(stageH), top = bd.top + (bd.h - rows * p) / 2;
    // a strip wider than the screen is cut to the whole columns that fit (LIGHT WIDTH 4 at full height)
    const fe = FEATHER * p, light = Math.max(1, Math.min(d.light, Math.floor((stageW - fe) / p))), half = (light * p) / 2;
    x.save();
    x.beginPath(); x.rect(cx - half - fe / 2, top, 2 * half + fe, rows * p); x.clip();
    const round = d.dots === 'round';
    const dw = round ? Math.max(0.3 * p, 0.8 * p - (p * d.colRate * d.dtMs) / 1000) : p;
    const dh = round ? 0.8 * p : p;
    const reach = light / 2 + FEATHER + 1;
    const j0 = Math.max(0, Math.floor(u - reach)), j1 = Math.min(d.lineCols - 1, Math.ceil(u + reach));
    const dots = trace ? [] : null;
    x.globalAlpha = d.alpha;
    for (let j = j0; j <= j1; j++) {
      const rs = d.cols[j];
      if (!rs) continue;
      const xc = cx + (j + 0.5 - u) * p;
      x.fillStyle = colourFor(d.colour, d.cellBase + d.cell[j]);
      x.beginPath();
      for (const r of rs) {
        const yc = top + (r + 0.5) * p;
        if (round) { x.moveTo(xc + dw / 2, yc); x.ellipse(xc, yc, dw / 2, dh / 2, 0, 0, 2 * Math.PI); }
        else x.rect(xc - p / 2, yc - p / 2, p, p);
        if (dots) dots.push({ j, r, x: xc, y: yc });
      }
      x.fill();
    }
    // soft left and right edges, so a late frame does not leave a hard double edge in the photo
    x.globalAlpha = 1;
    for (const side of [-1, 1]) {
      const e = cx + side * half, a = e + side * fe / 2, b = e - side * fe / 2;
      const g = x.createLinearGradient(a, 0, b, 0);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(Math.min(a, b), top, fe, rows * p);
    }
    x.restore();
    return { u, pitch: p, cx, top, dw, dh, j0, j1, dots, light };
  }
  function showStage() {
    touching.clear();
    stage.hidden = false; sizeStage();
    try { if (stage.requestFullscreen && !document.fullscreenElement) stage.requestFullscreen().catch(() => {}); } catch (e) {}
  }
  function hideStage() {
    touching.clear();
    blank(); stage.hidden = true;
    try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
  }

  // ------------------------------------------------------------------ audio
  let ac = null;
  function audio() {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; } }
    if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} }
    return ac;
  }
  function unlockAudio() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    const a = audio(); if (!a) return;
    try { const b = a.createBuffer(1, 1, 22050), s = a.createBufferSource(); s.buffer = b; s.connect(a.destination); s.start(0); } catch (e) {}
  }
  const liveNodes = new Set();
  // f Hz, dur s, at = AudioContext time (absolute)
  function tone(f, dur, at, gain = 0.25, type = 'sine') {
    const a = ac; if (!a) return;
    const t0 = Math.max(at, a.currentTime);
    const o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
    liveNodes.add(o); o.onended = () => liveNodes.delete(o);
  }
  function stopAllTones() { liveNodes.forEach((o) => { try { o.stop(); } catch (e) {} }); liveNodes.clear(); }
  const CUE = {
    count: (t) => tone(880, 0.12, t),
    go: (t) => tone(440, 0.6, t, 0.3),
    // the walking metronome: one soft tick per cell (letter high, space low, face glyph between)
    tick: (t, e) => e.c === ' ' ? tone(520, 0.06, t, 0.08) : isPlain(e.c) ? tone(1400, 0.05, t, 0.09) : tone(1000, 0.06, t, 0.09),
    line: (t) => { tone(523, 0.12, t, 0.22); tone(659, 0.12, t + 0.18, 0.22); tone(784, 0.18, t + 0.36, 0.22); },
    blip: (t) => tone(880, 0.08, t, 0.2),
    end: (t) => { tone(660, 0.35, t, 0.25); tone(440, 0.6, t + 0.38, 0.25); },
  };
  // map server ms -> AudioContext seconds, so a cue is heard on its beat
  let map = null;
  function makeMap() {
    const a = ac; if (!a) return null;
    let ctxT = a.currentTime, srvT = serverNow();
    try {
      const ts = a.getOutputTimestamp && a.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) { ctxT = ts.contextTime; srvT = serverNow() - (performance.now() - ts.performanceTime); }
      else if (a.outputLatency) { srvT += a.outputLatency * 1000; }
    } catch (e) {}
    return { ctxT, srvT };
  }
  const acAt = (srv) => map.ctxT + (srv - map.srvT) / 1000;

  // ------------------------------------------------------------------ the run
  const log = [];
  const LEAD = 7000;           // the stage goes black this long before GO
  const TAIL_END = 6000;       // black after the end tone, so nothing lights the photo while the shutter closes
  const TAIL_STOP = 3000;      // black after a stop
  let pending = null, waitTimer = null;
  const runEnd = (run) => buildSchedule(run, 0).end;
  function syncRun(run) {
    if (!run) {
      if (pending && !pending.local) pending = null;
      if (R && !R.run.local && !R.tailUntil && serverNow() < R.sch.end) remoteStop();
      renderWait(); return;
    }
    if (R && R.run.id === run.id) return;
    if (run.id === leftRunId) return;
    if (serverNow() > runEnd(run) + 200) return;
    if (run.startAt - serverNow() > LEAD) { pending = run; watchPending(); renderWait(); return; }
    if (pending && pending.id === run.id) pending = null;
    renderWait();
    startRun(run);               // a phone nobody has touched yet still lights, without sound
  }
  function watchPending() {
    if (waitTimer) return;
    waitTimer = setInterval(() => {
      if (!pending) { clearInterval(waitTimer); waitTimer = null; renderWait(); return; }
      if (pending.startAt - serverNow() <= LEAD) { const r = pending; pending = null; syncRun(r); }
      else renderWait();
    }, 250);
  }
  function startLocal(at, extra) {
    if (!S) return;
    const run = Object.assign({ id: 'local-' + randId(), startAt: Math.round(at), text: S.text, settings: normSettings(S.settings), local: true }, extra || {});
    leftRunId = null;
    syncRun(run);
  }
  // the next whole minute of server time, at least 15 s ahead
  function nextMinute() { const n = serverNow(); let t = Math.ceil(n / 60000) * 60000; if (t - n < 15000) t += 60000; return t; }
  const hhmmss = (srv) => { const d = new Date(srv - offset); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); };
  function startRun(run) {
    closeKeyboard();
    const nLines = splitLines(run.text, normSettings(run.settings).caps).length;
    const part = myPart(nLines);
    const sch = buildSchedule(run, part);
    prepareDraw(sch);
    audio(); keepAwake();
    map = makeMap();
    const now = serverNow();
    let cue = 0; while (cue < sch.ev.length && sch.ev[cue].at < now - 60) cue++;   // late join: skip cues already past
    const tok = {};
    R = { run, sch, part, cue, si: 0, key: null, lastMapCheck: 0, tok, tailUntil: 0, segLogged: -1, pitch: 0, lastDraw: null };
    mode = 'run';
    if (run.test) testedOnce = true;
    hideOverlays();
    showStage();
    R.pitch = pitchFor(sch.rows, sch.together, stageH); R.band = band(stageH);
    log.push({ ev: 'start', run: run.id, part, serverT: now, perf: performance.now() });
    requestAnimationFrame(() => frame(tok));
  }
  // a frame drawn now reaches the glass at the next vsync: look ahead half a frame so the
  // display error is centred on the schedule instead of always one frame late
  let lastFrameAt = 0, frameDt = 16.7;
  function frame(tok) {
    if (!R || R.tok !== tok) return;
    const pnow = performance.now();
    if (lastFrameAt) { const d = pnow - lastFrameAt; if (d > 4 && d < 50) frameDt = frameDt * 0.9 + d * 0.1; }
    lastFrameAt = pnow;
    const real = serverNow(), now = real + Math.min(8, frameDt / 2), sch = R.sch, run = R.run;
    if (R.tailUntil) {
      if (R.key !== 'black') { blank(); R.key = 'black'; }
      if (real >= R.tailUntil) { finishRun(); return; }
      requestAnimationFrame(() => frame(tok)); return;
    }
    let key = 'black';
    if (now >= run.startAt - 5000 && now < run.startAt) {
      const n = Math.min(5, Math.ceil((run.startAt - now) / 1000));
      key = 'count' + n;
      if (key !== R.key) paintDigit(String(n), '#aaaaaa', 0.55 * level());
    } else if (now >= run.startAt) {
      while (R.si < sch.mine.length && sch.mine[R.si].end <= now) R.si++;
      const s = sch.mine[R.si];
      if (s && now >= s.start) {
        const du = (sch.colRate * (now - s.start)) / 1000;
        const u = s.rtl ? s.u0 - du : s.u0 + du;
        const dr = drawStrip({ cols: s.cols, cell: s.cell, cellBase: s.cellBase, lineCols: s.lineCols, rows: sch.rows, pitch: R.pitch,
          light: sch.light, colour: sch.st.colour, dots: sch.st.dots, colRate: sch.colRate, dtMs: frameDt, alpha: level(), band: R.band }, u, !!api.trace);
        R.lastDraw = Object.assign(dr, { now, real, li: s.li, wall: Date.now() });
        key = 'strip';
        if (R.segLogged !== s.li) { R.segLogged = s.li; log.push({ ev: 'seg', li: s.li, due: s.start, serverT: real, now, wall: Date.now(), run: run.id }); }
      }
    }
    if (key === 'black' && R.key !== 'black') blank();
    if (key !== R.key) {
      log.push({ ev: 'show', key, serverT: real, perf: performance.now(), run: run.id });
      if (log.length > 2000) log.splice(0, log.length - 2000);
      R.key = key;
    }
    // audio: keep the map honest, schedule cues up to 1.2 s ahead
    if (ac) {
      if (!map) map = makeMap();
      if (now - R.lastMapCheck > 500) {
        R.lastMapCheck = now;
        const m2 = makeMap();
        if (m2 && Math.abs((m2.ctxT - map.ctxT) - (m2.srvT - map.srvT) / 1000) > 0.02) map = m2;
      }
      while (R.cue < sch.ev.length && sch.ev[R.cue].at <= now + 1200) {
        const e = sch.ev[R.cue++];
        if (e.at < now - 60) continue;
        CUE[e.kind](acAt(e.at), e);
      }
    }
    if (typeof api.onFrame === 'function') { try { api.onFrame(R); } catch (e) {} }
    if (now > sch.end + TAIL_END) { finishRun(); return; }
    requestAnimationFrame(() => frame(tok));
  }
  function finishRun() { if (!R) return; log.push({ ev: 'end', run: R.run.id, serverT: serverNow() }); R = null; backToDial(); }
  function remoteStop() {
    if (!R || R.tailUntil) return;
    stopAllTones();
    log.push({ ev: 'stopped', run: R.run.id, serverT: serverNow() });
    R.tailUntil = serverNow() + TAIL_STOP;
  }
  function leaveRun() {
    if (R) { leftRunId = R.run.id; stopAllTones(); log.push({ ev: 'left', run: R.run.id, serverT: serverNow() }); R = null; backToDial(); }
  }
  function backToDial() { hideStage(); mode = 'dial'; renderDial(); renderTurn(); }
  // the server holds a run until startAt + dur + 1500 ms: match it so START is not refused
  function runActive() {
    if (!S || !S.run) return false;
    const end = Number.isFinite(S.run.dur) ? S.run.startAt + S.run.dur : runEnd(S.run);
    return serverNow() < end + 1600;
  }

  // stage input: a walker's thumbs rest on the glass, so leaving takes three fingers held for 2 s
  let holdTimer = null;
  const touching = new Set();
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    touching.add(e.pointerId);
    if (touching.size >= 3 && !holdTimer) holdTimer = setTimeout(() => { holdTimer = null; leaveRun(); }, 2000);
  });
  const release = (e) => {
    touching.delete(e && e.pointerId);
    if (mode === 'test-light') { endTestLight(); return; }
    if (touching.size < 3) { clearTimeout(holdTimer); holdTimer = null; }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (!stage.hidden) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => { if (!stage.hidden && e.key === 'Escape') leaveRun(); });

  // ------------------------------------------------------------------ wake
  let wake = null;
  const vid = $('wakeVid');
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !(wake && !wake.released)) wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
    try { const p = vid.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
  }

  // ------------------------------------------------------------------ first touch: sound and wake
  function arm() {
    unlockAudio();
    keepAwake();
    armed = true;
    // Android installed apps can lock portrait; iOS ignores this (rotation lock is in Control Centre)
    try { if (isStandalone() && screen.orientation && screen.orientation.lock) screen.orientation.lock('portrait').catch(() => {}); } catch (e) {}
    $('soundBar').hidden = true;
    renderDial();
    if (S && S.run) syncRun(S.run);
    if (pending) syncRun(pending);
  }
  let lastInputAt = 0;
  // the first touch anywhere turns sound on (iOS needs a gesture) and keeps the screen awake
  document.addEventListener('pointerdown', () => { lastInputAt = Date.now(); if (!armed) arm(); }, true);

  // ------------------------------------------------------------------ DIAL
  const el = {
    dot: $('dot'), here: $('here'), sync: $('sync'), chNum: $('chNum'), chName: $('chName'), text: $('text'), textNote: $('textNote'),
    sign: $('sign'), pv: $('pv'), pvRows: $('pvRows'), spVal: $('spVal'), spWalk: $('spWalk'), spDown: $('spDown'), spUp: $('spUp'),
    fOne: $('fOne'), fTog: $('fTog'), partRow: $('partRow'), partSeg: $('partSeg'),
    dirSeg: $('dirSeg'), fontSeg: $('fontSeg'), dotsSeg: $('dotsSeg'), lightSeg: $('lightSeg'),
    gap: $('gap'), colour: $('colour'), caps: $('caps'), size: $('size'), level: $('level'),
    start: $('startBtn'), test: $('testBtn'), testNote: $('testNote'), runRow: $('runRow'), rejoin: $('rejoinBtn'), stop: $('stopBtn'), startNote: $('startNote'),
    conduct: $('conductBtn'), name: $('name'), shareUrl: $('shareUrl'), qr: $('qr'), toast: $('toast'),
    wait: $('wait'), waitT: $('waitT'), waitIn: $('waitIn'), minute: $('minuteBtn'), atTime: $('atTime'), atBtn: $('atBtn'),
  };
  el.name.value = myName;
  el.size.value = display.size; el.level.value = display.level;
  $('build').textContent = 'build ' + BUILD;

  const conductorOther = () => wsOpen && S && !S.cached && S.conductor && S.conductor.id !== clientId;
  const iConduct = () => S && S.conductor && S.conductor.id === clientId;

  function renderConn() {
    el.dot.classList.toggle('off', !wsOpen);
    el.dot.setAttribute('aria-label', wsOpen ? 'online' : 'offline');
    renderPresence();
    renderStartState();
  }
  function renderPresence() {
    if (!wsOpen) { setText(el.here, 'no signal · saved words'); return; }
    setText(el.here, here === 1 ? '1 phone here' : `${here} phones here`);
  }
  function renderSync() {
    setText(el.sync, synced ? `sync ${offset >= 0 ? '+' : ''}${Math.round(offset)} ms · rtt ${Math.round(bestRtt)} ms` : 'sync …');
  }
  function renderChannel() {
    if (document.activeElement !== el.chNum) el.chNum.value = String(ch);
    setText(el.chName, ch === 1 ? 'THE VERSE' : ch === 2 ? 'THE VERSE, THREE LINES' : 'OPEN CHANNEL');
    setText(el.shareUrl, `${location.host}/?ch=${ch}`);
    renderQR(`${location.origin}/?ch=${ch}`);
  }
  let qrFor = null;
  function renderQR(url) {
    if (qrFor === url || typeof qrcode !== 'function') return;
    qrFor = url;
    try { const q = qrcode(0, 'M'); q.addData(url); q.make(); el.qr.innerHTML = q.createSvgTag({ cellSize: 5, margin: 0, scalable: true }); }
    catch (e) { setText(el.qr, ''); }
  }
  const press = (box, v) => Array.from(box.children).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
  let textDirtyUntil = 0;
  // an edit on this phone not yet sent, or sent less than 1.5 s ago, wins over an older server state
  const textLocal = () => !!S && !S.locked && (!!setTimer || Date.now() < textDirtyUntil);
  function renderDial() {
    renderChannel(); renderPresence(); renderSync();
    if (!S) { renderStartState(); return; }
    const locked = !!S.locked || ch === 1 || ch === 2, other = conductorOther();
    el.text.readOnly = locked;
    el.text.disabled = !locked && other;
    el.sign.hidden = locked; el.sign.disabled = !!other;
    if (!textLocal() && el.text.value !== S.text) el.text.value = S.text || '';
    setText(el.textNote, locked ? `These words are fixed on channel ${ch}.` : other ? '' : 'Up to 3 lines. Everyone on this channel sees edits.');
    const st = normSettings(S.settings);
    const tog = st.formation === 'together';
    el.fOne.setAttribute('aria-pressed', String(!tog)); el.fTog.setAttribute('aria-pressed', String(tog));
    press(el.dirSeg, st.dir); press(el.fontSeg, st.font); press(el.dotsSeg, st.dots); press(el.lightSeg, st.light);
    const L = splitLines(S.text, st.caps);
    el.partRow.hidden = !tog;
    if (tog) {
      const p = myPart(L.length), want = L.length || 1;
      if (el.partSeg.children.length !== want) {
        el.partSeg.innerHTML = '';
        for (let i = 0; i < want; i++) {
          const b = document.createElement('button'); b.type = 'button'; b.textContent = String(i + 1);
          b.addEventListener('click', () => { partChoice = i; store.set('part.' + ch, i); renderDial(); });
          el.partSeg.appendChild(b);
        }
      }
      Array.from(el.partSeg.children).forEach((b, i) => b.setAttribute('aria-pressed', String(i === p)));
    }
    setIfIdle(el.gap, st.gap); setIfIdle(el.colour, st.colour);
    if (document.activeElement !== el.caps) el.caps.checked = st.caps;
    const shared = [el.fOne, el.fTog, el.gap, el.colour, el.caps, el.spDown, el.spUp,
      ...el.dirSeg.children, ...el.fontSeg.children, ...el.dotsSeg.children, ...el.lightSeg.children];
    shared.forEach((x) => x.disabled = !!other);
    renderSpeed(st, L);
    renderPreview(st, L);
    renderStartState();
  }
  function setIfIdle(input, v) { if (v != null && document.activeElement !== input && String(input.value) !== String(v)) input.value = v; }
  function rowsFor(st, L) { return st.font === 'vga16' ? 16 : (L.some((ln) => ln.some(hasDesc)) ? 8 : 7); }
  function renderSpeed(st, L) {
    setText(el.spVal, st.speed.toFixed(1));
    const p = pitchFor(rowsFor(st, L), st.formation === 'together');
    const cm = st.speed * FONT[st.font].cc * p * MM_PER_PX / 10;
    setText(el.spWalk, `Walk about ${Math.round(cm)} cm a second.`);
  }
  // the preview: each line as the photo shows it, and its length and time on this phone
  const fmtM = (cols, p) => (cols * p * MM_PER_PX / 1000).toFixed(1);
  function renderPreview(st, L) {
    const sch = buildSchedule({ startAt: 0, text: S.text, settings: st }, myPart(L.length));
    const tsch = buildSchedule({ startAt: 0, text: S.text, settings: st, test: true }, 0);
    const pRun = pitchFor(sch.rows, sch.together);
    // where each line sits in the photo, in columns: with ⇄ each line starts where the last one ended
    const xs = []; let pos = 0;
    sch.segs.forEach((s) => {
      if (!sch.together && st.dir === 'alt') { if (s.rtl) { pos -= s.lineCols; xs.push(pos); } else { xs.push(pos); pos += s.lineCols; } }
      else xs.push(s.rtl ? -s.lineCols : 0);
    });
    const minX = Math.min(0, ...xs), maxX = Math.max(1, ...sch.segs.map((s, i) => xs[i] + s.lineCols));
    const cv = el.pv, box = cv.parentElement, dpr = window.devicePixelRatio || 1;
    // the box's content width (it has 10 px padding and a 2 px border); a hidden dial falls back to the window
    const cw = Math.max(100, (box.clientWidth ? box.clientWidth - 20 : Math.min(560, window.innerWidth) - 56));
    const pp = Math.min(6, cw / (maxX - minX)), lineGap = Math.max(6, pp * 3);
    const h = Math.max(1, sch.segs.length) * sch.rows * pp + Math.max(0, sch.segs.length - 1) * lineGap;
    cv.style.width = `${cw}px`; cv.style.height = `${Math.ceil(h)}px`;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(Math.ceil(h) * dpr);
    const x = cv.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.fillStyle = '#000'; x.fillRect(0, 0, cw, h);
    sch.segs.forEach((s, i) => {
      const r = rasterLine(s.cells, st.font), x0 = (xs[i] - minX) * pp, y0 = i * (sch.rows * pp + lineGap);
      x.globalAlpha = sch.together && i !== sch.part ? 0.45 : 1;
      for (let j = 0; j < r.lineCols; j++) {
        const rs = r.cols[j]; if (!rs) continue;
        x.fillStyle = colourFor(st.colour, s.cellBase + r.cell[j]);
        x.beginPath();
        for (const row of rs) {
          const cxp = x0 + (j + 0.5) * pp, cyp = y0 + (row + 0.5) * pp;
          if (st.dots === 'round') { x.moveTo(cxp + pp * 0.4, cyp); x.arc(cxp, cyp, pp * 0.4, 0, 2 * Math.PI); }
          else x.rect(cxp - pp / 2, cyp - pp / 2, pp, pp);
        }
        x.fill();
      }
    });
    x.globalAlpha = 1;
    const rowsTxt = sch.segs.map((s, i) => {
      const mineMark = sch.together && i === sch.part ? '  ← MY LINE' : '';
      return `LINE ${i + 1}  ${s.rtl ? '←' : '→'}  ${fmtM(s.lineCols, pRun).padStart(4)} m  ${String(Math.round((s.end - s.start) / 1000)).padStart(3)} s${mineMark}`;
    });
    const ts = tsch.segs[0];
    rowsTxt.push(`TEST    ${ts.rtl ? '←' : '→'}  ${fmtM(ts.lineCols, pitchFor(tsch.rows, sch.together)).padStart(4)} m  ${String(Math.round((ts.end - ts.start) / 1000)).padStart(3)} s`);
    rowsTxt.push(`TOTAL           ${String(Math.round(sch.dur / 1000)).padStart(4)} s`);
    setText(el.pvRows, rowsTxt.join('\n'));
  }
  function renderStartState() {
    const other = conductorOther(), active = wsOpen && !!runActive(), mine = iConduct();
    const waiting = !!(pending && !pending.local) && pending.startAt - serverNow() > LEAD;
    let note = '', disabled = false, label = 'START';
    if (!S) { disabled = true; note = 'Joining channel…'; }
    else if (!wsOpen) { note = 'No signal: START runs on this phone only. To start phones together, use START ON THE NEXT MINUTE under MORE.'; }
    else if (other) { disabled = true; note = `Conducted by ${S.conductor.name || 'someone'}.`; }
    else if (waiting && !mine) { disabled = true; note = `Set for ${hhmmss(pending.startAt)}.`; }
    else if (active && !mine) { disabled = true; note = 'A run is going.'; }
    else if (active && mine) { label = 'RESTART'; }
    setText(el.start, label); el.start.disabled = disabled;
    el.test.disabled = !S || !!R;
    setText(el.startNote, note); el.startNote.className = 'note' + (other ? ' warn' : '');
    el.testNote.hidden = !testedOnce;
    el.runRow.hidden = !((active || (pending && !pending.local)) && mode === 'dial');
    el.stop.disabled = !!other;
    setText(el.stop, wsOpen ? 'STOP FOR ALL' : 'SKIP ON THIS PHONE');
    el.minute.disabled = !S || !!other || (active && !mine);
    el.atBtn.disabled = !S || !wsOpen || !!other || (active && !mine);
    el.conduct.setAttribute('aria-pressed', String(!!mine));
    el.conduct.disabled = !!other || !wsOpen;
    setText(el.conduct, mine ? 'CONDUCTING · TAP TO LET GO' : other ? `CONDUCTED BY ${(S.conductor.name || 'someone').toUpperCase()}` : 'I’M CONDUCTING THIS CHANNEL');
  }

  // channel dial
  let chTimer = null;
  function setChannel(n, now) {
    n = clampInt(n, 1, 99, ch);
    if (n === ch && !now) { renderChannel(); return; }
    flushSettings(); flushText(); textDirtyUntil = 0;
    ch = n; store.set('ch', ch); partChoice = store.get('part.' + ch, null); you = null; pending = null;
    try { const u = new URL(location.href); u.searchParams.set('ch', String(ch)); u.searchParams.delete('source'); history.replaceState(null, '', u); } catch (e) {}
    S = cachedState(ch); renderDial(); if (S.run) syncRun(S.run);
    clearTimeout(chTimer);
    chTimer = setTimeout(() => { backoff = 500; connect(); }, now ? 0 : 350);
  }
  $('chDown').addEventListener('click', () => setChannel(ch <= 1 ? 99 : ch - 1));
  $('chUp').addEventListener('click', () => setChannel(ch >= 99 ? 1 : ch + 1));
  el.chNum.addEventListener('focus', () => { setTimeout(() => { try { el.chNum.select(); } catch (e) {} }, 0); });
  el.chNum.addEventListener('input', () => { el.chNum.value = el.chNum.value.replace(/\D/g, '').slice(0, 2); });
  el.chNum.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.chNum.blur(); });
  el.chNum.addEventListener('change', () => setChannel(el.chNum.value || ch));
  el.chNum.addEventListener('blur', () => { if (el.chNum.value !== String(ch)) setChannel(el.chNum.value || ch); });

  // words
  let setTimer = null;
  function cleanText(v) {
    let lines = v.split('\n');
    if (lines.length > 3) lines = lines.slice(0, 3);
    lines = lines.map((l) => { const g = graphemes(l); return g.length > 40 ? g.slice(0, 40).join('') : l; });
    return lines.join('\n').slice(0, 200);
  }
  function flushText() { if (setTimer) { clearTimeout(setTimer); setTimer = null; if (S && !S.locked) send({ t: 'set', text: el.text.value }); } }
  el.text.addEventListener('input', () => {
    const c = cleanText(el.text.value);
    if (c !== el.text.value) { const p = el.text.selectionStart; el.text.value = c; try { el.text.setSelectionRange(p, p); } catch (e) {} }
    textDirtyUntil = Date.now() + 1500;
    if (S) { S.text = el.text.value; saveState(); const st = normSettings(S.settings), L = splitLines(S.text, st.caps); renderSpeed(st, L); renderPreview(st, L); }
    clearTimeout(setTimer);
    setTimer = setTimeout(() => { setTimer = null; send({ t: 'set', text: el.text.value }); }, 400);
  });
  const SIGN = '༼つ◕‿◕‿◕༽つ';
  el.sign.addEventListener('click', () => {
    if (!S || S.locked || el.text.disabled) return;
    let v = el.text.value.replace(/\s+$/, '');
    if (v.includes(SIGN)) v = v.replace(' ' + SIGN, '').replace(SIGN, '').replace(/\s+$/, '');
    else v = v + ' ' + SIGN;
    el.text.value = v; el.text.dispatchEvent(new Event('input'));
  });
  el.text.addEventListener('blur', () => { if (setTimer) textDirtyUntil = Date.now() + 1500; flushText(); });

  // shared settings: shown at once, sent after a short pause; the server keeps them and tells every phone
  let stTimer = null, stPending = {};
  function setSetting(k, v, delay) {
    if (!S) return;
    stPending[k] = v;
    S.settings = Object.assign({}, S.settings, { [k]: v });
    saveState(); renderDial();
    clearTimeout(stTimer);
    stTimer = setTimeout(flushSettings, delay == null ? 60 : delay);
  }
  function flushSettings() {
    clearTimeout(stTimer); stTimer = null;
    if (!Object.keys(stPending).length) return;
    const p = stPending; stPending = {};
    send({ t: 'settings', settings: p });
  }
  el.fOne.addEventListener('click', () => setSetting('formation', 'one'));
  el.fTog.addEventListener('click', () => setSetting('formation', 'together'));
  const segWire = (box, k, conv) => Array.from(box.children).forEach((b) => b.addEventListener('click', () => setSetting(k, conv ? conv(b.dataset.v) : b.dataset.v)));
  segWire(el.dirSeg, 'dir'); segWire(el.fontSeg, 'font'); segWire(el.dotsSeg, 'dots'); segWire(el.lightSeg, 'light', Number);
  el.gap.addEventListener('change', () => setSetting('gap', clampInt(el.gap.value, 0, 30, 3), 300));
  el.colour.addEventListener('change', () => setSetting('colour', el.colour.value));
  el.caps.addEventListener('change', () => setSetting('caps', el.caps.checked));
  // speed stepper: 0.1 a tap, repeats while held
  let spHold = null;
  function stepSpeed(dir) {
    if (!S) return;
    const cur = normSettings(S.settings).speed;
    const v = Math.min(5, Math.max(0.5, Math.round((cur + dir * 0.1) * 10) / 10));
    if (v !== cur) setSetting('speed', v, 400);
  }
  [[el.spDown, -1], [el.spUp, 1]].forEach(([b, dir]) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault(); if (b.disabled) return;
      stepSpeed(dir);
      clearTimeout(spHold);
      const rep = () => { stepSpeed(dir); spHold = setTimeout(rep, 90); };
      spHold = setTimeout(rep, 450);
    });
    const stop = () => { clearTimeout(spHold); spHold = null; };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => b.addEventListener(t, stop));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  // this phone only
  el.size.addEventListener('change', () => { display.size = clampInt(el.size.value, 20, 100, 98); el.size.value = display.size; store.set('display', display); renderDial(); });
  el.level.addEventListener('change', () => { display.level = clampInt(el.level.value, 5, 100, 100); el.level.value = display.level; store.set('display', display); });

  // start / stop / rejoin. `dur` (startAt to end tone) is sent so the server holds the run as long as phones play it.
  const durNow = () => (S ? buildSchedule({ startAt: 0, text: S.text, settings: S.settings }, 0).dur : undefined);
  function sendStart(at) { flushText(); flushSettings(); return wsOpen && send(at ? { t: 'start', at, dur: durNow() } : { t: 'start', dur: durNow() }); }
  el.start.addEventListener('click', () => {
    unlockAudio(); keepAwake();
    leftRunId = null;
    if (!sendStart()) startLocal(serverNow() + 5400);   // no signal: this phone only
  });
  el.test.addEventListener('click', () => { unlockAudio(); keepAwake(); startLocal(serverNow() + 5400, { test: true, id: 'test-' + randId() }); });
  $('tryBtn').addEventListener('click', () => { unlockAudio(); keepAwake(); startLocal(serverNow() + 5400); });
  el.stop.addEventListener('click', () => {
    if (wsOpen && send({ t: 'stop' })) return;
    const r = pending || (S && S.run); if (r) leftRunId = r.id;          // no signal: skip it here
    pending = null; renderWait(); renderDial();
  });
  el.minute.addEventListener('click', () => {
    unlockAudio(); keepAwake(); leftRunId = null;
    const at = nextMinute();
    if (!sendStart(at)) startLocal(at);
    toast(`Starts at ${hhmmss(at)}`, true);
  });
  el.atBtn.addEventListener('click', () => {
    unlockAudio(); keepAwake();
    const v = el.atTime.value; if (!/^\d\d:\d\d/.test(v)) { toast('Pick a time first.'); return; }
    const [hh, mm] = v.split(':').map(Number);
    const d = new Date(); d.setHours(hh, mm, 0, 0);
    if (d.getTime() < Date.now() + 10000) d.setDate(d.getDate() + 1);
    const at = d.getTime() + offset;                                      // phone wall clock -> server time
    if (at - serverNow() > 6 * 3600 * 1000) { toast('Up to 6 hours ahead.'); return; }
    leftRunId = null;
    if (sendStart(at)) toast(`Set for ${hhmmss(at)} on every phone here`, true);
    else toast('Needs signal. Use START ON THE NEXT MINUTE outside.');
  });
  el.rejoin.addEventListener('click', () => { leftRunId = null; if (S && S.run) syncRun(S.run); });

  // conduct + name
  el.conduct.addEventListener('click', () => send({ t: 'conduct', on: !iConduct(), name: myName || undefined }));
  let nameTimer = null;
  el.name.addEventListener('input', () => {
    myName = el.name.value.slice(0, 24); store.set('name', myName);
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => {
      send({ t: 'hello', id: clientId, name: myName || undefined });
      if (iConduct()) send({ t: 'conduct', on: true, name: myName || undefined });
    }, 800);
  });
  $('setupBtn').addEventListener('click', () => show('check'));

  // any tap on the dial keeps the audio context alive
  $('dial').addEventListener('pointerdown', () => { if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} } }, { passive: true });

  function closeKeyboard() { const a = document.activeElement; if (a && a.blur && a !== document.body) a.blur(); }
  let toastTimer = null;
  function toast(msg, calm) {
    if (!stage.hidden) return;                 // anything lit during a run prints into the photo
    el.toast.classList.toggle('calm', !!calm);
    setText(el.toast, msg); el.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3000);
  }

  // ------------------------------------------------------------------ platform, screens, guides
  const UA = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(UA);
  const coarse = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } })();
  const isPhone = isIOS || isAndroid || coarse;
  const inApp = /FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Twitter|LinkedInApp|Snapchat|TikTok|musical_ly|Pinterest|GSA\//i.test(UA);
  function isStandalone() {
    try { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches; }
    catch (e) { return false; }
  }
  const kind = isAndroid ? 'android' : !isIOS ? 'safari' : inApp ? 'inapp' : /CriOS|FxiOS|EdgiOS|OPiOS/.test(UA) ? 'ios-other' : 'safari';
  const ss = { get(k) { try { return sessionStorage.getItem('lts.' + k); } catch (e) { return null; } }, set(k, v) { try { sessionStorage.setItem('lts.' + k, v); } catch (e) {} } };
  function needInstall() { return params.has('install') || (isPhone && !isStandalone() && ss.get('skipInstall') !== '1'); }
  const CHECK_V = 1;
  function needCheck() { return params.has('check') || (isPhone && store.get('checkedV', 0) < CHECK_V); }

  const SCREENS = ['install', 'check', 'dial'];
  let screenNow = 'dial';
  function show(id) {
    SCREENS.forEach((k) => { $(k).hidden = k !== id; });
    screenNow = id;
    try { window.scrollTo(0, 0); } catch (e) {}
    if (id === 'install') renderInstall();
    if (id === 'dial') renderDial();
    renderTurn();
  }

  // install guide
  let bip = null;   // Android's install prompt
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); bip = e; renderInstall(); });
  window.addEventListener('appinstalled', () => { bip = null; renderInstall(); });
  function renderInstall() {
    document.querySelectorAll('#install [data-kind]').forEach((n) => { n.hidden = n.dataset.kind !== kind; });
    $('installBtn').hidden = !bip;
  }
  $('installBtn').addEventListener('click', async () => {
    if (!bip) return;
    try { bip.prompt(); await bip.userChoice; } catch (e) {}
    bip = null; renderInstall();
  });
  $('skipInstall').addEventListener('click', () => { ss.set('skipInstall', '1'); show(needCheck() ? 'check' : 'dial'); });
  document.querySelectorAll('.copyLink').forEach((b) => b.addEventListener('click', async () => {
    const url = `${location.origin}/?ch=${ch}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied. Paste it into Safari.', true); }
    catch (e) { toast(url, true); }
  }));

  // check screen
  $('testSound').addEventListener('click', () => {
    unlockAudio(); keepAwake();
    const a = ac; if (!a) { toast('No sound on this phone.'); return; }
    const t = a.currentTime + 0.08;
    CUE.count(t); CUE.count(t + 0.5); CUE.count(t + 1); CUE.go(t + 1.5);
    [2.4, 2.9, 3.4].forEach((d) => CUE.tick(t + d, { c: 'A' }));
  });
  $('checkDone').addEventListener('click', () => { store.set('checkedV', CHECK_V); unlockAudio(); show('dial'); });

  // hold to test the light: the strip lit full height, at this phone's size, level and the channel's light width
  function startTestLight() {
    if (R) return;
    mode = 'test-light'; hideOverlays(); showStage();
    const st = normSettings(S && S.settings), L = S ? splitLines(S.text, st.caps) : [];
    const rows = rowsFor(st, L), all = Array.from({ length: rows }, (_, r) => r), n = st.light + 4;
    drawStrip({ cols: Array(n).fill(all), cell: new Int16Array(n), cellBase: 0, lineCols: n, rows, pitch: pitchFor(rows, st.formation === 'together', stageH),
      light: st.light, colour: st.colour, dots: st.dots, colRate: 0, dtMs: 0, alpha: level() }, n / 2);
  }
  function endTestLight() { if (mode !== 'test-light') return; hideStage(); mode = 'dial'; renderTurn(); }
  document.querySelectorAll('.testLight').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { b.setPointerCapture(e.pointerId); } catch (_) {}
      startTestLight();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => b.addEventListener(t, endTestLight));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // turn upright: a phone in landscape, outside a run
  function isLandscape() {
    try { const t = screen.orientation && screen.orientation.type; if (t) return t.indexOf('landscape') === 0; } catch (e) {}
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90;
    try { return matchMedia('(orientation: landscape)').matches; } catch (e) { return false; }
  }
  let keepSideways = ss.get('sideways') === '1';
  function hideOverlays() { $('turn').hidden = true; el.toast.hidden = true; }
  function renderTurn() { $('turn').hidden = !(isPhone && !keepSideways && stage.hidden && isLandscape()); }
  $('turnKeep').addEventListener('click', () => { keepSideways = true; ss.set('sideways', '1'); renderTurn(); });

  // scheduled runs: the time and a countdown above START
  function renderWait() {
    const p = pending;
    if (!p || p.startAt - serverNow() <= 0) { el.wait.hidden = true; renderStartState(); return; }
    el.wait.hidden = false;
    setText(el.waitT, hhmmss(p.startAt));
    const sLeft = Math.max(0, Math.ceil((p.startAt - serverNow()) / 1000));
    const h = Math.floor(sLeft / 3600), m = Math.floor((sLeft % 3600) / 60), sec = sLeft % 60;
    setText(el.waitIn, 'in ' + (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0') + (p.local ? ' · this phone' : ''));
    renderStartState();
  }

  // ------------------------------------------------------------------ fonts
  if (document.fonts && document.fonts.load) {
    document.fonts.load(`16px ${VGA_FAM}`).then((faces) => {
      if (!faces || !faces.length) return;
      vgaReady = true;
      // the VGA cap height, so fallback glyphs in vga16 sit on the same rows as the letters
      const h = rasterVGA('H'), rs = h.flat();
      if (rs.length) vgaMetric = { capTop: Math.min(...rs), base: Math.max(...rs) + 1 };
      glyphCache.vga16.clear();
      if (S && screenNow === 'dial') renderDial();
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ updates
  // The service worker fetches the app from the network first. When a new one takes over, this page
  // reloads once the phone is idle (a Home Screen app has no reload button).
  let reloadWanted = false, swReg = null;
  function idle() {
    if (mode !== 'dial' || R || !stage.hidden) return false;
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
    if (Date.now() - lastInputAt < 10000) return false;
    // no reload with a run going or one starting in the next 60 s
    const soon = (r) => !!r && r.startAt > serverNow() && r.startAt - serverNow() < 60000;
    if (soon(pending) || (S && S.run && (soon(S.run) || runActive()))) return false;
    return true;
  }
  function askVersion(w) {
    return new Promise((res) => {
      try { const mc = new MessageChannel(); mc.port1.onmessage = (e) => res(e.data && e.data.version); w.postMessage({ t: 'version' }, [mc.port2]); }
      catch (e) { res(null); }
      setTimeout(() => res(null), 1500);
    });
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }   // first install: this page is already current
      reloadWanted = true;
    });
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').then((r) => { swReg = r; }).catch(() => {}); });
    setInterval(async () => {
      if (!idle()) return;
      if (swReg && swReg.waiting) { try { swReg.waiting.postMessage({ t: 'skip' }); } catch (e) {} }
      if (!reloadWanted) return;
      reloadWanted = false;
      const v = navigator.serviceWorker.controller ? await askVersion(navigator.serviceWorker.controller) : null;
      if (v !== BUILD && idle()) location.reload();
    }, 3000);
    // look for a new version every 10 minutes and on each return to the app
    setInterval(() => { if (swReg && idle()) swReg.update().catch(() => {}); }, 600000);
  }

  // ------------------------------------------------------------------ lifecycle
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkAlive();
    if (armed) { keepAwake(); if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} } }
    if (R) map = makeMap();
    if (swReg) swReg.update().catch(() => {});
  });
  window.addEventListener('online', () => { backoff = 500; connect(); });
  window.addEventListener('orientationchange', () => renderTurn());
  try { screen.orientation && screen.orientation.addEventListener('change', () => renderTurn()); } catch (e) {}
  const onResize = () => {
    renderTurn();
    if (!stage.hidden) { sizeStage(); if (R) { R.key = null; R.pitch = pitchFor(R.sch.rows, R.sch.together, stageH); R.band = band(stageH); } }
    else if (S && screenNow === 'dial') renderDial();
  };
  window.addEventListener('resize', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  // debug hook for tests and for reading sync quality on the night
  const api = window.__lt = {
    build: BUILD, log, serverNow, arm, trace: false, onFrame: null,
    get offset() { return offset; }, get rtt() { return bestRtt; }, get state() { return S; },
    get mode() { return mode; }, get ch() { return ch; }, get armed() { return armed; }, get pending() { return pending; },
    get run() { return R; }, get lastDraw() { return R && R.lastDraw; },
    schedule: (run, part) => buildSchedule(run, part || 0),
    glyph, rasterLine, testLine, pitchFor, normSettings, nextMinute,
    get vgaReady() { return vgaReady; }, get vgaMetric() { return vgaMetric; },
  };

  { const d = new Date(Date.now() + 10 * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    el.atTime.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
  store.set('ch', ch);
  S = cachedState(ch);
  show(needInstall() ? 'install' : needCheck() ? 'check' : 'dial');
  if (S.run) syncRun(S.run);
  connect();
})();
