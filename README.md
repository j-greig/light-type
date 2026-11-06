# Light Type

Your phone becomes a print head. In the dark, walk along a line holding the screen toward a camera on a long
exposure; at each step the phone flashes one huge letter. The photograph keeps the whole sentence.

**https://light.wibandwob.com**

Phones on the same channel stay in sync. Anyone on a channel presses START: every phone counts down
5 4 3 2 1, then they all flash their letters on the same beat, so one person or a whole group can draw
into the same exposure.

- **Channel 1** is fixed: *I FEEL MYSELF THINKING / I THINK MYSELF FEELING / I AM MYSELF BECOMING ༼つ◕‿◕‿◕༽つ*. The face at the end is the signature, one glyph per step on close knots a phone-width apart (about 7 cm), so its parts touch in the photo; the phone ticks softly for those steps. On open channels, SIGN IT adds it to the last line.
- **Channel 2** is the same verse without the face, also fixed.
- **Channels 3-99** are open: anyone on the channel can write the line.
- **One walker**: lines play one after another, with time between them to walk back in the dark.
- **Together**: one walker per line, all lines at once, each phone held at its own height.
- **Conduct**: one phone can take the baton for a channel; then only it can start, stop or edit.

## On an iPhone

The app guides each step on screen:

1. **Home Screen.** Opened in Safari, it shows how to add itself: ⋯ or Share › Add to Home Screen ›
   Open as Web App on › Add. From the Home Screen it opens fullscreen with no browser bar to glow in the photo.
2. **First touch.** The first touch anywhere turns sound on and keeps the screen awake (iPhone needs it); a yellow bar says so until then.
3. **Before the dark** (once per phone): rotation lock on, Do Not Disturb, brightness up with
   Auto-Brightness off, Silent mode off (with a test sound). Hold to test the light.
4. The row under the top bar shows what the phone can confirm itself: SOUND, AWAKE, UPRIGHT, APP, SAVED.

## No signal outside

- Open the app once on the wifi: the app and the channel's words are saved on the phone.
- **Start at a set time:** on the wifi, set START AT for all. Every phone on the channel keeps the time and
  runs it at that moment with no signal. Keep the app open with the screen on.
- **On the next minute:** with or without signal, phones that tap START ON THE NEXT MINUTE in the same minute
  start together on the next :00 (their clocks were lined up with the server while online).
- With no signal, START runs on that phone alone, and words typed on an open channel stay on the phone.

## During a run

- The screen is black except for the letter. Messages never draw over it.
- It stays black for 6 s after the end tone (3 s after a stop), so nothing lights the photo while the shutter closes.
- A thumb resting on the glass does nothing. To leave early, hold two fingers on the screen for 2 s.

## For the photographer

Tripod, manual focus on the walking line, ISO 100, f/8, bulb. Open the shutter on the long low beep after
the countdown; close it on the two-note end tone. 0.1-0.2 s of phone light per letter is plenty at f/8.

## Code

One Cloudflare Worker serves `public/` and a WebSocket per channel (`/ws?ch=N`), each channel a Durable
Object. Wire format and timing rules: [PROTOCOL.md](PROTOCOL.md).

```
npx wrangler dev      # local, http://localhost:8787
npx wrangler deploy
LT_URL=wss://light.wibandwob.com node test/sync.test.mjs
```

## Credits

Made by Wib&Wob · wibandwob.com. Code MIT (see LICENSE).
Font: Px437 IBM VGA 9x16 from The Ultimate Oldschool PC Font Pack by VileR (int10h.org), CC BY-SA 4.0.
