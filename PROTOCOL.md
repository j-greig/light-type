# Light Type sync protocol

One Cloudflare Worker serves the apps (`public/`, Workers static assets) and the socket. Each channel is one
Durable Object (`Channel`), SQLite-backed, using the WebSocket Hibernation API (`ctx.acceptWebSocket`).

There are two kinds of channel with separate namespaces, so a run, text or setting on one never reaches the other:

| kind | app | socket | Durable Object name |
|---|---|---|---|
| `knot` | `/simple/` (one letter per step) | `GET /ws?ch=<n>` | `ch-<n>` |
| `sweep` | `/` (the dot-matrix strip) | `GET /ws?ch=<n>&kind=sweep` | `sw-<n>` |

`GET /api/state?ch=<n>` and `GET /api/state?ch=<n>&kind=sweep` work the same way. The DO stores `kind` in its
state on first init. Everything below the "Sweep channels" section describes knot channels; sweep channels share
it except where that section says otherwise.

Channels are `1`..`99`. Channels `1` and `2` are fixed by the server on both kinds and cannot be changed: `1` is
the two-line verse `I FEEL MYSELF THINKING / I THINK MYSELF FEELING`, `2` is the same verse with a third line
`I AM MYSELF BECOMING`. The server rewrites the fixed text on every load. Every other channel is open: anyone on
it can set its text.

All times are server epoch milliseconds. Every message is one JSON object with a `t` field.

## Channel state (stored in the DO)

```json
{
  "ch": 3,
  "kind": "knot",
  "text": "I FEEL MYSELF THINKING\nI THINK MYSELF FEELING",
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

Channels 1 and 2 seed `text` with the verse (two lines on 1, three lines on 2), `locked: true`. Other channels
seed `text: "LIGHT TYPE"`, `locked: false`.

## Client to server

| t | fields | effect |
|---|---|---|
| `hello` | `id` (client id, random, kept in localStorage), `name` (optional, 0..24 chars) | server replies `state`; counts presence |
| `ping` | `c` (client ms) | server replies `pong` |
| `set` | `text` | refused on a locked channel (`code:"locked"`) |
| `settings` | partial `settings` object | merged, clamped |
| `start` | `at` (optional, server ms) | `run = {startAt: at or now + 5400, ...snapshot}`; `at` must be 5 s to 6 h ahead, else ignored; broadcast `run` |
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
- The Worker runs first for every request (`run_worker_first`), so `/`, `/index.html`, `/sw.js`, `/manifest.webmanifest`, `/simple`, `/simple/`, `/simple/index.html` and `/simple/manifest.webmanifest` carry `Cache-Control: no-cache`.

## Scheduled and offline runs (client)

- A `start` with `at` schedules the run. Phones store the run and the clock offset in localStorage,
  so a phone that leaves the network still plays the run at `startAt` (its clock offset is kept).
  The stage goes black 7 s before `startAt`; until then the dial shows the time and a countdown.
- ON THE MINUTE: `at` = the next whole minute of server time, at least 15 s ahead. With no signal
  the phone computes the same minute from its saved offset and runs locally, so phones started on
  the same minute line up without a network.
- With no signal, START runs on this phone only, from the cached or locally edited text. Channels 1
  and 2 have their text built into the client.

## Sweep channels

### State

As above, with `kind: "sweep"` and these settings (defaults shown):

```json
{ "speed": 2, "dir": "alt", "gap": 3, "font": "dot7", "dots": "square", "light": 1,
  "colour": "white", "caps": true, "formation": "one" }
```

- `speed` letters a second, 0.5..5, rounded to 0.1.
- `dir` `ltr | rtl | alt`. `alt`: line 1 left to right, line 2 right to left, line 3 left to right (as the
  camera sees it).
- `gap` seconds between lines in `formation: "one"`, 0..30.
- `font` `dot7` (cells 6 columns x 7 rows, 8 rows when a glyph in the run has a descender) or `vga16` (cells 9 x 16).
- `dots` is always `square` (older stored values are ignored). `light` 1..4: columns lit at once.
- `colour` as on knot channels plus `tint` (line 1 #ffedd5, line 2 #e2eeff, line 3 as line 1), the default on
  the fixed channels. `caps`, `formation` as on knot channels.

Unknown or invalid fields are ignored, numbers clamped. Every change is saved in the DO and broadcast as `state`,
so a change by anyone on the channel is the setting for every phone on it (last write wins; a conductor locks it).

### Start

The server computes `dur`, ms from `startAt` to the end tone, from its own text and settings snapshot with the
schedule below (a `dur` sent by the client is ignored), and the run snapshot carries it:
`run = { id, startAt, text, settings, dur }`. The server holds the run until `startAt + clamp(dur, 2000, 1200000)
+ 6500`, through the phones' 6 s black tail, so a new START cannot light the screens while the shutter closes.
`at` works as on knot channels. On fixed channels the snapshot text is always the fixed verse.

### Schedule (identical on every phone)

```
cellCols = 6 (dot7) or 9 (vga16);  glyph columns 5 or 9
lineCols = cells * cellCols - (cellCols - glyph columns)     (no blank column after the last cell)
colRate  = speed * cellCols                                   (columns a second)
lineDur  = (lineCols + light) / colRate                       (the strip starts and ends fully off the line)
t0       = startAt + 1000
one      line L starts at t0 + sum over k<L of (lineDur_k + gap)
together every line starts at t0; a phone draws only its part line
u        the fractional column at the strip centre; column j's centre passes it at u = j + 0.5
         ltr: u runs -light/2 .. lineCols + light/2;  rtl: the reverse
end      last line end + 400 ms: the end tone; the screen stays black 6 s after it
dur      end - startAt
```

Cues: countdown 5..1 at 880 Hz, GO 440 Hz long at `startAt`, a soft sine tick as the strip reaches each cell
(ltr at its left edge, rtl at its right ink edge; letter 1400 Hz, space 520 Hz, face glyph 1000 Hz), the
three-note chime at each line end except the last, two 880 Hz blips one cell-beat (`1 / speed` s) apart before
each later line when `gap` is at least two cell-beats, the two-note end tone.

### Drawing (per phone)

- Letter band: inside the safe area (clear of the status bar and the home bar). `pitch = band height * letter
  height % / rows`. In `together` every phone uses the pitch of an iPhone SE band (647 CSS px) or its own, whichever
  is smaller, so every line has the same length.
- Each frame (half-frame look-ahead) draws a sawtooth: only the current column `j` (`floor(u)` left to right,
  `ceil(u) - 1` right to left), whole, with hard edges, at `x = cx + (j + 0.5 - u) * pitch`. It is lit for the first 60%
  of its slot, then the screen is black until the next column, so a gap stays between columns even off pace. With
  LIGHT WIDTH n the n - 1 columns behind it are drawn too, each at its own place.
- Dots are squares `0.85 * pitch` tall and `max(0.4, 0.8 - colRate / 60) * pitch` wide: one held frame of travel
  widens them to about 0.8 of a pitch in the photo. Each frame is held for 1/60 s while the phone moves, so the printed
  edges carry about `colRate / 60` of a pitch of blur; on pace they do not drift.
- Outside the strip the canvas is pure black. Outside a line's time the screen is black.

### TEST

A local run, this phone only, with the countdown, ticks and end tone of a real run at the channel's speed, font,
dots and light width: one line of 8 squares (side = half the letter rows, alternately top and bottom, a
checkerboard), one blank cell, then a solid bar 4 cells long. Rows and pitch are those of the channel's words.
