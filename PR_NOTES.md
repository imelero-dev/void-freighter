# VF-1 — Guided first haul (tutorial)

## What
A skippable 6-step scripted first contract for new offline pilots:
market (K) → accept the ★ TUTORIAL haul → undock (Space) → set destination
(M/N) → throttle + cruise (Caps Lock) → dock and get paid.

- `src/game/tutorial.ts`: a pure `TutorialController` state machine (no DOM, no
  storage). It is fed `SimEvent`s (`undocked`, `cruiseChange`, `contractDone`,
  `contractFailed`) and UI window signals. Two steps have no sim event (contract
  accepted, destination set), so those advance on the observed state instead.
  It also recovers when the pilot goes off-script: a failed or abandoned haul
  sends them back to the board, a respawn at another station rewinds to
  "undock", and steps that are already done get skipped.
- Forces the guaranteed rookie run (`contracts.ts` first offers): the board
  marks the nearest legal, ungated transport that fits the hold with
  ★ TUTORIAL and locks the other offers until it is taken. The Contracts dock
  button pulses during that step.
- HUD: one pinned hint line ("TUTORIAL n/6 …"). In flight it sits under the
  compass; while docked it sits bottom-centre. It pulses when the step changes
  and shows the player's current keybinds.
- Persistence: progress lives in the offline save blob (`tutorial` field). A
  separate `void_freighter_tutorial_done` key makes sure it never reappears,
  even after NEW GAME. Saves from before this change count as done.
- Menu: **SKIP TUTORIAL** next to LAUNCH (first launch only), plus a skip
  button in the Esc menu while the tutorial runs. Offline only.
- No sim changes.

## Tests
- `tests/tutorial.test.ts` (8 tests):
  - the step state machine, showing each hint advances only on its trigger
  - skip
  - recovery paths
  - the rookie-contract pick
  - an end-to-end run of the tutorial against the real `Sim`
- `scripts/playtest_tutorial.mjs` (`npm run playtest:tutorial`): a headless
  "new player" that follows the hints through the real UI. It then checks that
  the tutorial stays gone after CONTINUE and NEW GAME, and that SKIP works.

## Verification status (be aware)
- Earlier in this session: `npm run typecheck` was clean, the 70 existing tests
  plus the first 7 tutorial tests passed, and the browser playtest advanced
  through steps 1→6, with each hint rendering correctly and moving forward on
  the real UI action or event (screenshots `screenshots/20–23_tutorial_*.png`).
  I did not see that run's delivery, "never reappears" and skip checks finish.
- After that run I made two final changes: the rookie pick now prefers the
  shortest route and checks hold capacity, and one test was added for it.
  Shell commands then needed approval in this session, so **typecheck, `npm
  test` and the full playtest were not re-run on the final commit**. Run
  `npm run typecheck && npm test && npm run playtest:tutorial` before merging.
- Not done: the manual playtest by a real first-time player (with time noted)
  from the Definition of done. The signal to watch is time-to-first-delivery.
