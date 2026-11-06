# Light Type

A phone shows the words as a narrow strip of dot-matrix columns. In the dark, a walker carries the phone sideways
past a camera on a long exposure; the words scroll through the strip as the phone moves, and the photograph shows
the whole line in dots.

**https://light.wibandwob.com** (the sweep app) · **https://light.wibandwob.com/simple** (the knot app: one big
letter per step, walked along a rope)

Phones on the same channel stay in sync. Anyone on a channel presses START: every phone counts down 5 4 3 2 1,
then they all play the same schedule, so one walker or a whole group can draw into the same exposure.

- **Channel 1** is fixed: *I FEEL MYSELF THINKING / I THINK MYSELF FEELING*.
- **Channel 2** is fixed: the same verse with a third line, *I AM MYSELF BECOMING*.
- **Channels 3-99** are open: anyone on the channel can write the words. SIGN IT adds the Wib&Wob face.
- The sweep app and the knot app keep separate channels: channel 5 at `/` and channel 5 at `/simple` are different.

## The sweep

- **Speed** is in letters a second; the phone ticks softly once per letter, and the dial shows the walking pace in
  cm a second. Walking faster than the set speed makes letters wider, slower makes them narrower; they stay sharp.
- **Direction** → (every line left to right, as the camera sees it), ⇄ (line 1 left to right, line 2 back the
  other way, a hand's width lower), ←.
- **One walker**: lines one after another, with a pause between them. **Together**: one walker per line, all
  lines at once; every phone uses the same dot size so the lines come out the same length.
- **Letters** 5×7 dots or VGA 9×16; **dots** round or square; **light width** 1, 2 or 4 columns (more light,
  needs a steadier pace; a phone draws as many as fit across its screen).
- Every setting above is the same on every phone on the channel, saved on the server; the last change wins.
  Letter height and light level are set on each phone.
- **TEST**, beside START, runs a checkerboard and a 4-letter bar on this phone only. In the photo the squares
  come out square at the right pace: wider than tall, walk slower; narrower, walk faster.
- The preview on the dial draws each line as the photo shows it, with its length and time on this phone.

## On an iPhone

1. **Home Screen.** In Safari the page shows how to add it (Share › Add to Home Screen). From the Home Screen it
   fills the screen; in Safari the browser bar stays lit and shows in the photo.
2. **First touch.** The first touch turns sound on and keeps the screen awake.
3. **Before the photo** (once per phone, again from MORE › SETUP): Do Not Disturb on, brightness full with
   Auto-Brightness off, tape over the clock. Test sound, hold to test the light.
4. The letters stay inside the safe area, clear of the status bar and the home bar.
5. When a new version is deployed, the app loads it the next time it opens with signal, or reloads itself on the
   dial when nothing is running or starting within a minute. The build stamp is at the bottom of the dial.

## No signal outside

- Open the app once on the wifi: the app and the channel's words and settings are saved on the phone.
- **START AT** (under MORE), set on the wifi, runs on every phone on the channel at that time with no signal.
- **START ON THE NEXT MINUTE**: phones that tap it in the same minute start together on the next :00.
- With no signal, START runs on that phone alone.

## During a run

- The screen is black except for the strip. Messages never draw over it.
- It stays black for 6 s after the end tone (3 s after a stop).
- Thumbs resting on the glass do nothing. To stop early, hold three fingers on the screen for 2 s.

## For the photographer

Tripod, bulb, manual focus on the walking line. Start at ISO 200, f/8. Open the shutter on the long low beep after
the countdown; close it on the two-note end tone. If the dots bloom, turn the phone's light level down. Phones
with an LCD screen (iPhone SE, XR, 11) glow grey on black and leave a faint band: lower their brightness.

## Code

One Cloudflare Worker serves `public/` and a WebSocket per channel: `/ws?ch=N&kind=sweep` (the sweep app, Durable
Object `sw-N`) and `/ws?ch=N` (the knot app at `/simple`, Durable Object `ch-N`). Wire format and timing rules:
[PROTOCOL.md](PROTOCOL.md).

```
public/            the sweep app (index.html, app.js, style.css, dot7.js = the 5x7 font table)
public/simple/     the knot app
public/sw.js       service worker for both
worker/src/        the Worker and the Channel Durable Object
```

```
npx wrangler dev                              # local, http://localhost:8787
LT_URL=http://localhost:8787 npm test         # server sync test, both kinds
npm run deploy                                # stamps the build (scripts/stamp.mjs), then wrangler deploy
```

`npx wrangler deploy` on its own skips the stamp: phones then keep the old service worker until it changes.

## Credits

Made by Wib&Wob · wibandwob.com. Code MIT (see LICENSE).
Font: Px437 IBM VGA 9x16 from The Ultimate Oldschool PC Font Pack by VileR (int10h.org), CC BY-SA 4.0.
