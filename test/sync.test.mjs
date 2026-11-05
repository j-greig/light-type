// Run: npm test   (LT_URL=https://light.wibandwob.com npm test for a deployed server)
// Needs node >= 22 (built-in WebSocket and fetch).
const BASE = (process.env.LT_URL || "http://localhost:8787").replace(/\/$/, "");
const WS = BASE.replace(/^http/, "ws");
const CH = process.env.LT_CH || String(3 + Math.floor(Math.random() * 90)); // random channel keeps reruns clean

let fails = 0;
const ok = (c, msg) => { console.log((c ? "ok   " : "FAIL ") + msg); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(ch, id, name) {
    this.ch = ch; this.id = id; this.name = name; this.msgs = []; this.waiters = [];
  }
  open() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`${WS}/ws?ch=${this.ch}`);
      this.ws.onopen = () => res(this);
      this.ws.onerror = (e) => rej(new Error("ws error " + (e.message || "")));
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        this.msgs.push(m);
        this.waiters = this.waiters.filter((w) => !(w.pred(m) && (w.res(m), true)));
      };
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  wait(pred, ms = 5000) {
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => rej(new Error("timeout waiting")), ms);
    });
  }
  next(pred, ms = 5000) { // only messages arriving from now on
    this.msgs = [];
    return this.wait(pred, ms);
  }
  hello() { this.send({ t: "hello", id: this.id, name: this.name }); return this.wait((m) => m.t === "state" && m.you); }
  close() { try { this.ws.close(); } catch {} }
}

async function pingExchange(c) {
  const rtts = [];
  for (let i = 0; i < 8; i++) {
    const t = Date.now();
    c.send({ t: "ping", c: t });
    const p = await c.wait((m) => m.t === "pong" && m.c === t);
    rtts.push(Date.now() - t);
    if (typeof p.s !== "number") throw new Error("pong without s");
    await sleep(150);
  }
  return rtts;
}

