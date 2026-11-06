import { Channel } from "./channel.js";
export { Channel };

const NO_CACHE = new Set([
  "/", "/index.html", "/sw.js", "/manifest.webmanifest",
  "/simple", "/simple/", "/simple/index.html", "/simple/manifest.webmanifest",
]);

function parseCh(url) {
  const raw = url.searchParams.get("ch");
  if (raw === null || !/^\d{1,2}$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n >= 1 && n <= 99 ? n : null;
}

// kind=sweep is the sweep app (DO "sw-N"); no kind is the knot app at /simple (DO "ch-N")
function parseKind(url) {
  return url.searchParams.get("kind") === "sweep" ? "sweep" : "knot";
}
function channelStub(env, ch, kind) {
  return env.CHANNEL.get(env.CHANNEL.idFromName((kind === "sweep" ? "sw-" : "ch-") + ch));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const ch = parseCh(url);
      if (ch === null) return new Response("bad channel", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const kind = parseKind(url);
      return channelStub(env, ch, kind).fetch(new Request(`https://do/ws?ch=${ch}&kind=${kind}`, request));
    }

    if (url.pathname === "/api/state") {
      const ch = parseCh(url);
      if (ch === null) return new Response("bad channel", { status: 400 });
      const kind = parseKind(url);
      return channelStub(env, ch, kind).fetch(`https://do/state?ch=${ch}&kind=${kind}`);
    }

    const res = await env.ASSETS.fetch(request);
    if (NO_CACHE.has(url.pathname)) {
      const out = new Response(res.body, res);
      out.headers.set("Cache-Control", "no-cache");
      return out;
    }
    return res;
  },
};
