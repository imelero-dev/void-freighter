# Void Freighter — Balance Reference

All tuning numbers chosen by the implementation, with rationale. Source of
truth lives in `src/sim/data.ts`, `src/sim/system.ts` and `src/sim/economy.ts`;
this file documents the *why*.

## Currency & progression targets

- Starting credits: **2,000** (one tank of fuel + a small cargo stake).
- Income per activity (measured by the smoke bots on a fresh world):
  - Best arbitrage run, starter 30 m³ hold: **~1,500–3,500 cr** (top route is
    industrial goods producer→consumer; requires knowing both markets).
  - Mining (iron, drill Mk2, full starter hold): **~300–600 cr** per hold —
    iron is the floor; icy/rare belts scale to **5–10×** that (iridium ore is
    120 cr/u raw, 320 refined).
  - Pirate kills: scout ~120 cr, fighter ~300, raider ~650, warlord ~1,700
    (credits + cargo value, before module drops).
  - Contracts: small hauls 300–900 cr, big/urgent/dangerous 1,200–4,000 cr.
- Hull ladder (trade-in 70% of old hull):
  - Shuttle (free) → Hauler **16k** ≈ 5–8 good trade runs (doc target: "a few").
  - Prospector **34k** — mining specialist, pays for itself in icy/rare belts.
  - Interceptor **62k** — combat income + bounty contracts.
  - Freighter **150k** — endgame logistics; needs combined income streams.
- Modules: `price = base × tier²` (engine 900 → Mk V 22.5k). Resale 65%.
  Rep ≥ 50 with the station's faction gives up to **12%** discount.

## Economy model

- Station stock per good; equilibrium target = `100 + 40×production +
  25×consumption` (per-5s-tick rates).
- Price multiplier = `clamp(1.65 − 0.65 × stock/target, 0.5, 2.3)` ×
  event multipliers × ±15%·volatility deterministic noise.
- Spread: buy = unit × 1.04, sell = unit × 0.96 (round trips always lose).
- Player slippage: orders re-price every 5 units while stock moves.
- Mean reversion: stock drifts 0.4%/tick toward target (half-life ≈ 14 min) —
  arbitrage routes erode when hammered and regenerate over a play session.
- Econ events every 2.5–6.5 min (max 3 active): shortage ×1.3, surplus ×0.8,
  blockade ×1.4, boom ×1.35; 3–7 min duration. Headlines hit the station feed.

## Flight & fuel

- Maneuver speeds 110–210 m/s by hull; cruise 220–300 km/s × engine tier
  (+28%/tier). Cruise speed is mass-capped: `max(220, distance-to-nearest-mass
  ÷ 3)` — automatic arrival braking, station departures crawl until ~4 km out.
- Fuel 100 u base (+60/tank tier). Cruise burns 0.25 u/s at full fraction —
  a cross-system run costs ~25–50 u. Fuel price 2 cr/u. Fuel cells in cargo
  convert to 8 u each (emergency reserve). Rescue tow: max(400, 20% credits).

## Combat

- Damage: shield first (regen 2+1.5×tier hp/s after 6 s quiet), then hull.
  Hull only repairs at stations (2.5 cr/pt).
- Player cannon: 6+4×tier dmg per shot, ~3 shots/s. Missiles: 50+35×tier,
  lock 3.0−0.3×tier s, ammo 2+2×tier, 30 cr per restock.
- Pirates: scout 40/25 (hull/shield), fighter 75/55, raider 135/100 (+2
  missiles), warlord 280/220 (+6 missiles). Module drop chance 2/5/12/35%.
- Death: cargo lost (contract cargo fails its contract), insurance deductible
  **12%** of fitted ship value (clamped to available credits), respawn docked
  at last station. No rep/ship loss — the "non-hardcore" model from the GDD.

## Danger map

- Danger 0..1 drives pirate spawns, interdiction odds and bounty tiers:
  belt floor (Ironline 0.15 → The Shatter 0.85), Rusthaven halo 0.6,
  police zones ~0 within 2.5× station safe radius, deep-void floor 0.04.
- Cruise interdiction: `p/s = min(6%, 0.08% + 1.8%×danger + 3%×cargoValue/1M)`
  with a 90 s cooldown — empty quiet routes are near-safe, rich cargo through
  The Shatter is not.
- Customs: 30% inspection chance when docking at a legal station with illegal
  cargo → confiscation + 1.5× fine + rep −3. Smuggling contracts pay ×1.8.

## Mining

- Rock hp = radius × 2.6–5.0 by type; yield = radius × 0.9–1.7 units.
- Drill: 1.2 + 0.8×tier u/s, range 500 + 150×tier. Collector radius 80+60×tier.
- Refining ratios: iron 2:1→steel, copper 2:1→alloy, ice 1:1→water,
  silicates 3:1→components, volatiles 2:1→fuel cells, iridium 2:1→refined.
  Station efficiency 0.7–0.9 × output, small per-unit fee.
- Mined-out rocks respawn after 10 min.

## Contracts & reputation

- Boards refresh every 4 min, 6–8 offers. Reward gates: ≥1,100 cr needs rep
  ≥10, ≥2,600 cr needs rep ≥25 with the issuing faction.
- Rewards: transport `120 + 55/Mm + 18% cargo value + danger bonus`; urgent
  ×1.55 with ~⅓ the deadline; supply `50% of goods value + 250`; bounty
  `kills × tier bounty × 1.15 + 150`.
- Rep: +2/3 per contract, −5 fail/abandon, −3 smuggling bust, pirate kills
  +0.5–1 with the local faction and −1 with the Scrappers.

## Simplifications vs. the GDD (documented decisions)

- Planets hold fixed positions (visual axial rotation only) — keeps nav,
  persistence and determinism simple; orbital motion adds little gameplay.
- Market data for *visited* stations is shown live rather than as a stale
  snapshot ("subscription to the station feed" fiction).
- Insurance recovers your fitted ship for a 12% deductible instead of reverting
  you to a bare shuttle — deaths still sting (cargo + deductible) without
  deleting an hour of module shopping.
- Power pips, wings/squads and waypoint queues are out of scope (GDD fase 2).