try {
  // bad channel
  const bad = await fetch(`${BASE}/ws?ch=0`);
  ok(bad.status === 400, "ch=0 gives 400");
  const bad2 = await fetch(`${BASE}/ws?ch=100`);
  ok(bad2.status === 400, "ch=100 gives 400");

  // three clients on an open channel
  const [a, b, c] = [new Client(CH, "ta-" + Date.now(), "A"), new Client(CH, "tb-" + Date.now(), "B"), new Client(CH, "tc-" + Date.now(), "C")];
  await Promise.all([a.open(), b.open(), c.open()]);
  const sa = await a.hello(); const sb = await b.hello(); const sc = await c.hello();
  ok([sa, sb, sc].map((s) => s.you.order).join() === "0,1,2", "join order 0,1,2");
  ok(sc.here === 3, "here count 3 on third hello");
  ok(sa.locked === false && sa.text === "LIGHT TYPE", "open channel seeded");

  const rtts = await pingExchange(a);
  ok(rtts.length === 8, `ping exchange ok (min rtt ${Math.min(...rtts)} ms)`);

  // set + settings
  const setSeen = Promise.all([b, c].map((x) => x.next((m) => m.t === "state" && m.text === "hello\ndark")));
  a.send({ t: "set", text: "  hello  \n\n dark " });
  await setSeen.then(() => ok(true, "set reaches the others (trimmed, blank lines dropped)")).catch(() => ok(false, "set reaches the others"));
  const setS = Promise.all([a, b, c].map((x) => x.next((m) => m.t === "state" && m.settings.bpm === 120 && m.settings.flash === 40)));
  a.send({ t: "settings", settings: { bpm: 999, flash: 1, colour: "nope", formation: "together" } });
  const [s1] = await setS;
  ok(s1.settings.bpm === 120 && s1.settings.flash === 40 && s1.settings.colour === "white" && s1.settings.formation === "together", "settings clamped, bad colour ignored");

  a.send({ t: "set", text: "x".repeat(41) });
  const e1 = await a.wait((m) => m.t === "error");
  ok(e1.code === "too_long", "too_long refused");

  // start: all three get the same run
  const runs = await Promise.all([a, b, c].map((x) => x.next((m) => m.t === "run")).concat([(a.send({ t: "start" }), Promise.resolve())])).then((r) => r.slice(0, 3));
  ok(runs[0].run.startAt === runs[1].run.startAt && runs[1].run.startAt === runs[2].run.startAt && runs[0].run.id === runs[2].run.id, "all three receive the same run.startAt");
  const lead = runs[0].run.startAt - Date.now();
  ok(lead > 4000 && lead <= 5400, `startAt is ~5.4 s ahead (${lead} ms left)`);
  ok(runs[0].run.text === "HELLO\nDARK" || runs[0].run.text === "hello\ndark", "run carries text snapshot");

  // second start refused while running
  b.send({ t: "start" });
  const e2 = await b.wait((m) => m.t === "error" && m.code === "running");
  ok(!!e2, "start while running refused");

  // late joiner gets the run in state
  const d = new Client(CH, "td-" + Date.now(), "D");
  await d.open();
  const sd = await d.hello();
  ok(sd.run && sd.run.id === runs[0].run.id, "mid-run joiner gets the run in state");
  ok(sd.you.order === 3 && sd.here === 4, "late joiner order 3, here 4");

  // stop
  const stops = Promise.all([a, b, c, d].map((x) => x.next((m) => m.t === "stop")));
  b.send({ t: "stop" });
  await stops.then(() => ok(true, "stop broadcast to all four"));
  d.close();
  const hereMsg = await a.wait((m) => m.t === "here" && m.here === 3).catch(() => null);
  ok(!!hereMsg, "here count drops to 3 when a client leaves");

  // conductor
  const cs = Promise.all([a, b, c].map((x) => x.next((m) => m.t === "state" && m.conductor && m.conductor.id === a.id)));
  a.send({ t: "conduct", on: true, name: "Maestro" });
  await cs.then(() => ok(true, "conduct on broadcast with name"));
  b.send({ t: "start" });
  ok((await b.wait((m) => m.t === "error")).code === "conductor", "conductor blocks start from others");
  b.msgs = []; b.send({ t: "set", text: "NOPE" });
  ok((await b.wait((m) => m.t === "error")).code === "conductor", "conductor blocks set from others");
  b.msgs = []; b.send({ t: "conduct", on: true });
  ok((await b.wait((m) => m.t === "error")).code === "conductor", "second conduct refused");
  const crun = Promise.all([a, b].map((x) => x.next((m) => m.t === "run")));
  a.send({ t: "start" });
  await crun.then(() => ok(true, "conductor can start"));
  const crun2 = b.next((m) => m.t === "run");
  a.send({ t: "start" });
  const r2 = await crun2;
  ok(!!r2, "conductor can restart a running run");
  const rel = Promise.all([a, b, c].map((x) => x.next((m) => m.t === "state" && m.conductor === null)));
  a.send({ t: "conduct", on: false });
  await rel.then(() => ok(true, "conductor releases"));
  a.send({ t: "stop" });
  await sleep(200);

  // channel 1 locked
  const v = new Client("1", "tv-" + Date.now(), "V");
  await v.open();
  const sv = await v.hello();
  ok(sv.locked === true && sv.text.startsWith("I FEEL MYSELF THINKING"), "ch 1 serves the verse");
  v.send({ t: "set", text: "HACK" });
  ok((await v.wait((m) => m.t === "error")).code === "locked", "ch 1 refuses set");
  v.close();

  // rate limit
  const r = new Client(CH, "tr-" + Date.now(), "R");
  await r.open(); await r.hello();
  r.msgs = [];
  for (let i = 0; i < 30; i++) r.send({ t: "settings", settings: { bpm: 60 } });
  await sleep(800);
  ok(r.msgs.some((m) => m.t === "error" && m.code === "slow"), "rate limit drops with code slow");
  r.close();

  // /api/state
  const st = await (await fetch(`${BASE}/api/state?ch=${CH}`)).json();
  ok(st.ch === Number(CH) && typeof st.now === "number" && st.text, "/api/state returns state");

  [a, b, c].forEach((x) => x.close());
} catch (e) {
  console.log("FAIL exception: " + e.stack);
  fails++;
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
