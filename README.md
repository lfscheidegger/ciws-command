# CIWS Command

A Missile Command–style game where, instead of firing exploding interceptor
bursts, you defend your cities with **CIWS** (Close-In Weapon Systems) — rapid-fire
gun mounts that spray a stream of tracer rounds. The belt feed is endless, but
rounds arc and slow with distance, so you still have to lead your targets.

Rendered in **WebGL** (Three.js) with bloom for a neon look, while the gameplay
stays a flat 2D plane viewed nearly head-on.

## Play

**[▶ Play it in your browser](https://andrewmunn.github.io/ciws-command/)** —
hosted free on GitHub Pages (auto-deploys from `main`). To run locally:

```
python3 serve.py 8011      # or: bun run serve
# then open http://localhost:8011
```

`serve.py` is a tiny static server that sends no-cache headers (so edits always
show up). Or use the `ciws` config in `.claude/launch.json` with the preview
tooling.

## Tests

Game logic has a unit suite run with [Bun](https://bun.sh) (no dependencies):

```
bun test          # or: bun run test
```

It covers `utils`, `physics`, the entities (ballistics, drag, MIRV split,
interceptor boost/coast), the weapon systems, and the `Game` orchestration
(waves, spawning/threat gating, collisions & HP, bounties, ground impact,
interceptors, the economy breakdown, the shop, and win/lose conditions).

The simulation is headless-testable because the WebGL renderer is **injected**
into `Game` rather than imported — see the architecture note below.

### Controls

| Input | Action |
|-------|--------|
| Mouse move | Aim the CIWS — it fires on its own while threats are inbound |
| `P` | Pause / resume |
| `R` | Restart |
| `M` | Mute / unmute |
| `Space` / click | Deploy from the tutorial screen / restart after game over |

You aim; everything fires itself. The CIWS shoots wherever you point it (and
holds fire when the sky is clear), interceptors launch themselves at distant
high-value threats, and the laser handles whatever gets close. A tutorial
screen at the start covers all of this in-game.

### Weapons

- **CIWS gun** — a single central rapid-fire gun with an **endless belt
  feed** that fires automatically while threats are inbound; you steer the
  stream with the mouse and must lead targets. One tracer kills a standard
  RV. **If a warhead ever hits the gun, you instantly lose** — so anything
  heading for the centre is top priority.
- **Interceptors (autonomous)** — a **cheap armory purchase** (the natural
  first buy) that fields homing anti-missiles with unlimited stock, gated by
  a **reload cooldown** (6s at the start; shop upgrades buy it down to 1s),
  and the pod **starts every wave unloaded**. The launcher fires
  itself at the **highest-value, most distant threat** — it never engages
  drones (a blast can still catch one), can't see cloaked stealth, and won't
  shoot inside its minimum engagement distance. Missiles **cold-launch
  straight up** from a THAAD-style truck, then turn onto an intercept course —
  but coasting flight **bleeds energy fast**, hard turns scrub extra speed,
  and a round that drops below maneuvering speed **self-destructs**: some
  intercepts genuinely run out of energy. If the target dies en route the
  missile retasks onto the nearest non-drone threat (or self-destructs), and
  it detonates with an **area blast**.
- **Laser (shop upgrade)** — a fully autonomous beam emplacement left of the
  gun with a trainable emitter head. It picks the **lowest** drone or
  normal-type missile in range (it can't track the fast movers), **physically
  slews onto it**, and only then burns it down over time. It **can't depress
  below ~15° above the horizon**, so deck-skimmers slip under its arc. Output
  **falls off with distance** — full power up close, weaker out toward its
  maximum range, beyond which it can't latch at all. After each kill it
  recharges (~6s, upgradable to ~2s).

### Economy & shop

You earn **credits** (separate from score) from several sources, shown as a
breakdown on the wave-clear screen:

- **Kill bounties**, scaled by threat type — standard/drone `1`, evasive `2`,
  hypersonic/cruise `3`, MIRV carrier `4` (its split children pay the standard
  rate), nuke `12`.
- **All-clear bonus** for destroying *every* enemy that wave (nothing leaked).
- **Cities saved** — per surviving city.

Between waves the intermission becomes an **armory** — click an item (or press
its number), hover any row for a fuller explanation, then **NEXT WAVE** /
Space to continue. Every ladder runs deep enough to soak late-game credits:

| Item | Effect |
|------|--------|
| Interceptor Battery / Reload | Field the auto-launcher (cheap!), then shorten its cooldown, 6s → 1s (multi-level) |
| Repair City | Rebuild one destroyed city (expensive) |
| Gun Shield / Shield Recharge | Fit a dome on the CIWS that absorbs one warhead, then buy down its recharge (multi-level) |
| Laser Turret / Laser Recharge | Buy the autonomous beam, then speed its recharge (multi-level) |
| Upgrade Fire Rate | Faster CIWS cycle rate (multi-level) |
| Twin Barrels | One-time: a second barrel firing side-by-side (2× rounds) |

The **Gun Shield** (a regular shop item) fits a dome over the CIWS that
**intercepts one warhead on contact** — the missile detonates against the dome
instead of the gun — then **fails with a burst** and **recharges** (~10s,
upgradable down to ~2.5s via Shield Recharge levels). Cities can't be
shielded; the dome is how you survive a hit that would otherwise instantly end
the run.

Repairs are deliberately costly, so losing a city is a real setback.

Prices, amounts and earnings live in `config.economy`, `config.shop`, and
`config.shield`.

### Rules

- 6 wide cities cluster around a single central CIWS gun — flanked by the
  laser emplacement (left, once bought) and the interceptor launch rail
  (right; the missile tip shows whenever a launch is ready). Most missiles
  rain from the top; cruise missiles and drone swarms sweep in from the edges.
- The turret nearest your cursor is active and tracks the mouse. Rounds
  disperse in a small cone, so closer, well-led shots land more reliably. One
  hit destroys a standard missile.
- A missile reaching the ground blasts everything within its radius — a hit
  anywhere on a city's footprint counts, not just dead centre. Lose all
  cities, or take a **single hit on the central gun**, and it's game over —
  unless a **shield bubble** is up to absorb it (see the shop).
- Enemies are programmed against structures that are alive **or fell earlier
  this same wave** (their salvo was targeted before the city dropped); from
  the next wave on, known rubble draws no fire. About a third of all shots
  miss into the gaps regardless.
- Clearing a wave awards bonuses for surviving cities, and the interceptor
  launcher and laser come back fully charged.

### Threats

| Threat | Appears | Behaviour |
|--------|---------|-----------|
| Standard RV (red) | wave 1+ | Straight dive toward a structure; 1 hit |
| Drone swarm (gray, squat) | wave 2+ | Four slow gliders from one screen edge (counts as one wave slot), each with its own target; 1 hit each |
| Evasive RV (purple) | wave 2+ | Weaves on an irregular path; 1 hit |
| MIRV bus (green, large) | wave 3+ | Armoured (3 hits); splits into red RVs at altitude |
| Cruise missile (gold) | wave 3+ | Enters from a screen edge at low altitude, pops up, then dives; 2 hits |
| Hypersonic (orange dart) | wave 4+ | Very fast and barely slows in the dense air; 1 hit but hard to track |
| Stealth cruise (pale, ghostly) | wave 6+ | Flies the cruise profile **cloaked** — invisible, silent, no lock-on, no laser — until its pop-up; a blind CIWS sweep can still clip it; 2 hits |
| Nuke (crimson, huge) | wave 5+ | Announced by a klaxon and a **"Nuclear launch detected"** voice a few seconds before it appears. **Massively armoured** (40 hits — interceptors alone can't stop it; the gun must pile on or it WILL land), only targets cities — if it lands, it levels **every city on that half of the map** (max 1/wave) |

A non-killing hit on the armoured MIRV flashes it white with a metallic ting —
chip it down with the gun, or pop the whole bus with one interceptor before it
splits. Missile **speed is constant across waves** (~240 px/s base); difficulty
ramps via missile *count*, spawn *cadence*, and the threat *mix*, not speed.

Per-type hit points live in `config.missile.hp` and are fully tunable.

## Physics

A simple shared atmosphere ([physics.js](js/physics.js)) governs everything that
flies. Air is **thin up high and dense near the ground** (density decays
exponentially with altitude), and quadratic drag scales with that density and
with speed:

- **CIWS rounds** feel gravity and drag — they slow and **arc**, so long shots
  need lead (the gun is genuinely close-in). Drag is tuned so a straight-up
  burst **just barely reaches the top of the field**, and climbing rounds
  **self-destruct at apogee** — no tracers raining back onto the cities.
- **Enemy missiles** feel drag only (no gravity, so they still track their
  target) — they **decelerate as they sink** into denser air, giving you more
  time to engage them low.
- **Interceptors** fly a real two-phase profile: a powered **boost** (with a
  rocket-engine roar) that accelerates them to top speed, then an unpowered
  **coast** where gravity and drag bleed off energy while they keep steering.
  Their turn rate and acceleration are limited, so they reliably kill slow/
  straight threats but can **overshoot and miss** fast ones — late-game
  hypersonics in particular will sometimes outrun them.

Tunables live in `config.physics` (gravity, scale height, per-projectile drag).
The play field (`config.world`) is deliberately large so there's plenty of air.

## Architecture

Vanilla JS + Canvas/WebGL, no build step. Three.js is **vendored locally** under
`vendor/three/` (resolved via the import map in `index.html`), so the game runs
fully offline.

| File | Responsibility |
|------|----------------|
| `index.html` / `style.css` | Import map + layered canvases (WebGL scene, 2D HUD) |
| `js/config.js` | **All tunable values** — balance the game here |
| `js/utils.js` | Math helpers (clamp, rand, distance, array culling) |
| `js/physics.js` | Altitude-based air-density model + quadratic drag helper |
| `js/entities.js` | `City`, `Turret`, `Bullet`, `EnemyMissile`, `Interceptor`, `Particle` (data + update, no draw) |
| `js/weapons.js` | `CIWSWeapon`, `InterceptorWeapon` — stats, inventory, upgrades, fire logic |
| `js/audio.js` | Procedural Web Audio SFX (singleton `sfx`) |
| `js/renderer3d.js` | `Renderer`: Three.js scene, bloom, GPU buffers, projection |
| `js/game.js` | `Game`: state machine, waves, input, simulation, 2D HUD |
| `js/main.js` | Canvas wiring (creates the Renderer, injects it into Game) + rAF loop |
| `vendor/three/` | Pinned Three.js r160 core + postprocessing addons |
| `serve.py` | No-cache static dev server |
| `tests/` | `bun test` suite + setup/helpers |

**Dependency injection:** `main.js` constructs the WebGL `Renderer` and passes it
into `new Game(hudCanvas, renderer)`. `Game` never imports the renderer (or
Three.js), so the whole simulation loads and runs headlessly under `bun test`
with a stub renderer. Audio is likewise inert until a user gesture calls
`sfx.unlock()`, so it needs no stubbing in tests.

**Separation of concerns:** the simulation runs in a **fixed virtual resolution**
(`config.world`, default 1280×800) so balance — distances, speeds, gun spacing —
never depends on the window size. The camera *contains* that fixed play field at
any window aspect (extra sky/ground letterboxes around it). `renderer3d.js` maps
sim space to 3D world space, draws everything as emissive neon with an
UnrealBloom pass, and exposes `screenToWorld` / `worldToScreen` so input and the
HUD overlay stay aligned with the tilted camera. The HUD/menus/shop are drawn in
screen space (window pixels); the in-world HUD bits (ammo readouts, lock reticle)
project through the camera. Entities carry no draw code — the renderer reads
their fields.

## License

MIT (see [LICENSE](LICENSE)). Three.js is vendored under `vendor/three/` and
carries its own MIT license.

## Roadmap

This is the foundation for a broader missile-defense game. Natural next steps:

- More weapon systems on the `weapons.js` abstraction (e.g. long-range vs.
  point-defense interceptors, flak, lasers) and more shop upgrades.
- More threat variety: cruise missiles (curving paths), saturation salvos,
  decoys, and aircraft.
- Deeper economy: persistent upgrades across runs, city armour, etc.
- High-score persistence and a music bed.
