# PR notes — mejoras-claude (#26)

## P-1 Publish checklist

**Done**

- **README placeholders gone.** No `[ENLACE]` or `[CAPTURA]` left. The issues
  link points to https://github.com/imelero-dev/void-freighter/issues. The
  demo sentence now says what is true today: there is no hosted demo, so you
  play from source (`npm run dev`) or from an offline web build
  (`npm run build` / `npm run build:itch`).
- **Real images.** The hero is now `screenshots/10_journey_arrival.png`, which
  shows actual cruise (7,098 m/s, CRUISE, ETA to Cinder Forge). There is also
  a new `screenshots/cruise.gif` (3.4 MB, 640 px time-lapse: undock, mass-lock
  refusal, then cruise engaged) and a 3-shot gameplay gallery. The README
  order follows common open source game repos: hero, one-line pitch, Play,
  How it plays, Controls, build/run, hosting, multiplayer, development,
  feedback, license.
- **`npm run media` works.** It pointed at a missing
  `scripts/capture_media.mjs`. That script now exists: it flies a real
  contract run (inputs only, no teleports) in headless Chrome and encodes the
  GIF with ffmpeg.
- **Renamed the misleading screenshot.** The tour's `05_cruise.png` is now
  `05_cruise_masslocked.png`, because it shows the mass-lock refusal.
- **itch.io build.** `npm run build:itch` writes
  `release/void-freighter-<version>-itch-html5.zip`:
  - It is a Vite `itch` mode (`.env.itch`, `VITE_OFFLINE_ONLY=true`). The
    ONLINE panel, the `/api/status` probe and the online client chunk are
    compiled out, and the script fails if `/api/` or `WebSocket(` survives
    in the JS.
  - `index.html` is at the zip root and all paths are relative. The script
    also checks the itch.io HTML5 limits: 1000 files max, 200 MB per file,
    500 MB extracted. The current zip is 2 files, 0.69 MB extracted and
    0.19 MB zipped.
  - The zip writer has no dependencies (`scripts/lib/zip.mjs`) and gives the
    same zip for the same build.
- **itch.io check.** `npm run verify:itch` unzips the package and serves it
  from an itch-style sub-path (`/html/1234567/`) inside an iframe. It then
  launches a solo game in headless Chrome and fails on any console error,
  page error, failed request or request outside the game folder.
  - Result: the game launches offline with 0 console errors.
  - Cross-check: the zip also unzips with the system `unzip` (`unzip -t`
    clean). Served with `python3 -m http.server`, the only requests are
    `index.html` and one JS file, with 0 errors.
- Translated a leftover Spanish status message in `src/main.ts`.
- `npm run typecheck && npm test` pass (70/70). The standard `npm run build`
  is unchanged and still has multiplayer.

**Not done / open decisions (owner)**

- **Hosted demo URL.** Not decided and not invented. Once `dist/` (or the
  itch zip) is published, add the URL to the README "Play" section.
- **itch.io upload.** Nothing was uploaded. For the itch page: Kind = HTML,
  tick "played in the browser", use a viewport of 1280×720 or larger and
  enable the fullscreen button.
- **itch.io limits.** These come from itch.io's HTML5 docs as I know them. I
  could not re-fetch the page from this session (no web access), so check
  them once before uploading.
- **Git author `Aitor <aitor@local>` in history** (INFORME §3). Still
  undecided. Rewriting history is outside this PR.
- `INFORME.md` (a dated pre-publish review, in Spanish) still mentions
  `05_cruise.png`. I left it as a historical record.
- Each `npm run media` run gives a slightly different GIF, because timing in
  headless Chrome varies.
