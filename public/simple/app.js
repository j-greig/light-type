// Light Type client. Wire contract: PROTOCOL.md at the repo root.
// Screens: ARM (unlock sound + wake lock) -> DIAL (channel, words, START) -> RUN (black, one glyph).
// The run is driven by a requestAnimationFrame loop that reads serverNow() against a precomputed
// schedule; audio is scheduled on the AudioContext clock mapped to server time.
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem('lt.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('lt.' + k, JSON.stringify(v)); } catch (e) {} },
  };
  const clampInt = (v, lo, hi, d) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
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
  let S = null;              // channel state from the server
  let here = 0;
  let you = null;            // server-provided info about this socket, if any ({order})
  let partChoice = store.get('part.' + ch, null);   // user-chosen line in TOGETHER (null = default)
  let armed = false;
  let mode = 'dial';         // 'arm' | 'dial' | 'run' | 'solo'
  let R = null;              // active synced run
  let leftRunId = null;      // run this phone left locally (do not rejoin automatically)
  let SOLO = null;

  // channels 1 and 2 are fixed; their words are built in so a phone with no signal still has them
  const FIXED = {
    1: 'I FEEL MYSELF THINKING\nI THINK MYSELF FEELING',
    2: 'I FEEL MYSELF THINKING\nI THINK MYSELF FEELING\nI AM MYSELF BECOMING',
  };
  const DEFAULT_SETTINGS = { bpm: 60, flash: 160, colour: 'white', caps: true, walkback: 10, formation: 'one' };
  // the last state seen for a channel, kept on the phone so it opens with no signal
  function cachedState(c) {
    const s = store.get('state.' + c, null);
    const base = { ch: c, text: FIXED[c] || 'LIGHT TYPE', locked: !!FIXED[c], settings: Object.assign({}, DEFAULT_SETTINGS), conductor: null, run: null };
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
  function wsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws?ch=' + ch; }
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
        // a fixed channel always shows its built-in words, whatever the server sends
        if (FIXED[ch]) { m.text = FIXED[ch]; m.locked = true; if (m.run) m.run.text = FIXED[ch]; }
        S = m;
        saveState();
        renderDial();
        syncRun(S.run);
        break;
      }
      case 'pong': onPong(m); break;
      case 'run': if (m.run && FIXED[ch]) m.run.text = FIXED[ch]; if (S) { S.run = m.run; saveState(); } syncRun(m.run); renderDial(); break;
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
    not_conductor: 'Someone else is conducting.',
    empty: 'The words cannot be empty.',
  };
  function onError(m) { toast(ERR[m.code] || m.msg || m.code || 'error'); }

  // ------------------------------------------------------------------ text -> glyphs
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

  // ------------------------------------------------------------------ schedule (PROTOCOL.md "Schedule")
  // events: {at, kind:'count'|'go'|'glyph'|'line'|'end', c, i}
  function buildSchedule(run, part) {
    const st = run.settings || {};
    const bpm = clampInt(st.bpm, 20, 120, 60), flash = clampInt(st.flash, 40, 1000, 160);
    const wb = clampInt(st.walkback, 0, 30, 10) * 1000, beat = 60000 / bpm;
    const caps = st.caps !== false, together = st.formation === 'together';
    const L = splitLines(run.text, caps);
    const t0 = run.startAt + 1000;
    const ev = [];
    for (let n = 5; n >= 1; n--) ev.push({ at: run.startAt - n * 1000, kind: 'count', c: String(n) });
    ev.push({ at: run.startAt, kind: 'go' });
    let lastAt = t0;
    if (together) {
      const p = Math.min(Math.max(0, part), Math.max(0, L.length - 1));
      const maxLen = Math.max(0, ...L.map((l) => l.length));
      (L[p] || []).forEach((c, k) => ev.push({ at: t0 + k * beat, kind: 'glyph', c, i: k }));
      lastAt = t0 + Math.max(0, maxLen - 1) * beat;
    } else {
      let idx = 0;
      L.forEach((line, li) => {
        line.forEach((c) => { const at = t0 + idx * beat + li * wb; ev.push({ at, kind: 'glyph', c, i: idx }); lastAt = at; idx++; });
        if (li < L.length - 1) ev.push({ at: t0 + idx * beat + li * wb, kind: 'line' });
      });
    }
    const end = lastAt + beat + 400;
    ev.push({ at: end, kind: 'end' });
    ev.sort((a, b) => a.at - b.at);
    return { ev, glyphs: ev.filter((e) => e.kind === 'glyph'), flash, end, colour: st.colour || 'white', lines: L };
  }

  // ------------------------------------------------------------------ drawing
  const EGA = { white: '#ffffff', warm: '#ffd7a0', yellow: '#ffff55', cyan: '#55ffff', magenta: '#ff55ff' };
  const CYCLE = ['#ffffff', '#55ffff', '#ff55ff', '#ffff55', '#55ff55', '#5555ff', '#ff5555'];
  const colourFor = (name, i) => name === 'cycle' ? CYCLE[i % CYCLE.length] : (EGA[name] || '#ffffff');
  const FAM = '"IBM VGA", ui-monospace, Menlo, monospace';
  const level = () => Math.max(0.05, Math.min(1, (+display.level || 100) / 100));
  const frac = () => Math.max(0.2, Math.min(1, (+display.size || 98) / 100));

  // one letter, ink-centred; size from the cap H so every capital is the same size
  // Latin letters, digits and ASCII marks: ink-centred, sized by the cap H.
  // Anything else (the kaomoji signature) keeps its place on a shared baseline and one shared size,
  // so the mouth sits low between the eyes and the brackets stand tall in the photo.
  const SIGN_SET = '༼つ◕‿⚆○༽';
  const isPlain = (c) => /^[\x20-\x7e]$/.test(c);
  function drawLetter(ctx, w, h, c, colour, alpha, fr) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    if (!c || c === ' ') return;
    const probe = 100;
    ctx.font = `${probe}px ${FAM}`;
    const H = ctx.measureText('H');
    const hw = (H.actualBoundingBoxLeft + H.actualBoundingBoxRight) || probe * 0.44;
    const hh = (H.actualBoundingBoxAscent + H.actualBoundingBoxDescent) || probe * 0.62;
    const size = probe * Math.min((w * fr) / hw, (h * fr) / hh);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    if (!isPlain(c)) {
      // the face is set like a terminal line: every glyph gets the same cell (the widest advance),
      // centred in it, one shared size and baseline. Walked on close knots one phone-width apart,
      // the cells butt together and the face reads with no gaps between its parts.
      let A = 0, D = 0, W = 0;
      for (const g of Array.from(SIGN_SET + c)) { const m = ctx.measureText(g); A = Math.max(A, m.actualBoundingBoxAscent); D = Math.max(D, m.actualBoundingBoxDescent); W = Math.max(W, m.width, m.actualBoundingBoxLeft + m.actualBoundingBoxRight); }
      const k = Math.min(w / (W || 1), (h * fr) / ((A + D) || 1));
      ctx.font = `${probe * k}px ${FAM}`;
      const m = ctx.measureText(c);
      const x = w / 2 - m.width / 2, y = h / 2 + (A - D) * k / 2;
      ctx.globalAlpha = alpha; ctx.fillStyle = colour; ctx.fillText(c, x, y); ctx.globalAlpha = 1;
      return;
    }
    ctx.font = `${size}px ${FAM}`;
    let m = ctx.measureText(c);
    let L = m.actualBoundingBoxLeft, Rr = m.actualBoundingBoxRight, A = m.actualBoundingBoxAscent, D = m.actualBoundingBoxDescent;
    const gw = L + Rr, gh = A + D, k = Math.min(1, (w * fr) / (gw || 1), (h * fr) / (gh || 1));
    if (k < 1) {
      ctx.font = `${size * k}px ${FAM}`; m = ctx.measureText(c);
      L = m.actualBoundingBoxLeft; Rr = m.actualBoundingBoxRight; A = m.actualBoundingBoxAscent; D = m.actualBoundingBoxDescent;
    }
    const x = w / 2 - (Rr - L) / 2, y = h / 2 + (A - D) / 2;
    ctx.globalAlpha = alpha; ctx.fillStyle = colour; ctx.fillText(c, x, y); ctx.globalAlpha = 1;
  }
  const stage = $('stage'), gc = $('gc');
  let stageW = 0, stageH = 0;
  function sizeStage() {
    const dpr = window.devicePixelRatio || 1, r = stage.getBoundingClientRect();
    stageW = r.width; stageH = r.height;
    gc.style.width = `${r.width}px`; gc.style.height = `${r.height}px`;
    gc.width = Math.round(r.width * dpr); gc.height = Math.round(r.height * dpr);
    blank();
  }
  function blank() { const x = gc.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.fillStyle = '#000'; x.fillRect(0, 0, gc.width, gc.height); }
  function paint(c, colour, alpha) {
    const dpr = window.devicePixelRatio || 1, x = gc.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLetter(x, stageW, stageH, c, colour, alpha, frac());
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
    if (!ac) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ac = null; }
      if (ac) ac.onstatechange = () => { try { renderReady(); } catch (e) {} };
    }
    if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} }
    return ac;
  }
  function unlockAudio() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    const a = audio(); if (!a) return;
    try { const b = a.createBuffer(1, 1, 22050), s = a.createBufferSource(); s.buffer = b; s.connect(a.destination); s.start(0); } catch (e) {}
  }
  // f Hz, dur s, at = AudioContext time (absolute)
  function tone(f, dur, at, gain = 0.25, type = 'sine') {
    const a = ac; if (!a) return;
    const t0 = Math.max(at, a.currentTime);
    const o = a.createOscillator(), g = a.createGain(); o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination); o.start(t0); o.stop(t0 + dur + 0.02);
    liveNodes.add(o); o.onended = () => liveNodes.delete(o);
  }
  const liveNodes = new Set();
  function stopAllTones() { liveNodes.forEach((o) => { try { o.stop(); } catch (e) {} }); liveNodes.clear(); }
  const CUE = {
    count: (t) => tone(880, 0.12, t),
    go: (t) => tone(440, 0.6, t, 0.3),
    // spaces: low click; letters: high click; face glyphs: soft tick = small step to the next close knot
    glyph: (t, e) => e.c === ' ' ? tone(520, 0.04, t, 0.18, 'square') : isPlain(e.c) ? tone(1400, 0.04, t, 0.18, 'square') : tone(1000, 0.05, t, 0.2, 'sine'),
    line: (t) => { tone(523, 0.12, t, 0.22); tone(659, 0.12, t + 0.18, 0.22); tone(784, 0.18, t + 0.36, 0.22); },
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

  // ------------------------------------------------------------------ the synced run
  const log = [];
  const LEAD = 7000;           // the stage goes black this long before GO
  const TAIL_END = 6000;       // black after the end tone, so nothing lights the photo while the shutter closes
  const TAIL_STOP = 3000;      // black after a stop
  let pending = null, waitTimer = null;
  function runEnd(run) { return buildSchedule(run, 0).end; }
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
  function startLocal(at) {
    if (!S) return;
    const run = { id: 'local-' + randId(), startAt: Math.round(at), text: S.text, settings: Object.assign({}, DEFAULT_SETTINGS, S.settings || {}), local: true };
    leftRunId = null;
    syncRun(run);
  }
  // the next whole minute of server time, at least 15 s ahead
  function nextMinute() { const n = serverNow(); let t = Math.ceil(n / 60000) * 60000; if (t - n < 15000) t += 60000; return t; }
  const hhmmss = (srv) => { const d = new Date(srv - offset); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); };
  function startRun(run) {
    stopSolo(true);
    closeKeyboard();
    const nLines = splitLines(run.text, (run.settings || {}).caps !== false).length;
    const part = myPart(nLines);
    const sch = buildSchedule(run, part);
    audio(); keepAwake();
    map = makeMap();
    const now = serverNow();
    let cue = 0; while (cue < sch.ev.length && sch.ev[cue].at < now - 60) cue++;   // late join: skip cues already past
    const tok = {};
    R = { run, sch, part, cue, gi: -1, key: null, lastMapCheck: 0, tok, tailUntil: 0 };
    mode = 'run';
    hideOverlays();
    showStage();
    log.push({ ev: 'start', run: run.id, part, serverT: now, perf: performance.now() });
    requestAnimationFrame(() => frame(tok));
  }
  // a frame drawn now reaches the glass at the next vsync: look ahead half a frame so the
  // display error is centred on the beat instead of always one frame late
  let lastFrameAt = 0, frameDt = 16.7;
  function frame(tok) {
    if (!R || R.tok !== tok) return;
    const pnow = performance.now();
    if (lastFrameAt) { const d = pnow - lastFrameAt; if (d > 4 && d < 50) frameDt = frameDt * 0.9 + d * 0.1; }
    lastFrameAt = pnow;
    const real = serverNow(), now = real + Math.min(8, frameDt / 2), sch = R.sch, run = R.run;
    // after a stop: black, no cues, then back to the dial
    if (R.tailUntil) {
      if (R.key !== 'black') { blank(); R.key = 'black'; }
      if (real >= R.tailUntil) { finishRun(); return; }
      requestAnimationFrame(() => frame(tok)); return;
    }
    // what is due now
    let key = 'black', c = null, colour = '#000', alpha = 1, due = null;
    if (now >= run.startAt - 5000 && now < run.startAt) {
      const n = Math.min(5, Math.ceil((run.startAt - now) / 1000));
      key = 'count' + n; c = String(n); colour = '#aaaaaa'; alpha = 0.55 * level(); due = run.startAt - n * 1000;
    } else if (now >= run.startAt) {
      const g = sch.glyphs;
      while (R.gi + 1 < g.length && g[R.gi + 1].at <= now) R.gi++;
      const e = g[R.gi];
      if (e && now < e.at + sch.flash && e.c !== ' ') {
        key = 'g' + R.gi; c = e.c; colour = colourFor(sch.colour, e.i); alpha = level(); due = e.at;
      }
    }
    if (key !== R.key) {
      if (c) paint(c, colour, alpha); else blank();
      log.push({ ev: 'show', key, c, serverT: real, due, perf: performance.now(), run: run.id });
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
    else if (SOLO) stopSolo();
  }
  function backToDial() { hideStage(); mode = 'dial'; renderDial(); renderTurn(); }
  // the server keeps a run a little past the client's end (flash + 500 ms): match it so START is not refused
  function runActive() {
    if (!S || !S.run) return false;
    const sc = buildSchedule(S.run, 0);
    return serverNow() < sc.end + sc.flash + 600;
  }

  // ------------------------------------------------------------------ solo step (local, unsynced)
  function startSolo() {
    if (!S) { toast('Waiting for the channel…'); return; }
    audio(); keepAwake();
    const st = S.settings || {};
    const L = splitLines(S.text, st.caps !== false);
    let seq = [];
    if (st.formation === 'together') { const p = myPart(L.length); seq = (L[p] || []).map((c) => ({ c, li: 0 })); }
    else L.forEach((ln, li) => ln.forEach((c) => seq.push({ c, li })));
    if (!seq.length) return;
    SOLO = { seq, i: 0, ready: false, done: false, colour: st.colour || 'white', timers: [] };
    mode = 'solo'; showStage();
    const t = ac ? ac.currentTime : 0;
    if (ac) { tone(880, 0.12, t); tone(880, 0.12, t + 1); tone(880, 0.12, t + 2); tone(440, 0.6, t + 3, 0.3); }
    SOLO.timers.push(setTimeout(() => { if (SOLO) SOLO.ready = true; }, 3600));
  }
  function stopSolo(silent) {
    if (!SOLO) return; SOLO.timers.forEach(clearTimeout); SOLO = null;
    if (!silent) backToDial(); else mode = 'dial';
  }
  function soloDown() {
    if (!SOLO || !SOLO.ready || SOLO.done) return;
    const it = SOLO.seq[SOLO.i];
    if (ac) CUE.glyph(ac.currentTime, it);
    if (it.c !== ' ') paint(it.c, colourFor(SOLO.colour, SOLO.i), level()); else blank();
    SOLO.pressed = true;
  }
  function soloUp() {
    if (!SOLO || !SOLO.ready || SOLO.done || !SOLO.pressed) return;
    SOLO.pressed = false; blank(); SOLO.i++;
    if (SOLO.i >= SOLO.seq.length) {
      SOLO.done = true;
      SOLO.timers.push(setTimeout(() => ac && CUE.end(ac.currentTime), 800));
      SOLO.timers.push(setTimeout(() => stopSolo(), 2600));
    } else if (SOLO.seq[SOLO.i].li !== SOLO.seq[SOLO.i - 1].li) {
      SOLO.timers.push(setTimeout(() => ac && CUE.line(ac.currentTime), 500));
    }
  }

  // stage input: hold 3 s anywhere to leave; solo uses press/release
  // A walker's thumbs rest on the glass: in a synced run one finger does nothing, leaving takes two
  // fingers held for 2 s. Solo step uses one finger to light and a 3 s hold to leave.
  let holdTimer = null;
  const touching = new Set();
  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    touching.add(e.pointerId);
    if (mode === 'solo') {
      if (touching.size === 1) { clearTimeout(holdTimer); holdTimer = setTimeout(() => { holdTimer = null; leaveRun(); }, 3000); soloDown(); }
      return;
    }
    if (touching.size >= 2 && !holdTimer) holdTimer = setTimeout(() => { holdTimer = null; leaveRun(); }, 2000);
  });
  const release = (e) => {
    touching.delete(e && e.pointerId);
    if (mode === 'test') { hideStage(); mode = 'dial'; renderTurn(); return; }
    if (mode === 'solo') { if (touching.size === 0) { clearTimeout(holdTimer); holdTimer = null; soloUp(); } return; }
    if (touching.size < 2) { clearTimeout(holdTimer); holdTimer = null; }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (!stage.hidden) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (stage.hidden) return;
    if (e.key === 'Escape') { leaveRun(); return; }
    if (mode === 'solo' && (e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); soloDown(); }
  });
  document.addEventListener('keyup', (e) => { if (mode === 'solo' && (e.key === ' ' || e.key === 'Enter')) soloUp(); });

  // ------------------------------------------------------------------ wake
  let wake = null;
  const vid = $('wakeVid');
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !(wake && !wake.released)) {
        wake = await navigator.wakeLock.request('screen');
        wake.addEventListener('release', () => renderReady());
      }
    } catch (e) { wake = null; }
    try { const p = vid.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    renderReady();
  }

  // ------------------------------------------------------------------ ARM
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
  // the first touch anywhere turns sound on (iOS needs a gesture) and keeps the screen awake
  document.addEventListener('pointerdown', () => { if (!armed) arm(); }, true);

  // ------------------------------------------------------------------ DIAL wiring
  const el = {
    dot: $('dot'), here: $('here'), sync: $('sync'), chNum: $('chNum'), chName: $('chName'), text: $('text'), textNote: $('textNote'),
    fOne: $('fOne'), fTog: $('fTog'), fNote: $('fNote'), partRow: $('partRow'), partSeg: $('partSeg'),
    start: $('startBtn'), runRow: $('runRow'), rejoin: $('rejoinBtn'), stop: $('stopBtn'), startNote: $('startNote'),
    conduct: $('conductBtn'), name: $('name'), phones: $('phones'),
    bpm: $('bpm'), flash: $('flash'), walkback: $('walkback'), colour: $('colour'), caps: $('caps'), size: $('size'), level: $('level'),
    shareUrl: $('shareUrl'), qr: $('qr'), solo: $('soloBtn'), toast: $('toast'),
    wait: $('wait'), waitT: $('waitT'), waitIn: $('waitIn'), minute: $('minuteBtn'), atTime: $('atTime'), atBtn: $('atBtn'),
  };
  el.name.value = myName;
  el.size.value = display.size; el.level.value = display.level;

  const conductorOther = () => wsOpen && S && !S.cached && S.conductor && S.conductor.id !== clientId;
  const iConduct = () => S && S.conductor && S.conductor.id === clientId;

  function renderConn() {
    el.dot.classList.toggle('off', !wsOpen);
    el.dot.setAttribute('aria-label', wsOpen ? 'online' : 'offline');
    renderPresence();
    renderStartState();
  }
  function renderPresence() {
    if (!wsOpen) { el.here.textContent = 'no signal · saved words'; return; }
    el.here.textContent = here === 1 ? '1 phone here' : `${here} phones here`;
  }
  function renderSync() {
    el.sync.textContent = synced ? `sync ${offset >= 0 ? '+' : ''}${Math.round(offset)} ms · rtt ${Math.round(bestRtt)} ms` : 'sync …';
  }
  function renderChannel() {
    if (document.activeElement !== el.chNum) el.chNum.value = String(ch);
    el.chName.textContent = ch === 1 ? 'THE VERSE' : ch === 2 ? 'THE VERSE, THREE LINES' : 'OPEN CHANNEL';
    const url = `${location.host}/simple/?ch=${ch}`;
    el.shareUrl.textContent = url;
    renderQR(`${location.origin}/simple/?ch=${ch}`);
  }
  let qrFor = null;
  function renderQR(url) {
    if (qrFor === url || typeof qrcode !== 'function') return;
    qrFor = url;
    try { const q = qrcode(0, 'M'); q.addData(url); q.make(); el.qr.innerHTML = q.createSvgTag({ cellSize: 5, margin: 0, scalable: true }); }
    catch (e) { el.qr.textContent = ''; }
  }
  let textDirtyUntil = 0;
  function renderDial() {
    renderChannel(); renderPresence(); renderSync();
    if (!S) { renderStartState(); return; }
    const locked = !!S.locked || ch === 1 || ch === 2, other = conductorOther();
    el.text.readOnly = locked;
    el.text.disabled = !locked && other;
    { const sb = document.getElementById('sign'); if (sb) { sb.hidden = locked; sb.disabled = !!(other && !locked); } }
    if (document.activeElement !== el.text || Date.now() > textDirtyUntil) {
      if (el.text.value !== S.text && !(document.activeElement === el.text && Date.now() < textDirtyUntil)) el.text.value = S.text || '';
    }
    el.textNote.textContent = locked ? `These words are fixed on channel ${ch}.` : other ? '' : 'Up to 3 lines. Everyone on this channel sees edits.';
    el.textNote.className = 'note';
    const st = S.settings || {};
    const tog = st.formation === 'together';
    el.fOne.setAttribute('aria-pressed', String(!tog)); el.fTog.setAttribute('aria-pressed', String(tog));
    el.fOne.disabled = el.fTog.disabled = other;
    el.fNote.textContent = tog ? 'One walker per line, all at once. Each phone shows its own line.' : 'Lines one after another. Walk back in the dark between them.';
    const L = splitLines(S.text, st.caps !== false);
    el.partRow.hidden = !tog;
    if (tog) {
      const p = myPart(L.length);
      const want = L.length || 1;
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
    setIfIdle(el.bpm, st.bpm); setIfIdle(el.flash, st.flash); setIfIdle(el.walkback, st.walkback);
    setIfIdle(el.colour, st.colour);
    if (document.activeElement !== el.caps) el.caps.checked = st.caps !== false;
    [el.bpm, el.flash, el.walkback, el.colour, el.caps].forEach((x) => x.disabled = other);
    renderPhones(L, tog ? myPart(L.length) : -1, st.colour || 'white');
    renderStartState();
  }
  function setIfIdle(input, v) { if (v != null && document.activeElement !== input && String(input.value) !== String(v)) input.value = v; }
  function renderStartState() {
    const other = conductorOther(), active = wsOpen && !!runActive(), mine = iConduct();
    const waiting = !!(pending && !pending.local) && pending.startAt - serverNow() > LEAD;
    let note = '', disabled = false, label = 'START';
    if (!S) { disabled = true; note = 'Joining channel…'; }
    else if (!wsOpen) { note = 'No signal: START runs on this phone only. To line up several phones, use START ON THE NEXT MINUTE.'; }
    else if (other) { disabled = true; note = `conducted by ${S.conductor.name || 'someone'}`; }
    else if (waiting && !mine) { disabled = true; note = `Set for ${hhmmss(pending.startAt)}.`; }
    else if (active && !mine) { disabled = true; note = 'A run is going.'; }
    else if (active && mine) { label = 'RESTART'; }
    el.start.textContent = label; el.start.disabled = disabled;
    el.startNote.textContent = note; el.startNote.className = 'note' + (other ? ' warn' : '');
    el.runRow.hidden = !((active || (pending && !pending.local)) && mode === 'dial');
    el.stop.disabled = !!other;
    el.stop.textContent = wsOpen ? 'STOP FOR ALL' : 'SKIP ON THIS PHONE';
    el.minute.disabled = !S || (!!other) || (active && !mine);
    el.atBtn.disabled = !S || !wsOpen || !!other || (active && !mine);
    el.conduct.setAttribute('aria-pressed', String(!!mine));
    el.conduct.disabled = !!other || !wsOpen;
    el.conduct.textContent = mine ? 'CONDUCTING · TAP TO LET GO' : other ? `CONDUCTED BY ${(S.conductor.name || 'someone').toUpperCase()}` : 'I’M CONDUCTING THIS CHANNEL';
  }
  function renderPhones(L, part, colourName) {
    const box = el.phones; box.innerHTML = '';
    let idx = 0;
    L.forEach((line, li) => {
      const row = document.createElement('div'); row.className = 'phone-line' + (part >= 0 && li !== part ? ' dim' : '');
      line.forEach((c, k) => {
        const ph = document.createElement('div'); ph.className = 'phone' + (c === ' ' ? ' space' : '') + (c !== ' ' && !isPlain(c) ? ' close' : '');
        ph.textContent = c === ' ' ? '' : c;
        ph.style.color = colourFor(colourName, part >= 0 ? k : idx);
        row.appendChild(ph); idx++;
      });
      box.appendChild(row);
    });
  }

  // channel dial
  let chTimer = null;
  function setChannel(n, now) {
    n = clampInt(n, 1, 99, ch);
    if (n === ch && !now) { renderChannel(); return; }
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
  el.text.addEventListener('input', () => {
    const c = cleanText(el.text.value);
    if (c !== el.text.value) { const p = el.text.selectionStart; el.text.value = c; try { el.text.setSelectionRange(p, p); } catch (e) {} }
    textDirtyUntil = Date.now() + 1500;
    if (S) { S.text = el.text.value; saveState(); renderPhones(splitLines(S.text, (S.settings || {}).caps !== false), (S.settings || {}).formation === 'together' ? myPart(splitLines(S.text, true).length) : -1, (S.settings || {}).colour || 'white'); }
    clearTimeout(setTimer);
    setTimer = setTimeout(() => send({ t: 'set', text: el.text.value }), 400);
  });
  const SIGN = '༼つ◕‿◕‿◕༽つ';
  const signBtn = $('sign');
  if (signBtn) signBtn.addEventListener('click', () => {
    if (!S || S.locked || el.text.disabled) return;
    let v = el.text.value.replace(/\s+$/, '');
    if (v.includes(SIGN)) v = v.replace(' ' + SIGN, '').replace(SIGN, '').replace(/\s+$/, '');
    else v = v + ' ' + SIGN;
    el.text.value = v; el.text.dispatchEvent(new Event('input'));
  });
  el.text.addEventListener('blur', () => { clearTimeout(setTimer); if (S && !S.locked && ch > 2) send({ t: 'set', text: el.text.value }); textDirtyUntil = 0; });

  // formation + shared settings
  function sendSettings(part) {
    if (S) S.settings = Object.assign({}, S.settings, part);
    send({ t: 'settings', settings: part }); renderDial();
  }
  el.fOne.addEventListener('click', () => sendSettings({ formation: 'one' }));
  el.fTog.addEventListener('click', () => sendSettings({ formation: 'together' }));
  let stTimer = null, stPending = {};
  function queueSetting(k, v) {
    stPending[k] = v; clearTimeout(stTimer);
    stTimer = setTimeout(() => { const p = stPending; stPending = {}; sendSettings(p); }, 500);
  }
  el.bpm.addEventListener('change', () => queueSetting('bpm', clampInt(el.bpm.value, 20, 120, 60)));
  el.flash.addEventListener('change', () => queueSetting('flash', clampInt(el.flash.value, 40, 1000, 160)));
  el.walkback.addEventListener('change', () => queueSetting('walkback', clampInt(el.walkback.value, 0, 30, 10)));
  el.colour.addEventListener('change', () => queueSetting('colour', el.colour.value));
  el.caps.addEventListener('change', () => queueSetting('caps', el.caps.checked));
  // local display
  el.size.addEventListener('change', () => { display.size = clampInt(el.size.value, 20, 100, 98); el.size.value = display.size; store.set('display', display); });
  el.level.addEventListener('change', () => { display.level = clampInt(el.level.value, 5, 100, 100); el.level.value = display.level; store.set('display', display); });

  // start / stop / rejoin
  el.start.addEventListener('click', () => {
    unlockAudio(); keepAwake();
    leftRunId = null;
    if (!(wsOpen && send({ t: 'start' }))) startLocal(serverNow() + 5400);   // no signal: this phone only
  });
  el.stop.addEventListener('click', () => {
    if (wsOpen && send({ t: 'stop' })) return;
    const r = pending || (S && S.run); if (r) leftRunId = r.id;          // no signal: skip it here
    pending = null; renderWait(); renderDial();
  });
  el.minute.addEventListener('click', () => {
    unlockAudio(); keepAwake(); leftRunId = null;
    const at = nextMinute();
    if (!(wsOpen && send({ t: 'start', at }))) startLocal(at);
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
    if (send({ t: 'start', at })) toast(`Set for ${hhmmss(at)} on every phone here`, true);
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

  el.solo.addEventListener('click', () => { unlockAudio(); startSolo(); });

  // any tap on the dial keeps the audio context alive
  $('dial').addEventListener('pointerdown', () => { if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} } }, { passive: true });

  function closeKeyboard() { const a = document.activeElement; if (a && a.blur && a !== document.body) a.blur(); }
  let toastTimer = null;
  function toast(msg, calm) {
    if (!stage.hidden) return;                 // anything lit during a run prints into the photo
    el.toast.classList.toggle('calm', !!calm);
    el.toast.textContent = msg; el.toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3000); }


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
  document.documentElement.classList.add(isAndroid ? 'is-android' : 'is-ios');
  const ss = { get(k) { try { return sessionStorage.getItem('lt.' + k); } catch (e) { return null; } }, set(k, v) { try { sessionStorage.setItem('lt.' + k, v); } catch (e) {} } };
  function needInstall() { return params.has('install') || (isPhone && !isStandalone() && ss.get('skipInstall') !== '1'); }
  const CHECK_V = 1;
  function needCheck() { return params.has('check') || (isPhone && store.get('checkedV', 0) < CHECK_V); }

  const SCREENS = ['install', 'check', 'dial'];
  let screenNow = 'dial';
  function show(id) {
    SCREENS.forEach((k) => { $(k).hidden = k !== id; });
    screenNow = id;
    try { window.scrollTo(0, 0); } catch (e) {}
    if (id === 'check') renderChecks();
    if (id === 'install') renderInstall();
    renderTurn();
  }

  // install guide
  let bip = null;   // Android's install prompt
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); bip = e; renderInstall(); });
  window.addEventListener('appinstalled', () => { bip = null; renderInstall(); });
  function renderInstall() {
    document.querySelectorAll('#install [data-kind]').forEach((n) => { n.hidden = n.dataset.kind !== kind; });
    const ib = $('installBtn'); if (ib) ib.hidden = !bip;
  }
  $('installBtn').addEventListener('click', async () => {
    if (!bip) return;
    try { bip.prompt(); await bip.userChoice; } catch (e) {}
    bip = null; renderInstall();
  });
  $('skipInstall').addEventListener('click', () => { ss.set('skipInstall', '1'); show(needCheck() ? 'check' : 'dial'); });
  document.querySelectorAll('.copyLink').forEach((b) => b.addEventListener('click', async () => {
    const url = `${location.origin}/simple/?ch=${ch}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied. Paste it into Safari.', true); }
    catch (e) { toast(url, true); }
  }));

  // checklist
  const ticks = Object.assign({}, store.get('ticks', {}));
  function renderChecks() {
    document.querySelectorAll('#check .checks > li').forEach((li) => {
      const k = li.dataset.k, on = !!ticks[k];
      li.classList.toggle('done', on);
      const b = li.querySelector('.tick'); if (b) b.setAttribute('aria-pressed', String(on));
    });
    renderReady();
  }
  document.querySelectorAll('#check .tick').forEach((b) => b.addEventListener('click', () => {
    const k = b.closest('li').dataset.k; ticks[k] = !ticks[k]; store.set('ticks', ticks); renderChecks();
  }));
  $('testSound').addEventListener('click', () => {
    unlockAudio(); keepAwake();
    const a = ac; if (!a) { toast('No sound on this phone.'); return; }
    const t = a.currentTime + 0.08;
    CUE.count(t); CUE.count(t + 0.5); CUE.count(t + 1); CUE.go(t + 1.5);
    setTimeout(renderReady, 200);
  });
  $('checkDone').addEventListener('click', () => { store.set('checkedV', CHECK_V); unlockAudio(); show('dial'); renderDial(); });

  // hold to test the light: the first letter of the words, at this phone's size and level
  document.querySelectorAll('.testLight').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (R || SOLO) return;
      try { b.setPointerCapture(e.pointerId); } catch (_) {}
      mode = 'test'; hideOverlays(); showStage();
      const L = S ? splitLines(S.text, true) : [];
      const first = (L[0] || []).find((c) => c !== ' ') || 'L';
      paint(first, '#ffffff', level());
    });
    const up = () => { if (mode !== 'test') return; hideStage(); mode = 'dial'; renderTurn(); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });

  // readiness: what this phone can confirm about itself
  function isLandscape() {
    try { const t = screen.orientation && screen.orientation.type; if (t) return t.indexOf('landscape') === 0; } catch (e) {}
    if (typeof window.orientation === 'number') return Math.abs(window.orientation) === 90;
    try { return matchMedia('(orientation: landscape)').matches; } catch (e) { return false; }
  }
  function readiness() {
    return {
      sound: !!(ac && ac.state === 'running'),
      awake: !!((wake && !wake.released) || (vid && !vid.paused)),
      upright: !isLandscape(),
      app: isStandalone() || !isPhone,
      saved: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    };
  }
  const LIVE = {
    rot: (r) => r.upright ? 'Upright now.' : 'Sideways now: turn it upright.',
    sound: (r) => r.sound ? 'Sound is on in Light Type.' : 'Sound is asleep: tap TEST SOUND.',
    awake: (r) => r.awake ? 'Light Type is keeping the screen on.' : 'Not confirmed: set Auto-Lock to Never.',
  };
  function renderReady() {
    const r = readiness();
    document.querySelectorAll('[data-r]').forEach((n) => { const v = !!r[n.dataset.r]; n.classList.toggle('ok', v); n.classList.toggle('bad', !v); });
    document.querySelectorAll('[data-live]').forEach((n) => { const k = n.dataset.live, f = LIVE[k]; if (f) { n.textContent = f(r); n.classList.toggle('bad', !(k === 'rot' ? r.upright : r[k])); } });
  }
  $('ready').addEventListener('click', () => { unlockAudio(); keepAwake(); show('check'); });
  setInterval(() => { if (screenNow === 'dial' || screenNow === 'check') renderReady(); }, 1000);

  // turn upright: a phone in landscape, outside a run
  let keepSideways = ss.get('sideways') === '1';
  function hideOverlays() { $('turn').hidden = true; el.toast.hidden = true; }
  function renderTurn() {
    const on = isPhone && !keepSideways && stage.hidden && isLandscape();
    $('turn').hidden = !on;
  }
  $('turnKeep').addEventListener('click', () => { keepSideways = true; ss.set('sideways', '1'); renderTurn(); });

  // scheduled runs: the time and a countdown above START
  function renderWait() {
    const p = pending;
    if (!p || p.startAt - serverNow() <= 0) { el.wait.hidden = true; renderStartState(); return; }
    el.wait.hidden = false;
    el.waitT.textContent = hhmmss(p.startAt);
    const sLeft = Math.max(0, Math.ceil((p.startAt - serverNow()) / 1000));
    const h = Math.floor(sLeft / 3600), m = Math.floor((sLeft % 3600) / 60), sec = sLeft % 60;
    el.waitIn.textContent = 'in ' + (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0') + (p.local ? ' · this phone' : '');
    renderStartState();
  }

  // ------------------------------------------------------------------ lifecycle
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    checkAlive();
    if (armed) { keepAwake(); if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} } }
    if (R) map = makeMap();
  });
  window.addEventListener('online', () => { backoff = 500; connect(); });
  window.addEventListener('orientationchange', () => { renderTurn(); renderReady(); });
  try { screen.orientation && screen.orientation.addEventListener('change', () => { renderTurn(); renderReady(); }); } catch (e) {}
  const onResize = () => { renderTurn(); if (!stage.hidden) { sizeStage(); if (R) R.key = null; } };
  window.addEventListener('resize', onResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  }

  // debug hook for tests and for reading sync quality on the night
  window.__lt = {
    log, serverNow, arm,
    get offset() { return offset; }, get rtt() { return bestRtt; }, get state() { return S; },
    get mode() { return mode; }, get ch() { return ch; }, get armed() { return armed; },
    schedule: (run, part) => buildSchedule(run, part || 0),
    drawLetter, readiness, nextMinute, get pending() { return pending; },
  };

  { const d = new Date(Date.now() + 10 * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    el.atTime.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
  store.set('ch', ch);
  S = cachedState(ch);
  show(needInstall() ? 'install' : needCheck() ? 'check' : 'dial');
  renderDial();
  if (S.run) syncRun(S.run);
  connect();
  if (document.fonts && document.fonts.load) document.fonts.load('40px "IBM VGA"').catch(() => {});
})();
