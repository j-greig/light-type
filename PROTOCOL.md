# Light Type sync protocol

One Cloudflare Worker serves the app (`public/`, Workers static assets) and the socket
`GET /ws?ch=<n>`. Each channel is one Durable Object (`Channel`, id from name `ch-<n>`),
SQLite-backed, using the WebSocket Hibernation API (`ctx.acceptWebSocket`).

Channels are `1`..`99`. Channel `1` is THE VERSE: its text is fixed by the server and cannot
be changed. Every other channel is open: anyone on it can set its text.

All times are server epoch milliseconds. Every message is one JSON object with a `t` field.

## Channel state (stored in the DO)

```json
{
  "ch": 3,
  "text": "I FEEL MYSELF THINKING\nI THINK MYSELF FEELING\nI AM MYSELF BECOMING",
  "locked": false,
  "settings": { "bpm": 60, "flash": 160, "colour": "white", "caps": true, "walkback": 10,
                "formation": "one" },
  "conductor": null,
  "run": null
}
```

- `text`: up to 3 lines, each up to 40 graphemes, total up to 200 chars. Server trims and
  rejects longer input with `{t:"error", code:"too_long"}`.
- `settings.bpm` 20..120, `flash` 40..1000 ms, `colour` one of
  `white|warm|yellow|cyan|magenta|cycle`, `caps` bool, `walkback` 0..30 s.
- `settings.formation`:
  - `"one"`: one walker (or several doubling the same letters). Lines play one after another,
    with `walkback` seconds of dark between lines.
  - `"together"`: one walker per line, all lines start on the same beat. Each phone shows only
    its own line (its `part`). No walk back.
- `conductor`: `null`, or `{ "id": "<client id>", "name": "<label>" }`. While set, only that
  client may send `start`, `stop`, `set`, `settings`.
- `run`: `null`, or
  `{ "id": "<random>", "startAt": <ms>, "text": "...", "settings": {...} }`.
  `startAt` is the GO moment (shutter opens); the first letter lights at `t0 = startAt + 1000`. The countdown 5 4 3 2 1 occupies
  `startAt-5000 .. startAt`. The run snapshot copies `text` and `settings`, so edits during a
  run do not change it.

Channel 1 seeds `text` with the verse above, `locked: true`. Other channels seed
`text: "LIGHT TYPE"`, `locked: false`.

## Client to server

| t | fields | effect |
|---|---|---|
| `hello` | `id` (client id, random, kept in localStorage), `name` (optional, 0..24 chars) | server replies `state`; counts presence |
| `ping` | `c` (client ms) | server replies `pong` |
| `set` | `text` | refused on a locked channel (`code:"locked"`) |
| `settings` | partial `settings` object | merged, clamped |
| `start` | | `run = {startAt: now + 5000 + 400, ...snapshot}`; broadcast `run` |
| `stop` | | `run = null`; broadcast `stop` |
| `conduct` | `on` (bool), `name` | `on:true` takes the baton if `conductor` is null or is this id; `on:false` releases it if held by this id |

Rate limit: 20 messages per 10 s per socket; excess are dropped with `code:"slow"`.
`start` while a run is active (now < run end) is refused with `code:"running"` unless the
sender is the conductor (then it restarts).

## Server to client

| t | fields |
|---|---|
| `state` | the whole channel state plus `now` (server ms) and `here` (connected sockets) |
| `pong` | `c` (echoed), `s` (server ms) |
| `run` | `run` |
| `stop` | |
| `here` | `here` (count), sent when it changes |
| `error` | `code`, `msg` |

A `state` is broadcast after every successful `set`, `settings`, `conduct`.

The run ends at `startAt + duration`; the DO clears `run` lazily (on the next message after
the end) or with an alarm.

## Clock

On connect the client sends 8 pings 150 ms apart, then one every 10 s. For each pong:
`rtt = now - c`, `offset = s - (c + rtt/2)`. The client keeps the offset from the sample with
the lowest rtt in the last 16. `serverNow() = Date.now() + offset`.

## Schedule (identical on every client)

From `run.text`, `run.settings` and the phone's `part`:

1. Split `text` into lines (trim, collapse spaces, drop empty), uppercase if `caps`, split
   each line into grapheme clusters (`Intl.Segmenter`).
2. `beat = 60000 / bpm` ms.
3. `formation:"one"`: events in order; line `L`, glyph `k` lights at
   `t0 + (index of glyph across all lines) * beat + L * walkback * 1000`.
   A rising three-note tone sounds one beat after a line's last glyph.
4. `formation:"together"`: line `L`, glyph `k` lights at `t0 + k * beat`; the phone shows
   only its `part` line (default part = `(join order) % lines`, user can change).
5. Each glyph is lit for `flash` ms then the screen goes black. A space lights nothing (short
   low click only).
6. End: one beat after the last glyph plus 400 ms, two-note end tone (660 Hz then 440 Hz).

A phone that connects mid-run joins at the current position.

## Countdown

`startAt - 5000`: big `5`, 880 Hz beep. Then `4`, `3`, `2`, `1` each second, 880 Hz.
At `startAt`: the screen goes black (anything shown now prints into the photo), long 440 Hz beep: the photographer opens the shutter.
The first glyph lights at `startAt + 1000`.

## Notes from server build

No flaw in the contract; these clarify what the server does.

- `state` also carries `you: { id, order }` and is sent to every hello'd socket on each broadcast, so `you` is always present. `order` is fixed at the socket's first `hello` (count of hello'd sockets already connected).
- `settings` message: send `{t:"settings", settings:{...partial}}` (a flat form with the fields beside `t` is also accepted). Invalid fields are ignored, numbers clamped; no error.
- `set`: lines are trimmed, runs of spaces collapsed, blank lines dropped; case is kept (caps is applied at play time). Errors: `too_long` (over 3 lines, 40 graphemes a line, or 200 total), `empty`, `locked`.
- Messages other than `ping` and `hello` before a `hello` get `code:"no_hello"`.
- Other error codes: `conductor` (blocked by the baton, also a refused second `conduct` or a release by a non-holder), `running`, `slow`, `bad_id`, `bad_msg`.
- `ping` is exempt from the 20/10 s bucket (separate cap of 60 per 10 s) so a busy client does not lose clock samples.
- The run ends at `startAt + 1000 + (last glyph time) + one beat + 400 + flash + 500 ms` (slack). When it ends the server clears `run` and broadcasts a `state` (not a `stop`).
- A conductor with no open socket for 30 min is released automatically, with a `state` broadcast. Reconnecting with the same id before then keeps the baton.
- `GET /api/state?ch=N` returns the channel state plus `now` and `here`.
- The Worker runs first for every request (`run_worker_first`), so `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest` carry `Cache-Control: no-cache`.
