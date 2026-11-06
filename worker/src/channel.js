import { DurableObject } from "cloudflare:workers";

const SIGN = "༼つ◕‿◕‿◕༽つ";
const VERSE_PLAIN = "I FEEL MYSELF THINKING\nI THINK MYSELF FEELING\nI AM MYSELF BECOMING";
const VERSE_TWO = "I FEEL MYSELF THINKING\nI THINK MYSELF FEELING";
// fixed channels: 1 = the two-line verse, 2 = the three-line verse
const FIXED = { 1: VERSE_TWO, 2: VERSE_PLAIN };
const COLOURS = ["white", "warm", "yellow", "cyan", "magenta", "cycle"];
const FORMATIONS = ["one", "together"];
const DEFAULT_SETTINGS = { bpm: 60, flash: 160, colour: "white", caps: true, walkback: 10, formation: "one" };

const LEAD_MS = 5400; // 5 s countdown + 400 ms margin
const CONDUCTOR_GRACE_MS = 30 * 60 * 1000;
const RL_WINDOW = 10000;
const RL_MAX = 20;
const PING_MAX = 60; // pings are exempt from the 20/10s bucket but still capped

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s) => Array.from(segmenter.segment(s), (x) => x.segment);

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function normaliseText(input) {
  if (typeof input !== "string") return { error: "bad_text" };
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return { error: "empty" };
  if (lines.length > 3) return { error: "too_long" };
  let total = 0;
  for (const l of lines) {
    const n = graphemes(l).length;
    if (n > 40) return { error: "too_long" };
    total += n;
  }
  if (total > 200) return { error: "too_long" };
  return { text: lines.join("\n") };
}

// Merge a partial settings object into `base`, clamping. Unknown or invalid fields are ignored.
function mergeSettings(base, patch) {
  const s = { ...base };
  if (!patch || typeof patch !== "object") return s;
  if (typeof patch.bpm === "number" && isFinite(patch.bpm)) s.bpm = clamp(Math.round(patch.bpm), 20, 120);
  if (typeof patch.flash === "number" && isFinite(patch.flash)) s.flash = clamp(Math.round(patch.flash), 40, 1000);
  if (typeof patch.walkback === "number" && isFinite(patch.walkback)) s.walkback = clamp(Math.round(patch.walkback), 0, 30);
  if (COLOURS.includes(patch.colour)) s.colour = patch.colour;
  if (typeof patch.caps === "boolean") s.caps = patch.caps;
  if (FORMATIONS.includes(patch.formation)) s.formation = patch.formation;
  return s;
}

