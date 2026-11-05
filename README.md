# Light Type

Your phone becomes a print head. In the dark, walk along a line holding the screen toward a camera on a long
exposure; at each step the phone flashes one huge letter. The photograph keeps the whole sentence.

**https://light.wibandwob.com**

Phones on the same channel stay in sync. Anyone on a channel presses START: every phone counts down
5 4 3 2 1, then they all flash their letters on the same beat, so one person or a whole group can draw
into the same exposure.

- **Channel 1** is fixed: *I FEEL MYSELF THINKING / I THINK MYSELF FEELING / I AM MYSELF BECOMING ༼つ◕‿◕‿◕༽つ*. The face at the end is the signature, walked one glyph per step like the letters. On open channels, SIGN IT adds it to the last line.
- **Channel 2** is the same verse without the face, also fixed.
- **Channels 3-99** are open: anyone on the channel can write the line.
- **One walker**: lines play one after another, with time between them to walk back in the dark.
- **Together**: one walker per line, all lines at once, each phone held at its own height.
- **Conduct**: one phone can take the baton for a channel; then only it can start, stop or edit.

## On an iPhone

Open the link in Safari, Share > Add to Home Screen, open it from the Home Screen (fullscreen). Tap to arm
(this turns sound on and keeps the screen awake). Turn the phone's brightness up and Silent mode off.

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
