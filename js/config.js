// ---------------------------------------------------------------------------
// Central configuration. Everything tunable lives here so balancing the game
// is a matter of editing one file. Distances are in CSS pixels, time in
// seconds, angles in radians unless a name ends in "Deg".
// ---------------------------------------------------------------------------

export const CONFIG = {
  // --- World layout -------------------------------------------------------
  // Fixed virtual resolution the simulation always runs at. The window can be
  // any size/shape; the camera scales this to fit (so balance never changes).
  // Large field => everything is relatively small and spread out (lots of air).
  // Tall field: threats appear well above the CIWS's comfortable envelope —
  // you SEE them early, but up high only interceptors reach reliably.
  world: { width: 1400, height: 1350 },
  groundHeight: 70, // height of the ground strip at the bottom

  // --- Physics ------------------------------------------------------------
  // Air is thin up high and dense near the ground; drag scales with density and
  // speed (quadratic). Sim +y points DOWN, so gravity is a positive vy term.
  physics: {
    gravity: 400, // px/s^2 pulling everything toward the ground
    bulletGravityMul: 1.0, // CIWS rounds could feel extra gravity if > 1.0 (more visible drop)
    scaleHeight: 0.5, // density e-folds over this fraction of the play height
    densityFloor: 0.1, // minimum air density (way up high)
    bulletDrag: 0.00035, // quadratic drag coeff for CIWS rounds — tuned so a
    // straight-up burst just barely kisses the top of the field
    missileDrag: 0.0011, // drag coeff for enemy missiles (slows them down low)
    interceptorDrag: 0.0018, // drag coeff for coasting interceptors (bleeds energy fast)
  },
  cityCount: 6,
  turretCount: 1, // a single central CIWS — one hit on it loses the game
  edgePadding: 215, // horizontal padding before the first / after the last slot

  // --- CIWS turret --------------------------------------------------------
  turret: {
    barrelLength: 28,
    baseRadius: 18,
    pivotHeight: 21, // height of the gun trunnion above the ground (sim px)
    startAmmo: Infinity, // the belt feed is endless — the gun never runs dry
    fireInterval: 0.038, // seconds between rounds while firing (~26 rounds/s)
    dispersionDeg: 0.8, // half-angle of the random firing cone (tight)
    twinSpacing: 8, // px between the two barrels once the twin upgrade is bought
  },

  // --- Bullets (tracer rounds) -------------------------------------------
  bullet: {
    speed: 1120, // px/s muzzle velocity
    damage: 1, // HP one CIWS round strips from whatever it hits
    lifetime: 3.5, // seconds before the round self-destructs
    radius: 2,
    tracerLength: 18, // visual length of the tracer streak
  },

  // --- Enemy missiles -----------------------------------------------------
  missile: {
    radius: 4,
    baseSpeed: 190, // px/s — constant across waves
    speedPerWave: 0, // no per-wave speed ramp; difficulty comes from count/mix
    speedJitter: 0.18, // +/- fraction of random speed variation
    hitPadding: 5, // extra hit radius added to bullet+missile radii
    blastRadius: 30, // ground-impact blast radius (damages structures)
    // Aiming: most missiles aim near a structure (alive or rubble) with scatter;
    // some aim at a random ground point, so plenty miss into the gaps.
    aimJitter: 36, // +/- px scatter around the chosen structure
    randomAimChance: 0.33, // chance to instead miss into a random ground point
    trailMaxPoints: 16, // length of the stored trail polyline
    trailMinStep: 7, // min px between stored trail points

    // CIWS rounds needed to destroy each variant (tunable per type). A MIRV
    // carrier is armoured; once it splits, the children are regular 1-hit RVs.
    hp: { normal: 1, evasive: 1, hypersonic: 1, mirv: 3, cruise: 2, stealth: 2, drone: 1, nuke: 40 },
    hitFlashTime: 0.12, // seconds the body flashes white on a non-killing hit

    // MIRV splitting. The carrier "bus" is larger and a distinct colour until
    // it splits, at which point it (and its children) become regular red RVs.
    splitFromWave: 3,
    splitChance: 0.18,
    splitChildren: [2, 3], // min/max children when a missile splits
    splitAltitude: [0.32, 0.55], // fraction of play height where splits occur
    mirvScale: 1.8, // size multiplier for an unsplit MIRV carrier

    // Hypersonic variant: comes in very fast and barely slows (it punches
    // through the dense air), so it's hard to track. Fragile (1 hit) but scary.
    hypersonic: {
      fromWave: 4,
      chance: 0.16,
      speedFactor: 2.5, // multiple of the base missile speed
      dragFactor: 0.35, // fraction of normal drag (stays fast low down)
    },

    // Cruise missile: enters from a screen edge at low altitude, runs flat at
    // the deck, then pops up short of its target and dives onto it.
    cruise: {
      fromWave: 3,
      chance: 0.13,
      speedFactor: 1.3,
      altFrac: [0.55, 0.72], // spawn altitude (fraction of play height)
      popupDist: 270, // horizontal px before the target where the pop-up starts
      popupHeight: 230, // px it climbs above its cruise altitude
      turnRate: 2.8, // rad/s steering limit between flight legs
    },

    // Stealth cruise missile: flies the same profile as the regular cruise
    // missile but is cloaked until its pop-up — invisible, silent, and
    // untargetable by the lock-on/laser (a blind CIWS sweep can still clip it).
    stealth: {
      fromWave: 6,
      chance: 0.1,
      speedFactor: 1.35,
    },

    // Drone: slow, cheap, comes from the side in a swarm — each picks its own
    // (often overlapping) target, glides level, then tips into a shallow dive.
    drone: {
      fromWave: 2,
      chance: 0.1,
      speedFactor: 0.55,
      groupSize: 4,
      altFrac: [0.3, 0.6], // per-drone spawn altitude band
      diveDist: 200, // horizontal px before the target where the dive starts
      turnRate: 2.0,
    },

    // Nuke: a slow, heavily-armoured ballistic warhead that only ever targets
    // cities. If it reaches the ground it vaporizes every city on that half of
    // the map. Shoot it down or eat the loss.
    nuke: {
      fromWave: 5,
      chance: 0.07,
      maxPerWave: 1,
      speedFactor: 0.7,
      scale: 2.4, // visual size multiplier
      warningTime: 3, // seconds between the launch warning and it appearing
    },

    // Evasive (weaving) variant. The weave is a sum of several sine components
    // with randomized frequencies/phases per missile, so each one jinks on its
    // own irregular rhythm rather than a predictable wobble.
    evasive: {
      fromWave: 2,
      chance: 0.28, // probability a given missile is evasive
      speedFactor: 1.12, // a touch faster than a normal missile
      weaveAmp: 54, // px of lateral sway
      weaveComponents: 3, // number of summed sine terms
      weaveFreqMin: 2.2, // rad/s
      weaveFreqMax: 7.5, // rad/s
    },
  },

  // --- Interceptors (autonomous homing anti-missiles) ---------------------
  interceptor: {
    // Unlimited stock, gated by a reload cooldown; the launcher starts every
    // wave UNLOADED (first shot comes one full reload in). Index = upgrade
    // level; buy levels in the shop to launch more often.
    cooldowns: [6, 4.75, 3.75, 3, 2.4, 1.8, 1.4, 1],
    // Auto-targeting: the launcher fires itself at the highest-value threat,
    // biased toward distant ones. It never engages drones, and anything
    // inside the minimum engagement distance is the gun's/laser's business.
    minTargetDist: 240,
    launcherOffsetX: 46, // launcher emplacement sits right of the CIWS mount
    launcherHeight: 34, // top of the erected launch pod (missiles leave vertically)
    smokeRate: 50, // boost-phase exhaust puffs per second (white solid-motor smoke)
    // Two-phase flight, like a real missile: a powered boost then a coast.
    launchSpeed: 170, // px/s off the rail
    boostTime: 0.55, // seconds of powered flight
    thrust: 1700, // px/s^2 acceleration during boost (gentler ramp)
    maxSpeed: 1060, // speed cap (outpaces fast threats, but not by much)
    turnRate: 3.8, // rad/s homing turn rate (tighter turns, can still overshoot)
    turnBleed: 0.45, // fraction of speed scrubbed per radian of post-boost turning
    minSpeed: 240, // below this it lacks maneuvering energy and self-destructs
    detonateRadius: 24, // must pass this close to detonate (tighter => can miss)
    blastRadius: 72, // area damage radius on detonation
    blastDamage: 7, // HP one blast strips from everything in radius — a 40-HP
    // nuke shrugs off interceptors alone; the gun has to help or it lands
    lifetime: 5.0, // seconds before self-destruct
    trailMaxPoints: 20,
    trailMinStep: 6,
  },

  // --- Laser (purchasable autonomous point-defense beam) ------------------
  laser: {
    cost: 70, // one-time purchase
    upgradeCosts: [40, 65, 95, 140, 200], // recharge upgrades after it's owned
    cooldowns: [6, 4.5, 3.2, 2.2, 1.5, 1], // recharge between burns, by upgrade level
    dps: 2.6, // HP/s burned at point-blank; falls off with distance
    fullPowerDist: 280, // beam burns at full dps inside this distance
    range: 720, // beyond this the laser can't latch on at all
    turnRate: 4.0, // rad/s the emitter head can slew (it must aim before burning)
    aimToleranceDeg: 4, // burns only once aimed within this of the target
    minElevationDeg: 15, // can't depress below this above the horizon
    barrelLength: 13, // emitter barrel length (beam originates at its tip)
    beamTime: 0.22, // seconds the beam visual lingers after the burn ends
    offsetX: -46, // emplacement sits left of the CIWS mount
    emitterHeight: 26, // beam origin height above the ground
    // It only engages cheap, predictable targets: drones and plain RVs
    // (post-split MIRV children included; armoured carriers excluded).
  },

  // --- Gun shield (a shop upgrade ladder; cities can't be shielded) -------
  shield: {
    // First purchase fits the dome on the CIWS; later ones speed its recharge.
    costs: [55, 35, 55, 80, 120, 170],
    rechargeTimes: [10, 7, 4.5, 2.5, 1.6, 1], // seconds to come back, by upgrade level
    maxPerStructure: 1, // one shield at a time (no stacking)
    radius: 72, // dome radius (world units) — also the interception range
    flashTime: 0.4, // seconds the dome flares/collapses when it fails
  },

  // --- Waves --------------------------------------------------------------
  wave: {
    baseMissiles: 19, // missiles on wave 1
    missilesPerWave: 4, // additional missiles each wave
    baseSpawnGap: 1.05, // seconds between spawns on wave 1
    spawnGapPerWave: 0.1, // spawn gap reduction per wave
    minSpawnGap: 0.35,
    endDelay: 1.0, // beat after the last threat dies before the wave clears
    intermissionTime: 4.0, // seconds of breather between waves
  },

  // --- Scoring ------------------------------------------------------------
  score: {
    perKill: 25,
    citySurvivalBonus: 100, // per surviving city, end of wave
  },

  // --- Economy (credits = the shop currency, separate from score) ---------
  economy: {
    startCredits: 4,
    // Per-type kill bounty. A MIRV carrier pays its big bounty only while
    // unsplit; its children (and a post-split body) pay the normal rate.
    bounty: { normal: 1, evasive: 2, hypersonic: 3, mirv: 4, cruise: 3, stealth: 4, drone: 1, nuke: 12 },
    clearBonus: 5, // destroyed every enemy this wave (nothing leaked)
    perCitySurvived: 2, // credits per surviving city, end of wave
  },

  // --- Between-wave shop --------------------------------------------------
  shop: {
    // Interceptor stock is unlimited; you buy down the reload cooldown.
    // Length = max upgrade levels (matches interceptor.cooldowns - 1).
    interceptorCost: 10, // buy the battery itself — cheap, the natural first purchase
    interceptorCooldownCosts: [25, 45, 70, 110, 160, 220, 300],
    repairCityCost: 90, // cost to repair a destroyed city
    fireRateCosts: [25, 40, 60, 90, 130, 180],
    fireRateFactor: 0.82, // fire interval multiplier per level
    twinBarrelCost: 80, // one-time: a second barrel firing side by side
  },

  // --- 3D render / bloom --------------------------------------------------
  render: {
    fov: 34,
    // Camera frames the full play column: it fits a vertical half-extent of
    // coverFrac * playHeight around the centre, with a gentle downward tilt
    // (tiltFrac * playHeight) for depth. Distance is derived from the FOV.
    // 0.52 ≈ edge-to-edge vertically (the HUD lives in the side columns).
    coverFrac: 0.52,
    widthMargin: 1.02, // horizontal fit margin (so edge cities aren't clipped)
    tiltFrac: 0.05,
    cityDepth: 18, // building extrusion depth (z)
    bloom: { strength: 0.55, radius: 0.6, threshold: 0.3 },
    maxParticles: 900,
    maxSmoke: 500,
    maxMissiles: 220,
    maxBullets: 700, // headroom for a max-fire-rate twin-barrel stream
    maxInterceptors: 16,
    maxExplosions: 24, // pooled fireball/shockwave effects
    exposure: 1.05,
  },

  // --- Explosion visuals (fireball flash + expanding shockwave ring) -------
  explosion: {
    small: { radius: 46, dur: 0.45 }, // bullet kill
    medium: { radius: 80, dur: 0.6 }, // ground impact / interceptor burst
    large: { radius: 140, dur: 0.85 }, // structure destroyed
    nuke: { radius: 380, dur: 1.8 }, // a nuke reached the ground
    smokePer: { small: 4, medium: 8, large: 16, nuke: 40 }, // lingering smoke puffs
  },

  // --- Audio --------------------------------------------------------------
  audio: {
    masterVolume: 1.5, // pushed hard; a limiter on the master tames the peaks
    panWidth: 0.75, // how far x position maps into the stereo field (0..1)
    reverbSeconds: 1.8, // generated impulse-response tail length
    reverbDecay: 3.5, // exponential decay power of the tail
  },

  // --- UI -----------------------------------------------------------------
  ui: {
    floatTextLife: 0.95, // seconds a floating "+credits" label lasts
    floatTextRise: 56, // px it drifts upward over its life
  },

  // --- Visual / palette (CSS color strings; THREE.Color accepts these) ----
  colors: {
    sky: ['#0a1428', '#05070d'],
    ground: '#0d1320',
    groundLine: '#2c5a8f',
    city: '#37e0d8',
    cityDead: '#2a3340',
    turret: '#8893a4',
    turretActive: '#ffb347',
    barrel: '#c2ccda',
    missile: '#ff5a4d',
    missileEvasive: '#c264ff',
    missileHypersonic: '#ff7a1f',
    missileMirv: '#9bff42',
    missileCruise: '#ffd84d',
    missileStealth: '#b9c8ff',
    missileDrone: '#c9d4df',
    missileNuke: '#ff2438',
    missileTrail: '#ff5a4d',
    laser: '#ff4df0',
    bullet: '#ffe98a',
    hitSpark: '#ffffff',
    smoke: '#3a4252',
    rocketSmoke: '#e6ebf2',
    fireball: '#ffd9a0',
    interceptor: '#7cc6ff',
    interceptorTrail: '#7cc6ff',
    interceptorBlast: '#9be7ff',
    lock: '#86f7ff',
    shield: '#6cf0ff',
    explosion: '#ffb347',
    groundExplosion: '#ff5a4d',
    crosshair: '#ffe98a',
    crosshairEmpty: '#ff5a4d',
    credits: '#ffd86b',
    shopPanel: 'rgba(14,22,38,0.92)',
    shopRow: 'rgba(40,58,86,0.55)',
    shopRowHover: 'rgba(80,120,170,0.7)',
    hud: '#bcd2e6',
    hudDim: '#5a6b7d',
  },
};