// Run duration after startAt, per PROTOCOL "Schedule".
function runDuration(text, settings) {
  let lines = text.split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (settings.caps) lines = lines.map((l) => l.toUpperCase());
  const counts = lines.map((l) => graphemes(l).length);
  const beat = 60000 / settings.bpm;
  const t0 = 1000;
  let lastLit;
  if (settings.formation === "together") {
    lastLit = t0 + (Math.max(0, ...counts) - 1) * beat;
  } else {
    const total = counts.reduce((a, b) => a + b, 0);
    lastLit = t0 + (total - 1) * beat + (lines.length - 1) * settings.walkback * 1000;
  }
  // end tone one beat after last glyph, plus 400 ms; plus the last flash and a little slack
  return Math.ceil(lastLit + beat + 400 + settings.flash + 500);
}

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export class Channel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.s = (await this.ctx.storage.get("s")) || null;
    });
  }

  init(ch) {
    // fixed channels always carry their current text, even when older text is stored
    if (this.s) { if (FIXED[this.s.ch]) { this.s.text = FIXED[this.s.ch]; this.s.locked = true; } return; }
    this.s = {
      ch,
      text: FIXED[ch] || "LIGHT TYPE",
      locked: !!FIXED[ch],
      settings: { ...DEFAULT_SETTINGS },
      conductor: null,
      run: null,
      runEnd: 0,
      conductorLostAt: 0,
    };
  }

  async save() {
    await this.ctx.storage.put("s", this.s);
    await this.schedule();
  }

  publicState() {
    const { ch, text, locked, settings, conductor, run } = this.s;
    return { ch, text, locked, settings, conductor, run };
  }

  liveSockets(excludeSid) {
    return this.ctx.getWebSockets().filter((w) => {
      if (w.readyState !== 1) return false;
      const a = w.deserializeAttachment();
      return a && a.sid !== excludeSid;
    });
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }

  broadcast(obj, excludeSid) {
    const msg = JSON.stringify(obj);
    for (const w of this.liveSockets(excludeSid)) {
      try { w.send(msg); } catch {}
    }
  }

  stateMsg(ws, a) {
    return {
      t: "state",
      ...this.publicState(),
      now: Date.now(),
      here: this.liveSockets().filter((w) => w.deserializeAttachment().id).length,
      you: { id: a.id, order: a.order },
    };
  }

  broadcastState() {
    for (const w of this.liveSockets()) {
      const a = w.deserializeAttachment();
      if (!a.id) continue;
      this.send(w, this.stateMsg(w, a));
    }
  }

  hereCount(excludeSid) {
    return this.liveSockets(excludeSid).filter((w) => w.deserializeAttachment().id).length;
  }

  broadcastHere(excludeSid) {
    this.broadcast({ t: "here", here: this.hereCount(excludeSid) }, excludeSid);
  }

  // Lazy expiry of an ended run. Returns true if it changed anything.
  expireRun(now) {
    if (this.s.run && now >= this.s.runEnd) {
      this.s.run = null;
      this.s.runEnd = 0;
      return true;
    }
    return false;
  }

  async schedule() {
    const times = [];
    if (this.s.run) times.push(this.s.runEnd);
    if (this.s.conductor && this.s.conductorLostAt) times.push(this.s.conductorLostAt + CONDUCTOR_GRACE_MS);
    if (times.length) {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, Math.min(...times)));
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  async alarm() {
    if (!this.s) return;
    const now = Date.now();
    let changed = this.expireRun(now);
    if (this.s.conductor && this.s.conductorLostAt && now - this.s.conductorLostAt >= CONDUCTOR_GRACE_MS) {
      this.s.conductor = null;
      this.s.conductorLostAt = 0;
      changed = true;
    }
    if (changed) this.broadcastState();
    await this.save();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const ch = parseInt(url.searchParams.get("ch"), 10);
    if (!(ch >= 1 && ch <= 99)) return new Response("bad channel", { status: 400 });
    this.init(ch);

    if (url.pathname === "/state") {
      if (this.expireRun(Date.now())) await this.save();
      return Response.json(
        { ...this.publicState(), now: Date.now(), here: this.hereCount() },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      sid: randomId(), id: null, name: "", order: 0,
      rl: { w: Date.now(), n: 0 }, pl: { w: Date.now(), n: 0 },
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  err(ws, code, msg) {
    this.send(ws, { t: "error", code, msg: msg || code });
  }

  async webSocketMessage(ws, data) {
    const recvAt = Date.now();
    if (typeof data !== "string" || data.length > 4096) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== "object" || typeof m.t !== "string") return;

    if (!this.s) {
      // DO restarted and storage was empty: cannot happen after a fetch(), but be safe.
      this.s = (await this.ctx.storage.get("s")) || null;
      if (!this.s) return;
    }
    const a = ws.deserializeAttachment();

    if (m.t === "ping") {
      if (recvAt - a.pl.w > RL_WINDOW) { a.pl = { w: recvAt, n: 0 }; }
      a.pl.n++;
      ws.serializeAttachment(a);
      if (a.pl.n > PING_MAX) return;
      this.send(ws, { t: "pong", c: m.c, s: Date.now() });
      return;
    }

    // rate limit
    if (recvAt - a.rl.w > RL_WINDOW) a.rl = { w: recvAt, n: 0 };
    a.rl.n++;
    ws.serializeAttachment(a);
    if (a.rl.n > RL_MAX) return this.err(ws, "slow", "slow down");

    const now = Date.now();
    if (this.expireRun(now)) { await this.save(); this.broadcastState(); }

    if (m.t === "hello") {
      const id = typeof m.id === "string" ? m.id.replace(/[^\w-]/g, "").slice(0, 64) : "";
      if (!id) return this.err(ws, "bad_id", "hello needs an id");
      const name = typeof m.name === "string" ? graphemes(m.name.trim()).slice(0, 24).join("") : "";
      const first = !a.id;
      if (first) {
        a.order = this.liveSockets(a.sid).filter((w) => w.deserializeAttachment().id).length;
      }
      a.id = id;
      a.name = name;
      ws.serializeAttachment(a);
      // a returning conductor cancels the release timer
      if (this.s.conductor && this.s.conductor.id === id) {
        if (this.s.conductorLostAt) { this.s.conductorLostAt = 0; await this.save(); }
        if (name && this.s.conductor.name !== name) { this.s.conductor.name = name; await this.save(); }
      }
      this.send(ws, this.stateMsg(ws, a));
      this.broadcastHere();
      return;
    }

    if (!a.id) return this.err(ws, "no_hello", "send hello first");

    const isConductor = !!this.s.conductor && this.s.conductor.id === a.id;
    const blocked = !!this.s.conductor && !isConductor;

    switch (m.t) {
      case "set": {
        if (this.s.locked) return this.err(ws, "locked", "this channel's text is fixed");
        if (blocked) return this.err(ws, "conductor", "a conductor holds this channel");
        const r = normaliseText(m.text);
        if (r.error) return this.err(ws, r.error, r.error === "too_long" ? "max 3 lines, 40 characters each, 200 total" : "bad text");
        this.s.text = r.text;
        await this.save();
        this.broadcastState();
        return;
      }
      case "settings": {
        if (blocked) return this.err(ws, "conductor", "a conductor holds this channel");
        const patch = m.settings && typeof m.settings === "object" ? m.settings : m;
        this.s.settings = mergeSettings(this.s.settings, patch);
        await this.save();
        this.broadcastState();
        return;
      }
      case "start": {
        if (blocked) return this.err(ws, "conductor", "a conductor holds this channel");
        if (this.s.run && !isConductor) return this.err(ws, "running", "a run is in progress");
        // optional scheduled start: `at` (server ms), from 5 s to 6 h ahead; phones keep the run and
        // play it at that time even with no signal
        const at = Number(m.at);
        const startAt = Number.isFinite(at) && at >= now + 5000 && at <= now + 6 * 3600 * 1000 ? Math.round(at) : now + LEAD_MS;
        const text = this.s.text;
        const settings = { ...this.s.settings };
        this.s.run = { id: randomId(), startAt, text, settings };
        this.s.runEnd = startAt + runDuration(text, settings);
        await this.save();
        this.broadcast({ t: "run", run: this.s.run });
        return;
      }
      case "stop": {
        if (blocked) return this.err(ws, "conductor", "a conductor holds this channel");
        this.s.run = null;
        this.s.runEnd = 0;
        await this.save();
        this.broadcast({ t: "stop" });
        return;
      }
      case "conduct": {
        if (m.on === true) {
          if (this.s.conductor && !isConductor) return this.err(ws, "conductor", "a conductor holds this channel");
          const name = typeof m.name === "string" && m.name.trim()
            ? graphemes(m.name.trim()).slice(0, 24).join("") : (a.name || "conductor");
          this.s.conductor = { id: a.id, name };
          this.s.conductorLostAt = 0;
        } else if (m.on === false) {
          if (!isConductor) return this.err(ws, "conductor", "you do not hold the baton");
          this.s.conductor = null;
          this.s.conductorLostAt = 0;
        } else return this.err(ws, "bad_msg", "conduct needs on:true|false");
        await this.save();
        this.broadcastState();
        return;
      }
      default:
        return this.err(ws, "bad_msg", "unknown message");
    }
  }

  async onGone(ws) {
    let a;
    try { a = ws.deserializeAttachment(); } catch { return; }
    if (!a) return;
    if (this.s && a.id && this.s.conductor && this.s.conductor.id === a.id) {
      const still = this.liveSockets(a.sid).some((w) => w.deserializeAttachment().id === a.id);
      if (!still && !this.s.conductorLostAt) {
        this.s.conductorLostAt = Date.now();
        await this.save();
      }
    }
    this.broadcastHere(a.sid);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code && code !== 1005 && code !== 1006 ? code : 1000, "bye"); } catch {}
    await this.onGone(ws);
  }

  async webSocketError(ws) {
    await this.onGone(ws);
  }
}
