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

## Verification
- `npm run typecheck`: clean. `npm test`: 78/78 passing (70 existing plus 8
  new in `tests/tutorial.test.ts`).
- `npm run playtest:tutorial` passed in headless Chrome on the final code:
  - all 6 hints appeared in order, each advancing on the real UI action or
    sim event
  - the ★ TUTORIAL haul (8× Textiles to Cinder Forge, 18.1 Mm) was delivered
    and paid
  - the tutorial did not reappear after CONTINUE or NEW GAME
  - SKIP TUTORIAL on a fresh profile works and sets the flag
  - screenshots: `screenshots/20–24_tutorial_*.png`
- Time to first delivery for the scripted pilot was **249 s of game time**,
  under the 5-minute goal. Wall-clock time was much longer (681 s) because
  the machine was loaded. Headless SwiftShader frames were slow, and the sim
  clamps `dt`, so wall time overstates what a player would see.
- Not done: the manual playtest by a real first-time player, with the time
  noted, that the Definition of done asks for. Please do one before merging.
  The scripted pilot flies perfectly, so a human will be slower, mostly on
  the cruise and docking legs. If players go well over 5 minutes, the first
  lever is a shorter rookie route.
