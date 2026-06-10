// ---------------------------------------------------------------------------
// Game — owns all simulation state, the wave/score logic, input and the HUD.
// The 3D world is drawn by the WebGL Renderer; this class draws the 2D HUD /
// menus on an overlay canvas and feeds the renderer each frame.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { clamp, rand, randInt, dist2, removeWhere, pick, TAU } from './utils.js';
import {
  City,
  Turret,
  EnemyMissile,
  explode,
  explodeRing,
  explodeCone,
  smokePuff,
} from './entities.js';
import { CIWSWeapon, InterceptorWeapon, LaserWeapon } from './weapons.js';
import { sfx } from './audio.js';
import { scoreboard } from './scores.js';

const C = CONFIG.colors;

export class Game {
  // The renderer is injected (not imported) so the simulation has no hard
  // dependency on WebGL/Three.js — that keeps the game logic headless-testable.
  constructor(hudCanvas, renderer) {
    this.hudCanvas = hudCanvas;
    this.hctx = hudCanvas.getContext('2d');
    this.renderer = renderer;

    this.cities = [];
    this.turrets = [];
    this.missiles = [];
    this.bullets = [];
    this.particles = [];
    this.explosions = []; // transient fireball/shockwave visual events
    this.interceptorList = []; // in-flight interceptors
    this.floatTexts = []; // floating "+credits" labels on kills

    // Weapon systems + economy.
    this.ciws = new CIWSWeapon();
    this.interceptorWeapon = new InterceptorWeapon();
    this.laser = new LaserWeapon();
    this.laserBeams = []; // fading beam visuals {x1,y1,x2,y2,life,maxLife}
    this.laserBeamLive = null; // the sustained beam while a burn is in progress
    this.shieldLevel = 0; // gun-shield upgrades bought (0 = no shield)
    this.nukesSpawned = 0; // nukes rolled this wave (capped per wave)
    this.pendingNukes = []; // countdowns between launch warning and spawn
    this.credits = 0;
    this.waveEarned = 0; // credits earned during the current wave (shop display)
    this.waveLeaks = 0; // missiles that reached the ground this wave
    this.waveBreakdown = null; // credit sources for the shop summary
    this._shopRects = []; // hit-test rects, rebuilt each shop frame

    this.state = 'menu'; // menu | playing | intermission | gameover
    this.scoreboard = scoreboard; // injectable for tests
    this.lastRun = null; // { scores, rank } from the most recent game over
    this.paused = false;
    this.time = 0; // accumulates for HUD animations
    this.lossReason = null; // why the last game ended (for the game-over screen)

    // pointer* = raw screen pixels (crosshair); mouse* = simulation coords (aim)
    this.pointerX = window.innerWidth / 2;
    this.pointerY = window.innerHeight / 3;
    this.mouseX = this.pointerX;
    this.mouseY = this.pointerY;
    this.activeTurret = null;

    this.score = 0;
    this.wave = 0;
    this.toSpawn = 0;
    this.waveSpawnTotal = 0;
    this.mushrooms = []; // active mushroom-cloud emitters {x, y, groundY, age}
    this.spawnTimer = 0;
    this.spawnGap = CONFIG.wave.baseSpawnGap;
    this.waveEndTimer = 0; // grace beat after the last threat before clearing
    this.nextWave = 1;

    this.shakeTime = 0;
    this.shakeMag = 0;

    this.resize();
    // Default aim at the centre of the (now fixed) simulation space.
    this.mouseX = this.W / 2;
    this.mouseY = this.H / 3;
    this.bindInput();
  }

  // -------------------------------------------------------------------------
  // Layout & sizing
  // -------------------------------------------------------------------------
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.screenW = window.innerWidth;
    this.screenH = window.innerHeight;

    // Fixed simulation space — gameplay always runs at this virtual resolution
    // so distances, speeds and spacing (i.e. balance) never depend on the
    // window size. The camera scales it to fit the screen.
    this.W = CONFIG.world.width;
    this.H = CONFIG.world.height;
    this.groundY = this.H - CONFIG.groundHeight;

    // HUD overlay canvas is sized to the actual window (screen-space UI).
    this.hudCanvas.width = Math.floor(this.screenW * dpr);
    this.hudCanvas.height = Math.floor(this.screenH * dpr);
    this.hctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.renderer.setSize(this.screenW, this.screenH);
    this.layout();
  }

  computeSlots() {
    const total = CONFIG.cityCount + CONFIG.turretCount;
    const turretIdx = new Set();
    if (CONFIG.turretCount === 1) {
      turretIdx.add(Math.round((total - 1) / 2)); // single gun sits dead centre
    } else {
      const denom = CONFIG.turretCount - 1;
      for (let i = 0; i < CONFIG.turretCount; i++) {
        turretIdx.add(Math.round((i * (total - 1)) / denom));
      }
    }
    const usable = this.W - CONFIG.edgePadding * 2;
    const slots = [];
    for (let i = 0; i < total; i++) {
      const x =
        total > 1 ? CONFIG.edgePadding + (usable * i) / (total - 1) : this.W / 2;
      slots.push({ x, type: turretIdx.has(i) ? 'turret' : 'city' });
    }
    return slots;
  }

  layout() {
    const slots = this.computeSlots();
    const fresh = this.cities.length === 0 && this.turrets.length === 0;
    if (fresh) {
      for (const s of slots) {
        if (s.type === 'turret') this.turrets.push(new Turret(s.x, this.groundY));
        else this.cities.push(new City(s.x, this.groundY));
      }
    } else {
      let ci = 0;
      let ti = 0;
      for (const s of slots) {
        if (s.type === 'turret') {
          const t = this.turrets[ti++];
          if (t) {
            t.x = s.x;
            t.groundY = this.groundY;
            t.y = this.groundY - CONFIG.turret.pivotHeight;
          }
        } else {
          const c = this.cities[ci++];
          if (c) {
            c.x = s.x;
            c.groundY = this.groundY;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Game flow
  // -------------------------------------------------------------------------
  startGame() {
    this.cities = [];
    this.turrets = [];
    this.missiles = [];
    this.bullets = [];
    this.particles = [];
    this.explosions = [];
    this.interceptorList = [];
    this.floatTexts = [];
    this.score = 0;
    this.credits = CONFIG.economy.startCredits;
    this.ciws = new CIWSWeapon();
    this.interceptorWeapon = new InterceptorWeapon();
    this.laser = new LaserWeapon();
    this.laserBeams = [];
    this.laserBeamLive = null;
    this.shieldLevel = 0;
    this.pendingNukes = [];
    this.mushrooms = [];
    this.paused = false; // restarting (R) always unpauses
    this.layout();
    this.renderer.syncStructures(this); // rebuild meshes for the fresh skyline
    this.startWave(1);
  }

  startWave(n) {
    this.wave = n;
    // No ordnance carries over between waves. Guns reload to their (possibly
    // upgraded) capacity, and interceptors refill to their per-wave capacity.
    this.bullets = [];
    this.interceptorList = [];
    this.laserBeams = [];
    this.laserBeamLive = null;
    this.laser.target = null;
    this.waveEarned = 0;
    this.waveLeaks = 0;
    this.nukesSpawned = 0;
    this.pendingNukes = [];
    this.ciws.reloadAll(this.turrets);
    this.interceptorWeapon.refill();
    this.laser.timer = 0; // laser comes back charged each wave
    for (const t of this.turrets) {
      if (t.alive) {
        t.shields = t.shieldMax; // the gun shield comes back fully each wave
        t.shieldTimer = this.shieldRechargeTime();
      }
    }
    this.toSpawn =
      CONFIG.wave.baseMissiles + (n - 1) * CONFIG.wave.missilesPerWave;
    this.waveSpawnTotal = this.toSpawn; // for "how far into the wave are we"
    this.spawnGap = Math.max(
      CONFIG.wave.minSpawnGap,
      CONFIG.wave.baseSpawnGap - (n - 1) * CONFIG.wave.spawnGapPerWave
    );
    this.spawnTimer = rand(0.3, this.spawnGap);
    this.waveEndTimer = 0;
    this.state = 'playing';
  }

  endWave() {
    const E = CONFIG.economy;
    const survivingCities = this.cities.filter((c) => c.alive).length;

    // Score bonuses (cumulative bragging metric).
    this.score += survivingCities * CONFIG.score.citySurvivalBonus;

    // Credit breakdown. Kill bounties were banked during the wave (waveEarned
    // holds them so far); the end-of-wave bonuses are added on top.
    const kills = this.waveEarned;
    const clear = this.waveLeaks === 0 ? E.clearBonus : 0;
    const city = survivingCities * E.perCitySurvived;
    this.earnCredits(clear + city);
    this.waveBreakdown = { kills, clear, city };

    // Clear in-flight ordnance; the shop holds until the player proceeds.
    this.bullets = [];
    this.interceptorList = [];
    this.nextWave = this.wave + 1;
    this.state = 'intermission';
    this.laserBeamLive = null;
    this.laser.target = null;
    sfx.waveClear();
  }

  /** Award credits and track what was earned this wave (for the shop display). */
  earnCredits(n) {
    this.credits += n;
    this.waveEarned += n;
  }

  /** Credit bounty for destroying a given missile, by its current variant. */
  missileBounty(m) {
    const b = CONFIG.economy.bounty;
    if (m.splitsRemaining > 0) return b.mirv; // unsplit MIRV carrier
    return b[m.type] || b.normal;
  }

  /** Score + credits for a kill, with a floating "+N" credit label at the spot. */
  rewardKill(m) {
    const bounty = this.missileBounty(m);
    this.score += CONFIG.score.perKill;
    this.earnCredits(bounty);
    this.spawnFloatText(m.x, m.y, `+${bounty}`, C.credits);
  }

  spawnFloatText(x, y, text, color) {
    this.floatTexts.push({
      x,
      y,
      text,
      color,
      life: CONFIG.ui.floatTextLife,
      maxLife: CONFIG.ui.floatTextLife,
    });
  }

  proceedToNextWave() {
    if (this.state === 'intermission') this.startWave(this.nextWave);
  }

  gameOver(reason = 'Defeat') {
    this.state = 'gameover';
    this.lossReason = reason;
    this.laserBeamLive = null;
    // Bank the run on the local high-score table (no-op without storage).
    this.lastRun = this.scoreboard.add(this.score, this.wave);
    sfx.gameOver();
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------
  aliveStructures() {
    const out = [];
    for (const c of this.cities) if (c.alive) out.push(c);
    for (const t of this.turrets) if (t.alive) out.push(t);
    return out;
  }

  /**
   * Structures enemies may be programmed against: anything alive, plus rubble
   * made THIS wave (the salvo was targeted before the city fell). Cities lost
   * in earlier waves are known dead and don't draw fire.
   */
  aimableStructures() {
    const out = [];
    for (const s of [...this.cities, ...this.turrets]) {
      if (s.alive || s.destroyedWave === this.wave) out.push(s);
    }
    return out.length ? out : this.aliveStructures();
  }

  /** Half-width of a structure's footprint (for ground-blast hit tests). */
  structureHalfWidth(s) {
    return s.width ? s.width / 2 : CONFIG.turret.baseRadius;
  }

  /** Base missile speed for this wave, with per-missile jitter. */
  rollSpeed() {
    const M = CONFIG.missile;
    return (
      (M.baseSpeed + (this.wave - 1) * M.speedPerWave) *
      rand(1 - M.speedJitter, 1 + M.speedJitter)
    );
  }

  spawnMissile() {
    const M = CONFIG.missile;
    const { type, children } = this.chooseThreat();

    if (type === 'drone') {
      this.spawnDroneGroup();
      return;
    }
    if (type === 'cruise' || type === 'stealth') {
      this.spawnCruise(type);
      return;
    }
    if (type === 'bomber') {
      this.spawnBomber();
      return;
    }
    if (type === 'nuke') {
      this.spawnNuke();
      return;
    }

    const startX = rand(20, this.W - 20);
    // Aim near a structure (alive OR rubble) with scatter, or — sometimes — at a
    // random ground point. Plenty land in the gaps and miss everything.
    let targetX;
    if (Math.random() < M.randomAimChance) {
      targetX = rand(CONFIG.edgePadding * 0.5, this.W - CONFIG.edgePadding * 0.5);
    } else {
      const target = pick(this.aimableStructures());
      targetX = target.x + rand(-M.aimJitter, M.aimJitter);
    }

    let speed = this.rollSpeed();
    if (type === 'hypersonic') speed *= M.hypersonic.speedFactor;
    else if (type === 'evasive') speed *= M.evasive.speedFactor;

    this.missiles.push(
      new EnemyMissile(startX, -10, targetX, this.groundY, speed, children, this.groundY, type)
    );
    // Only the hypersonic gets an audible cue (its incoming scream) — ordinary
    // spawns are silent so the soundscape stays clean.
    if (type === 'hypersonic') sfx.hypersonicLaunch(this.pan(startX));
  }

  /**
   * Cruise missile: enters from a screen edge low, pops up, dives on a target.
   * The stealth variant flies the same profile, cloaked until the pop-up.
   */
  spawnCruise(type = 'cruise') {
    const cfg = CONFIG.missile.cruise;
    const target = pick(this.aimableStructures());
    const targetX = target.x + rand(-CONFIG.missile.aimJitter, CONFIG.missile.aimJitter);
    // Enter from whichever edge gives it a longer run-in.
    const fromLeft = targetX > this.W / 2 ? true : false;
    const startX = fromLeft ? -30 : this.W + 30;
    const startY = this.groundY * rand(cfg.altFrac[0], cfg.altFrac[1]);
    const speed = this.rollSpeed() * CONFIG.missile[type].speedFactor;
    this.missiles.push(
      new EnemyMissile(startX, startY, targetX, this.groundY, speed, 0, 0, type)
    );
  }

  /** Drone swarm: a group from one edge, each with its own (overlapping) target. */
  spawnDroneGroup() {
    const cfg = CONFIG.missile.drone;
    const fromLeft = Math.random() < 0.5;
    // The whole group counts as ONE enemy of the wave budget.
    const structures = this.aimableStructures();
    const n = cfg.groupSize;
    for (let i = 0; i < n; i++) {
      const target = pick(structures);
      const targetX = target.x + rand(-CONFIG.missile.aimJitter, CONFIG.missile.aimJitter);
      const startX = fromLeft ? -30 - i * 26 : this.W + 30 + i * 26;
      const startY = this.groundY * rand(cfg.altFrac[0], cfg.altFrac[1]);
      const speed = this.rollSpeed() * cfg.speedFactor;
      this.missiles.push(
        new EnemyMissile(startX, startY, targetX, this.groundY, speed, 0, 0, 'drone')
      );
    }
  }

  /** Bomber: a level pass across the upper sky, dropping bombs on the way. */
  spawnBomber() {
    const bc = CONFIG.missile.bomber;
    const fromLeft = Math.random() < 0.5;
    const startX = fromLeft ? -40 : this.W + 40;
    const exitX = fromLeft ? this.W + 100 : -100;
    const startY = this.groundY * rand(bc.altFrac[0], bc.altFrac[1]);
    const speed = this.rollSpeed() * bc.speedFactor;
    this.missiles.push(
      new EnemyMissile(startX, startY, exitX, startY, speed, 0, 0, 'bomber')
    );
  }

  /** Release one glide bomb from a bomber onto something in glide reach. */
  dropGlideBomb(bomber) {
    const bc = CONFIG.missile.bomber;
    const dir = Math.sign(bomber.vx) || 1;
    // Prefer a structure ahead and within glide reach; sometimes (or with
    // nothing in reach) the bomb just falls long into the dirt.
    const inReach = this.aimableStructures().filter(
      (s) => (s.x - bomber.x) * dir > 40 && Math.abs(s.x - bomber.x) < bc.reach
    );
    let tx;
    if (inReach.length && Math.random() >= CONFIG.missile.randomAimChance) {
      const target = pick(inReach);
      tx = target.x + rand(-CONFIG.missile.aimJitter, CONFIG.missile.aimJitter);
    } else {
      tx = bomber.x + dir * rand(80, bc.reach);
    }
    const speed = this.rollSpeed() * CONFIG.missile.glidebomb.speedFactor;
    this.missiles.push(
      new EnemyMissile(bomber.x, bomber.y + 14, tx, this.groundY, speed, 0, 0, 'glidebomb')
    );
    sfx.bombDrop(this.pan(bomber.x));
  }

  /**
   * Nuke: the launch is DETECTED a few seconds before the warhead appears —
   * klaxon plus a synthetic "Nuclear launch detected" voice — then it spawns.
   */
  spawnNuke() {
    this.nukesSpawned++;
    this.pendingNukes.push(CONFIG.missile.nuke.warningTime);
    sfx.alarm(0);
    sfx.say('Nuclear launch detected');
  }

  /**
   * The warned-of nuke actually enters: armoured, full ballistic speed, and
   * aimed at an INNER city — its blast levels the neighbours too, so an
   * outer-city shot would waste half its yield off the map. It only targets
   * the outermost cities when nothing inner is left standing.
   */
  launchNuke() {
    const alive = this.cities.filter((c) => c.alive);
    const outerA = this.cities[0];
    const outerB = this.cities[this.cities.length - 1];
    const inner = alive.filter((c) => c !== outerA && c !== outerB);
    const pool = inner.length ? inner : alive.length ? alive : this.cities;
    const target = pick(pool);
    const startX = rand(60, this.W - 60);
    const speed = this.rollSpeed() * CONFIG.missile.nuke.speedFactor;
    this.missiles.push(
      new EnemyMissile(startX, -10, target.x, this.groundY, speed, 0, 0, 'nuke')
    );
  }

  /**
   * Roll this wave's threat variant (mutually exclusive, so each stays
   * readable). Precedence: nuke > cruise > drone > hypersonic > evasive >
   * MIRV > plain. Returned as `{ type, children }` where children>0 marks a
   * (type 'normal') MIRV carrier.
   */
  chooseThreat() {
    const M = CONFIG.missile;
    // Nukes never open or close a wave — they arrive while you're already
    // busy. Late waves can roll two.
    const nukeCap = this.wave >= M.nuke.twoFromWave ? 2 : M.nuke.maxPerWave;
    const spawnedSoFar = this.waveSpawnTotal - this.toSpawn;
    if (
      this.wave >= M.nuke.fromWave &&
      this.nukesSpawned < nukeCap &&
      spawnedSoFar >= 2 && // not among the first two
      this.toSpawn >= 2 && // and at least one more follows it
      Math.random() < M.nuke.chance
    ) {
      return { type: 'nuke', children: 0 };
    }
    if (this.wave >= M.stealth.fromWave && Math.random() < M.stealth.chance) {
      return { type: 'stealth', children: 0 };
    }
    if (this.wave >= M.cruise.fromWave && Math.random() < M.cruise.chance) {
      return { type: 'cruise', children: 0 };
    }
    if (this.wave >= M.drone.fromWave && Math.random() < M.drone.chance) {
      return { type: 'drone', children: 0 };
    }
    if (this.wave >= M.bomber.fromWave && Math.random() < M.bomber.chance) {
      return { type: 'bomber', children: 0 };
    }
    if (this.wave >= M.hypersonic.fromWave && Math.random() < M.hypersonic.chance) {
      return { type: 'hypersonic', children: 0 };
    }
    if (this.wave >= M.evasive.fromWave && Math.random() < M.evasive.chance) {
      return { type: 'evasive', children: 0 };
    }
    if (this.wave >= M.splitFromWave && Math.random() < M.splitChance) {
      return { type: 'normal', children: randInt(M.splitChildren[0], M.splitChildren[1]) };
    }
    return { type: 'normal', children: 0 };
  }

  splitMissile(parent) {
    explode(this.particles, parent.x, parent.y, C.missile, 6);
    const targets = this.aliveStructures();
    if (targets.length === 0) return;
    for (let i = 0; i < parent.childCount; i++) {
      const target = pick(targets);
      this.missiles.push(
        new EnemyMissile(
          parent.x,
          parent.y,
          target.x + rand(-12, 12),
          this.groundY,
          parent.speed * rand(0.95, 1.2),
          0,
          0,
          'normal'
        )
      );
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------
  getActiveTurret() {
    let usable = null;
    let usableD = Infinity;
    let anyAlive = null;
    let aliveD = Infinity;
    for (const t of this.turrets) {
      if (!t.alive) continue;
      const d = Math.abs(t.x - this.mouseX);
      if (d < aliveD) {
        aliveD = d;
        anyAlive = t;
      }
      if (t.ammo > 0 && d < usableD) {
        usableD = d;
        usable = t;
      }
    }
    return usable || anyAlive;
  }

  update(dt) {
    if (this.paused) return;
    this.time += dt;

    for (const p of this.particles) p.update(dt);
    removeWhere(this.particles, (p) => p.dead);
    for (const e of this.explosions) e.age += dt;
    removeWhere(this.explosions, (e) => e.age >= e.dur);
    for (const b of this.laserBeams) b.life -= dt;
    removeWhere(this.laserBeams, (b) => b.life <= 0);

    // Mushroom clouds: after a nuke burst, keep feeding smoke into a rising
    // stem and a spreading cap for a few seconds. The hot dust glows warm
    // early, then cools to ash gray as it climbs.
    for (const mc of this.mushrooms) {
      mc.age += dt;
      const capY = mc.y - Math.min(300, mc.age * 110); // cap climbs, then slows
      if (Math.random() < dt * 30) {
        // Stem: a narrow column boiling up from the ground to the cap.
        smokePuff(
          this.particles,
          mc.x + rand(-24, 24),
          rand(capY + 40, mc.groundY - 6),
          1,
          mc.age < 1.2 ? '#c89a6e' : '#6e6258'
        );
      }
      if (mc.age > 0.4 && Math.random() < dt * 26) {
        // Cap: a broad, flattened head spreading at the top.
        smokePuff(
          this.particles,
          mc.x + rand(-95, 95),
          capY + rand(-24, 18),
          1,
          mc.age < 1.6 ? '#caa57e' : '#7a6e62'
        );
      }
    }
    removeWhere(this.mushrooms, (mc) => mc.age > 4.5);
    for (const ft of this.floatTexts) ft.life -= dt;
    removeWhere(this.floatTexts, (ft) => ft.life <= 0);
    if (this.shakeTime > 0) this.shakeTime -= dt;

    // Active turret tracks the cursor in every state (looks alive on menus).
    const active = this.getActiveTurret();
    this.activeTurret = active;
    if (active && this.state !== 'gameover') {
      active.aimAt(this.mouseX, this.mouseY);
    }
    for (const t of this.turrets) t.update(dt);

    if (this.state === 'playing') this.updatePlaying(dt);
    // 'intermission' just waits in the shop for the player to proceed.
  }

  /**
   * Autonomous laser: when charged, it latches onto the most urgent target it
   * can track (drones and normal-type missiles — fast movers are beyond it)
   * and burns it down over time, so bigger targets take a longer, committed
   * burn. After the kill it recharges. The beam originates from the laser
   * emplacement left of the gun mount.
   */
  updateLaser(dt) {
    const L = this.laser;
    const cfg = CONFIG.laser;
    if (!L.owned) return;
    const mount = this.turrets.find((t) => t.alive);
    if (!mount) {
      L.target = null;
      this.laserBeamLive = null;
      return;
    }
    const ex = mount.x + cfg.offsetX;
    const ey = this.groundY - cfg.emitterHeight;
    const beamDist = (m) => Math.hypot(m.x - ex, m.y - ey);
    // Elevation above the horizon (sim +y is down). The head can't depress
    // below its minimum firing arc, so deck-skimmers right on the horizon are
    // outside its envelope.
    const minElev = (cfg.minElevationDeg * Math.PI) / 180;
    const inArc = (m) => Math.atan2(ey - m.y, Math.abs(m.x - ex)) >= minElev;

    // Drop a target that died under gunfire, split away, flew out of range,
    // or dipped below the firing arc.
    if (
      L.target &&
      (L.target.dead ||
        !L.canTarget(L.target) ||
        beamDist(L.target) > cfg.range ||
        !inArc(L.target))
    ) {
      L.target = null;
    }

    if (!L.target) {
      this.laserBeamLive = null;
      L.update(dt); // recharge only while idle
      if (L.canFire) {
        let best = null;
        for (const m of this.missiles) {
          if (!L.canTarget(m) || m.stealthed) continue;
          if (beamDist(m) > cfg.range || !inArc(m)) continue; // outside envelope
          if (!best || m.y > best.y) best = m; // closest to the ground = most urgent
        }
        L.target = best;
      }
      if (!L.target) {
        // Idle: ease the head back to vertical.
        this.slewLaser(-Math.PI / 2, dt);
        return;
      }
    }

    // Slew the emitter head onto the target; it only burns once aligned.
    const m = L.target;
    const desired = Math.atan2(m.y - ey, m.x - ex);
    const err = this.slewLaser(desired, dt);
    if (err > (cfg.aimToleranceDeg * Math.PI) / 180) {
      this.laserBeamLive = null; // still traversing
      return;
    }

    // Burn. Output falls off with distance: full power inside fullPowerDist,
    // proportionally weaker out toward max range.
    if (this.laserBeamLive == null) sfx.laser(this.pan(m.x)); // burn just began
    const falloff = Math.min(1, cfg.fullPowerDist / beamDist(m));
    m.hp -= L.dps * falloff * dt;
    m.hitFlash = Math.max(m.hitFlash, 0.05); // sizzling-under-the-beam feedback
    // Beam leaves from the tip of the aimed barrel.
    const x1 = ex + Math.cos(L.angle) * cfg.barrelLength;
    const y1 = ey + Math.sin(L.angle) * cfg.barrelLength;
    this.laserBeamLive = { x1, y1, x2: m.x, y2: m.y };
    if (m.hp <= 0) {
      this.rewardKill(m);
      m.dead = true;
      this.killEffect(m);
      L.target = null;
      L.fire(); // start the recharge
      // Leave a fading after-beam at the kill.
      this.laserBeams.push({
        x1,
        y1,
        x2: m.x,
        y2: m.y,
        life: cfg.beamTime,
        maxLife: cfg.beamTime,
      });
      this.laserBeamLive = null;
    }
  }

  /** Slew the laser head toward `desired`; returns the remaining error. */
  slewLaser(desired, dt) {
    const L = this.laser;
    let d = desired - L.angle;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    const max = CONFIG.laser.turnRate * dt;
    if (Math.abs(d) <= max) {
      L.angle = desired;
      return 0;
    }
    L.angle += Math.sign(d) * max;
    return Math.abs(d) - max;
  }

  /** Current gun-shield recharge time, by upgrade level. */
  shieldRechargeTime() {
    const ladder = CONFIG.shield.rechargeTimes;
    return ladder[Math.min(Math.max(0, this.shieldLevel - 1), ladder.length - 1)];
  }

  /** Regenerate the gun's depleted shield bubble over time (cities have none). */
  updateShields(dt) {
    const rt = this.shieldRechargeTime();
    for (const s of this.turrets) {
      if (s.shieldFlash > 0) s.shieldFlash -= dt;
      if (!s.alive) continue;
      if (s.shields < s.shieldMax) {
        s.shieldTimer -= dt;
        if (s.shieldTimer <= 0) {
          s.shields++;
          s.shieldTimer = rt;
        }
      } else {
        s.shieldTimer = rt;
      }
    }
  }

  updatePlaying(dt) {
    const active = this.activeTurret;
    this.updateShields(dt);
    this.updateInterceptorLauncher(dt);
    this.updateLaser(dt);

    // The CIWS runs itself: you steer the stream with the cursor, and it
    // holds fire whenever the sky is clear of visible threats.
    const threatsUp = this.missiles.some((m) => !m.dead && !m.stealthed);
    if (threatsUp && active && active.usable) {
      const shots = this.ciws.fireFrom(active);
      if (shots.length) {
        this.bullets.push(...shots);
        sfx.fire(this.pan(active.x));
        // Powder smoke drifting off the muzzle while the gun runs.
        if (Math.random() < 0.25) {
          const mz = active.muzzle();
          smokePuff(this.particles, mz.x, mz.y, 1, '#9aa3ad');
        }
      }
    }

    // A detected nuclear launch arrives once its warning runs out.
    for (let i = this.pendingNukes.length - 1; i >= 0; i--) {
      this.pendingNukes[i] -= dt;
      if (this.pendingNukes[i] <= 0) {
        this.pendingNukes.splice(i, 1);
        this.launchNuke();
      }
    }

    // Spawn the wave over time.
    if (this.toSpawn > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnMissile();
        this.toSpawn--;
        this.spawnTimer = rand(this.spawnGap * 0.6, this.spawnGap * 1.4);
      }
    }

    // Advance missiles (skip children spawned this frame).
    const n = this.missiles.length;
    for (let i = 0; i < n; i++) {
      const m = this.missiles[i];
      const r = m.update(dt, this.groundY);
      if (r === 'split') this.splitMissile(m);
      else if (r === 'impact') this.impact(m);
      // Insurance: anything that strays far outside the field (a side-entry
      // flyer that lost its way) dies as a leak rather than stalling the wave.
      // A bomber finishing its pass just exits — that's not a leak.
      else if (m.age > 3 && (m.x < -400 || m.x > this.W + 400 || m.y < -500)) {
        m.dead = true;
        if (m.type !== 'bomber') this.waveLeaks++;
      }
    }

    // Bombers: release glide bombs over the field, and break into evasive
    // jinks while a homing interceptor is bearing down on them.
    const evadeR2 = CONFIG.missile.bomber.evadeRange * CONFIG.missile.bomber.evadeRange;
    for (const m of this.missiles) {
      if (m.type !== 'bomber' || m.dead) continue;
      m.evading = this.interceptorList.some(
        (it) => !it.dead && it.target === m && dist2(it.x, it.y, m.x, m.y) < evadeR2
      );
      if (m.bombsLeft <= 0) continue;
      m.bombTimer -= dt;
      if (m.bombTimer > 0) continue;
      if (m.x < 80 || m.x > this.W - 80) continue; // hold until over the field
      m.bombsLeft--;
      m.bombTimer = rand(CONFIG.missile.bomber.dropGap[0], CONFIG.missile.bomber.dropGap[1]);
      this.dropGlideBomb(m);
    }

    // Shields intercept missiles at the dome before they reach the ground.
    this.checkShieldCollisions();

    // Advance bullets, cull off-screen.
    for (const b of this.bullets) {
      b.update(dt, this.groundY);
      if (b.x < -20 || b.x > this.W + 20 || b.y < -20 || b.y > this.groundY + 5) {
        b.dead = true;
      }
    }

    // Advance interceptors (boost/coast homing) and handle their detonations.
    for (const it of this.interceptorList) {
      // If its target died en route, retask onto the nearest live threat —
      // or self-destruct rather than flying off uselessly.
      if (!it.dead && it.target && it.target.dead) {
        it.target = this.nearestInterceptTarget(it);
        if (!it.target) {
          it.dead = true;
          this.detonateInterceptor(it);
          continue;
        }
      }
      // Boost phase: pump out a billowing white solid-motor exhaust plume.
      if (it.boosting && Math.random() < dt * CONFIG.interceptor.smokeRate) {
        const sp = Math.hypot(it.vx, it.vy) || 1;
        smokePuff(
          this.particles,
          it.x - (it.vx / sp) * 10 + rand(-2, 2),
          it.y - (it.vy / sp) * 10 + rand(-2, 2),
          1,
          C.rocketSmoke
        );
      }
      const r = it.update(dt, this.groundY);
      if (r === 'detonate') this.detonateInterceptor(it);
      else if (r === 'fizzle') explode(this.particles, it.x, it.y, C.interceptorTrail, 6);
    }

    this.checkCollisions();

    removeWhere(this.missiles, (m) => m.dead);
    removeWhere(this.bullets, (b) => b.dead);
    removeWhere(this.interceptorList, (it) => it.dead);

    const aliveCities = this.cities.filter((c) => c.alive).length;
    const aliveTurrets = this.turrets.filter((t) => t.alive).length;
    if (aliveTurrets === 0) {
      this.gameOver('Gun destroyed');
      return;
    }
    if (aliveCities === 0) {
      this.gameOver('Cities lost');
      return;
    }

    // Hold a short beat after the last threat dies so the wave doesn't end
    // jarringly the instant the final missile pops.
    if (this.toSpawn === 0 && this.missiles.length === 0 && this.pendingNukes.length === 0) {
      this.waveEndTimer += dt;
      if (this.waveEndTimer >= CONFIG.wave.endDelay) this.endWave();
    } else {
      this.waveEndTimer = 0;
    }
  }

  /** Map a sim x position into the stereo field (-1..1) for positional SFX. */
  pan(x) {
    return clamp((x / this.W) * 2 - 1, -1, 1);
  }

  /**
   * Spawn a transient explosion visual (fireball flash + shockwave ring, drawn
   * by the renderer) plus a few lingering smoke puffs.
   */
  boom(x, y, size, color) {
    if (this.explosions.length < CONFIG.render.maxExplosions) {
      const cfg = CONFIG.explosion[size];
      this.explosions.push({ x, y, age: 0, dur: cfg.dur, maxR: cfg.radius, color, size });
    }
    smokePuff(this.particles, x, y, CONFIG.explosion.smokePer[size]);
  }

  /**
   * Per-type death effect: each threat dies with its own animation + sound.
   *   normal     — orange pop with mixed spark/ember debris.
   *   evasive    — purple whirling ring burst (its weave spinning apart).
   *   hypersonic — debris streaks on along its heading (momentum carries).
   *   mirv bus   — big green armoured blow-out with a heavy ember shower.
   */
  killEffect(m) {
    const pan = this.pan(m.x);
    if (m.splitsRemaining > 0) {
      explode(this.particles, m.x, m.y, C.missileMirv, 26);
      this.boom(m.x, m.y, 'medium', C.missileMirv);
      sfx.kill('mirv', pan);
    } else if (m.type === 'evasive') {
      explodeRing(this.particles, m.x, m.y, C.missileEvasive, 22);
      this.boom(m.x, m.y, 'small', C.missileEvasive);
      sfx.kill('evasive', pan);
    } else if (m.type === 'hypersonic') {
      explodeCone(this.particles, m.x, m.y, m.hx, m.hy, C.missileHypersonic, 20);
      this.boom(m.x, m.y, 'small', C.missileHypersonic);
      sfx.kill('hypersonic', pan);
    } else if (m.type === 'cruise' || m.type === 'stealth') {
      // The wreck keeps flying: debris streams on along its heading (a downed
      // stealth bird shatters pale, finally visible).
      const col = m.type === 'stealth' ? C.missileStealth : C.missileCruise;
      explodeCone(this.particles, m.x, m.y, m.hx, m.hy, col, 18);
      this.boom(m.x, m.y, 'medium', col);
      sfx.kill('cruise', pan);
    } else if (m.type === 'drone') {
      // Small machine sparking out — a fizzly pop, not a warhead blast.
      explodeRing(this.particles, m.x, m.y, C.missileDrone, 10);
      this.boom(m.x, m.y, 'small', C.missileDrone);
      sfx.kill('drone', pan);
    } else if (m.type === 'bomber') {
      // A big airframe coming apart: heavy burning debris carries forward.
      explodeCone(this.particles, m.x, m.y, m.hx, m.hy, C.missileBomber, 30);
      this.boom(m.x, m.y, 'large', C.missileBomber);
      sfx.kill('mirv', pan); // heavy double thump suits a dying airframe
    } else if (m.type === 'nuke') {
      // Killed before detonation: the carcass blows big, but no chain reaction.
      explode(this.particles, m.x, m.y, C.missileNuke, 32);
      this.boom(m.x, m.y, 'large', C.missileNuke);
      sfx.kill('nuke', pan);
    } else {
      explode(this.particles, m.x, m.y, C.explosion, 14);
      this.boom(m.x, m.y, 'small', C.explosion);
      sfx.kill('normal', pan);
    }
  }

  checkCollisions() {
    const hit = CONFIG.missile.radius + CONFIG.missile.hitPadding + CONFIG.bullet.radius;
    const hit2 = hit * hit;
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (const m of this.missiles) {
        if (m.dead) continue;
        if (dist2(b.x, b.y, m.x, m.y) <= hit2) {
          b.dead = true;
          m.hp -= CONFIG.bullet.damage;
          if (m.hp <= 0) {
            this.rewardKill(m);
            m.dead = true;
            this.killEffect(m);
          } else {
            // Armoured target took a hit but survives — spark + ting, no kill.
            m.hitFlash = CONFIG.missile.hitFlashTime;
            explode(this.particles, b.x, b.y, C.hitSpark, 5);
            sfx.hit(this.pan(b.x));
          }
          break;
        }
      }
    }
  }

  impact(missile) {
    this.waveLeaks++; // a threat reached the ground (breaks the all-clear bonus)

    // A nuke AIR-BURSTS above its target and levels the target city plus its
    // immediate neighbours — including the CIWS if it's next door. Two slots
    // away is outside the lethal radius.
    if (missile.type === 'nuke') {
      const r = CONFIG.missile.nuke.blastRadius;
      for (const s of [...this.cities, ...this.turrets]) {
        if (s.alive && Math.abs(s.x - missile.x) <= r + this.structureHalfWidth(s)) {
          s.alive = false;
          s.destroyedWave = this.wave;
          s.shieldMax = 0;
          s.shields = 0;
          s.shieldFlash = 0;
        }
      }
      explode(this.particles, missile.x, missile.y, C.groundExplosion, 70);
      this.boom(missile.x, missile.y, 'nuke', '#ffe6a8');
      this.mushrooms.push({ x: missile.x, y: missile.y, groundY: this.groundY, age: 0 });
      this.shakeTime = 1.0;
      this.shakeMag = 22;
      sfx.nukeBlast(this.pan(missile.x));
      return;
    }

    // Shielded structures are intercepted up at their dome (see
    // checkShieldCollisions), so anything reaching the ground hits unshielded.
    const r = CONFIG.missile.blastRadius;
    let destroyed = 0;
    for (const s of [...this.cities, ...this.turrets]) {
      // The blast harms a structure if it overlaps its footprint at all —
      // a hit on the outermost building counts, not just dead centre.
      if (s.alive && Math.abs(s.x - missile.x) <= r + this.structureHalfWidth(s)) {
        s.alive = false;
        s.destroyedWave = this.wave;
        // A destroyed structure loses its shield with it — you must repair AND
        // re-buy a shield to protect it again.
        s.shieldMax = 0;
        s.shields = 0;
        s.shieldFlash = 0;
        destroyed++;
      }
    }

    const big = destroyed > 0;
    explode(this.particles, missile.x, this.groundY, C.groundExplosion, big ? 38 : 22);
    this.boom(missile.x, this.groundY, big ? 'large' : 'medium', C.groundExplosion);
    this.shakeTime = big ? 0.35 : 0.22;
    this.shakeMag = big ? 9 : 6;
    if (big) sfx.targetHit(this.pan(missile.x));
    else sfx.groundImpact(this.pan(missile.x));
  }

  /** A missile entering the gun's shield dome detonates on contact. */
  checkShieldCollisions() {
    const rr = CONFIG.shield.radius * CONFIG.shield.radius;
    for (const m of this.missiles) {
      if (m.dead) continue;
      for (const s of this.turrets) {
        if (!s.alive || s.shields <= 0) continue;
        if (m.y <= this.groundY && dist2(m.x, m.y, s.x, this.groundY) <= rr) {
          this.shieldAbsorb(s, m);
          break;
        }
      }
    }
  }

  /** The dome eats a warhead, detonating it where it struck, then collapses. */
  shieldAbsorb(s, m) {
    s.shields--; // one shield, so this breaks it
    s.shieldFlash = CONFIG.shield.flashTime;
    m.dead = true;
    this.waveLeaks++; // it got past your guns to the shield
    explode(this.particles, m.x, m.y, C.explosion, 12); // warhead bursts on the dome
    explode(this.particles, m.x, m.y, C.shield, 26); // shield energy shatter
    this.boom(m.x, m.y, 'medium', C.shield);
    this.shakeTime = Math.max(this.shakeTime, 0.2);
    this.shakeMag = 6;
    sfx.shieldBreak(this.pan(m.x));
  }

  // -------------------------------------------------------------------------
  // Interceptors (secondary weapon)
  // -------------------------------------------------------------------------
  /**
   * The launcher fires itself: whenever it has finished reloading it picks
   * the highest-value threat, biased toward distant ones (the gun and laser
   * own the near sky). It never spends a missile on a drone, and it can't
   * see cloaked stealth missiles.
   */
  updateInterceptorLauncher(dt) {
    const iw = this.interceptorWeapon;
    iw.update(dt);
    if (!iw.canLaunch) return;
    const launcher = this.turrets.find((t) => t.alive);
    if (!launcher) return;
    const lx = launcher.x + CONFIG.interceptor.launcherOffsetX;
    const ly = this.groundY - CONFIG.interceptor.launcherHeight;
    let best = null;
    let bestScore = -Infinity;
    for (const m of this.missiles) {
      if (m.dead || m.stealthed || m.type === 'drone') continue;
      const d = Math.hypot(m.x - lx, m.y - ly);
      if (d < CONFIG.interceptor.minTargetDist) continue; // gun's business
      const score = this.missileBounty(m) * 2 + d / 400; // value first, then reach
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (!best) return;
    const it = iw.launch(lx, ly, best);
    if (it) {
      this.interceptorList.push(it);
      sfx.rocketBurn(CONFIG.interceptor.boostTime, this.pan(lx));
    }
  }

  /**
   * Nearest live (visible) missile to a given interceptor, for retasking.
   * Drones are never valid interceptor targets — not even mid-flight — though
   * one caught in a blast still dies.
   */
  nearestInterceptTarget(it) {
    let best = null;
    let bestD = Infinity;
    for (const m of this.missiles) {
      if (m.dead || m.stealthed || m.type === 'drone') continue;
      const d = dist2(m.x, m.y, it.x, it.y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** Area warhead burst: instakills every missile within the blast radius. */
  detonateInterceptor(it) {
    explode(this.particles, it.x, it.y, C.interceptorBlast, 28);
    this.boom(it.x, it.y, 'medium', C.interceptorBlast);
    this.shakeTime = Math.max(this.shakeTime, 0.18);
    this.shakeMag = 5;
    sfx.interceptorBoom(this.pan(it.x));
    const r = CONFIG.interceptor.blastRadius;
    const r2 = r * r;
    for (const m of this.missiles) {
      if (m.dead) continue;
      if (dist2(m.x, m.y, it.x, it.y) <= r2) {
        // The blast deals flat damage: anything ordinary dies outright, but a
        // heavily-built nuke shrugs it off and needs a second interceptor.
        m.hp -= CONFIG.interceptor.blastDamage;
        if (m.hp <= 0) {
          this.rewardKill(m);
          m.dead = true;
          this.killEffect(m);
        } else {
          m.hitFlash = CONFIG.missile.hitFlashTime;
          sfx.hit(this.pan(m.x));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Rendering: 3D world via renderer, 2D HUD/overlay here.
  // -------------------------------------------------------------------------
  render() {
    this.renderer.render(this);

    const ctx = this.hctx;
    ctx.clearRect(0, 0, this.screenW, this.screenH);

    const aiming = this.state === 'playing' && !this.paused;

    // A subtle shake nudges the whole HUD too, keeping it married to the scene.
    ctx.save();
    if (this.shakeTime > 0) {
      const k = this.shakeTime / 0.25;
      ctx.translate(
        rand(-this.shakeMag, this.shakeMag) * k,
        rand(-this.shakeMag, this.shakeMag) * k
      );
    }

    if (aiming) {
      this.drawAimLine(ctx);
    }
    this.drawFloatTexts(ctx);
    this.drawHUD(ctx);
    ctx.restore();

    this.drawOverlay(ctx);
    // The crosshair stands in for the OS cursor, so draw it last (on top of
    // menus / the shop / game-over) in every state.
    this.drawCrosshair(ctx);
  }

  drawAimLine(ctx) {
    const t = this.activeTurret;
    if (!t || !t.alive) return;
    const mx = t.x + Math.cos(t.angle) * CONFIG.turret.barrelLength;
    const my = t.y + Math.sin(t.angle) * CONFIG.turret.barrelLength;
    const s = this.renderer.worldToScreen(mx, my);

    ctx.save();
    ctx.strokeStyle =
      t.ammo > 0 ? 'rgba(255,179,71,0.22)' : 'rgba(255,90,77,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(this.pointerX, this.pointerY);
    ctx.stroke();
    ctx.restore();
  }

  drawCrosshair(ctx) {
    const t = this.activeTurret;
    // Red only when the gun mount is gone (nothing left to aim) during play;
    // on menus / the shop / game-over it's just a neutral reticle.
    const aiming = this.state === 'playing' && !this.paused;
    const empty = aiming && (!t || !t.alive);
    const col = empty ? C.crosshairEmpty : C.crosshair;
    const x = this.pointerX;
    const y = this.pointerY;
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    for (const [dx, dy] of [
      [-16, 0],
      [16, 0],
      [0, -16],
      [0, 16],
    ]) {
      ctx.moveTo(x + Math.sign(dx) * 6, y + Math.sign(dy) * 6);
      ctx.lineTo(x + dx, y + dy);
    }
    ctx.stroke();
    ctx.restore();
  }

  text(str, x, y, opts = {}) {
    const ctx = this.hctx;
    const {
      size = 16,
      color = C.hud,
      align = 'left',
      baseline = 'alphabetic',
      weight = 'normal',
      glow = false,
    } = opts;
    ctx.font = `${weight} ${size}px "Courier New", monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if (glow) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
    }
    ctx.fillText(str, x, y);
    ctx.shadowBlur = 0;
  }

  /** Floating "+credits" labels that rise and fade from each kill. */
  drawFloatTexts(ctx) {
    for (const ft of this.floatTexts) {
      const frac = ft.life / ft.maxLife; // 1 -> 0 over its life
      const p = this.renderer.worldToScreen(ft.x, ft.y);
      const y = p.y - (1 - frac) * CONFIG.ui.floatTextRise;
      const size = 18 + (1 - frac) * 8; // a little pop as it rises
      ctx.globalAlpha = Math.min(1, frac * 1.5);
      this.text(ft.text, p.x, y, {
        size,
        weight: 'bold',
        align: 'center',
        color: ft.color,
        glow: true,
      });
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Screen x-extents of the play field, for docking the HUD in the dead
   * columns beside it (the camera fills the screen vertically, so on wide
   * monitors the side columns are the only spare real estate).
   */
  hudColumns() {
    const tl = this.renderer.worldToScreen(0, 0);
    const bl = this.renderer.worldToScreen(0, this.groundY);
    const tr = this.renderer.worldToScreen(this.W, 0);
    const br = this.renderer.worldToScreen(this.W, this.groundY);
    const left = Math.min(tl.x, bl.x);
    const right = Math.max(tr.x, br.x);
    return { left, right, width: Math.min(left, this.screenW - right) };
  }

  drawHUD(ctx) {
    if (this.state === 'menu') return;
    const cols = this.hudColumns();
    if (cols.width >= 120) this.drawSideHUD(ctx, cols);
    else this.drawCornerHUD(ctx);
  }

  /** A small label-over-value block; returns the y below it. */
  hudStat(label, value, x, y, color = C.hud, big = 22) {
    this.text(label, x, y, { size: 11, align: 'center', color: C.hudDim });
    this.text(`${value}`, x, y + big, {
      size: big,
      align: 'center',
      weight: 'bold',
      color,
    });
    return y + big + 26;
  }

  /** A status line + progress bar centred at x; returns the y below it. */
  hudBar(ctx, label, frac, on, color, x, y, barW = 110) {
    this.text(label, x, y, { size: 12, align: 'center', color: on ? color : C.hudDim });
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x - barW / 2, y + 7, barW, 4);
    ctx.fillStyle = on ? color : C.hudDim;
    ctx.fillRect(x - barW / 2, y + 7, barW * frac, 4);
    return y + 34;
  }

  /** Wide windows: stats docked in the columns flanking the play field. */
  drawSideHUD(ctx, cols) {
    const lx = cols.left / 2;
    let y = this.screenH * 0.12;
    y = this.hudStat('SCORE', this.score, lx, y);
    y = this.hudStat('WAVE', this.wave, lx, y);
    const aliveCities = this.cities.filter((c) => c.alive).length;
    y = this.hudStat(
      'CITIES',
      `${aliveCities}/${this.cities.length}`,
      lx,
      y,
      aliveCities <= 2 ? C.crosshairEmpty : C.hud
    );
    if (sfx.muted) {
      this.text('MUTED (M)', lx, y, { size: 11, align: 'center', color: C.hudDim });
    }

    const rx = (cols.right + this.screenW) / 2;
    const barW = Math.min(116, (this.screenW - cols.right) * 0.8);
    y = this.screenH * 0.12;
    y = this.hudStat('CREDITS', this.credits, rx, y, C.credits);
    const iw = this.interceptorWeapon;
    if (iw.owned) {
      const ready = iw.canLaunch;
      y = this.hudBar(
        ctx,
        ready ? 'INTCP READY' : 'INTCP RELOADING',
        1 - iw.reloadFrac,
        ready,
        C.interceptor,
        rx,
        y,
        barW
      );
    }
    if (this.laser.owned) {
      const lReady = this.laser.canFire || this.laser.burning;
      const lLabel = this.laser.burning
        ? 'LASER FIRING'
        : this.laser.canFire
        ? 'LASER CHARGED'
        : 'LASER CHARGING';
      this.hudBar(ctx, lLabel, this.laser.chargeFrac, lReady, C.laser, rx, y, barW);
    }
  }

  /** Narrow windows: compact overlay tucked into the field's top corners. */
  drawCornerHUD(ctx) {
    this.text(`SCORE ${this.score}`, 14, 26, { size: 15, weight: 'bold' });
    this.text(`WAVE ${this.wave}`, 14, 46, { size: 13, color: C.hud });
    const aliveCities = this.cities.filter((c) => c.alive).length;
    this.text(`CITIES ${aliveCities}/${this.cities.length}`, 14, 64, {
      size: 13,
      color: aliveCities <= 2 ? C.crosshairEmpty : C.hud,
    });
    if (sfx.muted) this.text('MUTED (M)', 14, 82, { size: 11, color: C.hudDim });

    const rx = this.screenW - 14;
    this.text(`CR ${this.credits}`, rx, 26, { size: 15, weight: 'bold', align: 'right', color: C.credits });
    const iw = this.interceptorWeapon;
    if (iw.owned) {
      this.text(iw.canLaunch ? 'INTCP READY' : 'INTCP RELOADING', rx, 46, {
        size: 12,
        align: 'right',
        color: iw.canLaunch ? C.interceptor : C.hudDim,
      });
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(rx - 90, 52, 90, 4);
      ctx.fillStyle = iw.canLaunch ? C.interceptor : C.hudDim;
      ctx.fillRect(rx - 90, 52, 90 * (1 - iw.reloadFrac), 4);
    }
    if (this.laser.owned) {
      const lOn = this.laser.canFire || this.laser.burning;
      const lLabel = this.laser.burning
        ? 'LASER FIRING'
        : this.laser.canFire
        ? 'LASER CHARGED'
        : 'LASER CHARGING';
      this.text(lLabel, rx, 74, { size: 12, align: 'right', color: lOn ? C.laser : C.hudDim });
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(rx - 90, 80, 90, 4);
      ctx.fillStyle = lOn ? C.laser : C.hudDim;
      ctx.fillRect(rx - 90, 80, 90 * this.laser.chargeFrac, 4);
    }
  }

  dim(ctx, alpha = 0.6) {
    ctx.fillStyle = `rgba(3,5,10,${alpha})`;
    ctx.fillRect(0, 0, this.screenW, this.screenH);
  }

  drawOverlay(ctx) {
    const cx = this.screenW / 2;
    if (this.state === 'menu') {
      this.dim(ctx, 0.55);
      this.text('CIWS COMMAND', cx, this.screenH * 0.16, {
        size: 54,
        align: 'center',
        weight: 'bold',
        color: C.turretActive,
        glow: true,
      });
      this.text(
        'Defend your cities with close-in weapon systems.',
        cx,
        this.screenH * 0.16 + 40,
        { size: 18, align: 'center', color: C.hud }
      );

      this.text('HOW TO PLAY', cx, this.screenH * 0.3, {
        size: 16,
        align: 'center',
        weight: 'bold',
        color: C.hud,
      });
      // Label + description rows, centred as a block.
      const rows = [
        ['AIM', 'Move the mouse to lay the CIWS gun. It fires on its own', 'while threats are inbound, and holds fire when the sky is clear.'],
        ['AUTO DEFENSES', 'Interceptors (a cheap first armory buy) launch themselves at', 'distant, high-value threats; the laser burns down what gets close.'],
        ['ARMORY', 'Between waves, spend credits on faster reloads, fire rate,', 'twin barrels, the laser, a gun shield, and city repairs.'],
        ['SURVIVE', 'Protect six cities. One hit on the gun ends the run —', 'only the shield dome can absorb it.'],
        ['THREATS', 'MIRVs split, hypersonics sprint, cruise missiles and drones', 'flank, stealth decloaks late... and nukes level half the map.'],
      ];
      let ry = this.screenH * 0.3 + 34;
      for (const [label, ...lines] of rows) {
        this.text(label, cx - 230, ry, {
          size: 13,
          align: 'right',
          weight: 'bold',
          color: C.turretActive,
        });
        lines.forEach((l, i) =>
          this.text(l, cx - 210, ry + i * 18, { size: 13, color: C.hud })
        );
        ry += lines.length * 18 + 14;
      }

      this.text('P pause     R restart     M mute', cx, ry + 10, {
        size: 14,
        align: 'center',
        color: C.hudDim,
      });
      this.text('CLICK OR PRESS SPACE TO DEPLOY', cx, this.screenH * 0.88, {
        size: 20,
        align: 'center',
        weight: 'bold',
        color: C.crosshair,
        glow: true,
      });
    } else if (this.state === 'intermission') {
      this.drawShop(ctx);
    } else if (this.state === 'gameover') {
      this.dim(ctx, 0.65);
      this.text((this.lossReason || 'Defeat').toUpperCase(), cx, this.screenH * 0.18, {
        size: 54,
        align: 'center',
        weight: 'bold',
        color: C.missile,
        glow: true,
      });
      const isBest = this.lastRun && this.lastRun.rank === 0 && this.score > 0;
      this.text(
        isBest ? `NEW HIGH SCORE  ${this.score}` : `Final Score  ${this.score}`,
        cx,
        this.screenH * 0.18 + 48,
        { size: 24, align: 'center', color: isBest ? C.credits : C.hud, glow: isBest }
      );
      this.text(`You reached wave ${this.wave}`, cx, this.screenH * 0.18 + 78, {
        size: 16,
        align: 'center',
        color: C.hudDim,
      });

      // High-score table (kept in localStorage; the current run glows).
      const scores = this.lastRun ? this.lastRun.scores : [];
      if (scores.length) {
        const top = this.screenH * 0.36;
        this.text('HIGH SCORES', cx, top, {
          size: 16,
          align: 'center',
          weight: 'bold',
          color: C.hud,
        });
        scores.slice(0, 8).forEach((s, i) => {
          const mine = this.lastRun.rank === i;
          const y = top + 28 + i * 24;
          const col = mine ? C.credits : C.hudDim;
          this.text(`${i + 1}.`, cx - 170, y, { size: 14, align: 'right', color: col });
          this.text(`${s.score}`, cx - 60, y, {
            size: 14,
            align: 'right',
            weight: mine ? 'bold' : 'normal',
            color: col,
          });
          this.text(`wave ${s.wave}`, cx + 20, y, { size: 13, color: col });
          this.text(s.date || '', cx + 170, y, { size: 12, align: 'right', color: col });
        });
      }

      this.text('CLICK or press SPACE to try again', cx, this.screenH * 0.85, {
        size: 20,
        align: 'center',
        weight: 'bold',
        color: C.crosshair,
        glow: true,
      });
    }

    if (this.paused && this.state === 'playing') {
      this.dim(ctx, 0.5);
      this.text('PAUSED', cx, this.screenH * 0.45, {
        size: 44,
        align: 'center',
        weight: 'bold',
        color: C.hud,
        glow: true,
      });
      this.text('press P to resume', cx, this.screenH * 0.45 + 36, {
        size: 16,
        align: 'center',
        color: C.hudDim,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Shop (between-wave armory)
  // -------------------------------------------------------------------------
  /** Build the current shop offer list (availability/cost reflect game state). */
  getShopItems() {
    const S = CONFIG.shop;
    const cr = this.credits;
    const iw = this.interceptorWeapon;
    const items = [];

    if (!iw.owned) {
      items.push({
        label: 'Interceptor Battery',
        desc: 'Auto-launching homing missiles — the natural first buy',
        cost: S.interceptorCost,
        soldOut: false,
        enabled: cr >= S.interceptorCost,
        action: () => iw.buy(),
        info: [
          'Fields a THAAD-style launcher right of the',
          'gun. It fires itself at distant, high-value',
          'threats (never drones) and blasts everything',
          'near the kill. Cheap — buy it early.',
        ],
      });
    } else {
      const il = iw.cooldownLevel;
      const ilMax = il >= S.interceptorCooldownCosts.length;
      items.push({
        label: `Interceptor Reload${ilMax ? '' : ` (Lv ${il + 1})`}`,
        desc: `Faster reload between launches  (now ${iw.cooldown}s)`,
        cost: ilMax ? null : S.interceptorCooldownCosts[il],
        soldOut: false,
        enabled: !ilMax && cr >= S.interceptorCooldownCosts[il],
        action: () => iw.upgradeCooldown(),
        info: [
          'Interceptors launch themselves at distant,',
          'high-value threats (never drones) and blast',
          'everything near the kill. Each level shortens',
          `the reload between launches (${CONFIG.interceptor.cooldowns[0]}s down to ${CONFIG.interceptor.cooldowns[CONFIG.interceptor.cooldowns.length - 1]}s).`,
        ],
      });
    }

    const deadCity = this.cities.some((c) => !c.alive);
    items.push({
      label: 'Repair City',
      desc: deadCity ? 'Rebuild one destroyed city' : 'All cities intact',
      cost: S.repairCityCost,
      soldOut: !deadCity,
      enabled: deadCity && cr >= S.repairCityCost,
      action: () => {
        const c = this.cities.find((c) => !c.alive);
        if (c) c.alive = true;
      },
      info: [
        'Rebuilds one destroyed city. Dead cities pay',
        'no end-of-wave bonus, and losing all six ends',
        'the run — repairs are pricey but keep your',
        'income (and the game) alive.',
      ],
    });

    const sl = this.shieldLevel;
    const slMax = sl >= CONFIG.shield.costs.length;
    items.push({
      label: sl === 0 ? 'Gun Shield' : `Shield Recharge${slMax ? '' : ` (Lv ${sl})`}`,
      desc:
        sl === 0
          ? 'Dome over the CIWS — absorbs one warhead, then recharges'
          : `Faster shield recharge  (now ${this.shieldRechargeTime()}s)`,
      cost: slMax ? null : CONFIG.shield.costs[sl],
      soldOut: false,
      enabled: !slMax && cr >= CONFIG.shield.costs[sl],
      action: () => this.buyGunShield(),
      info:
        sl === 0
          ? [
              'Fits an energy dome over the CIWS that',
              'absorbs one warhead, then recharges. A hit',
              'on the unshielded gun instantly ends the',
              'run — this is your only insurance.',
            ]
          : [
              'Shortens how long the dome takes to come',
              `back after absorbing a hit (down to ${CONFIG.shield.rechargeTimes[CONFIG.shield.rechargeTimes.length - 1]}s).`,
              'It also returns fully charged each wave.',
            ],
    });

    const L = CONFIG.laser;
    if (!this.laser.owned) {
      items.push({
        label: 'Laser Turret',
        desc: 'Autonomous beam — zaps drones & plain RVs',
        cost: L.cost,
        soldOut: false,
        enabled: cr >= L.cost,
        action: () => this.laser.buy(),
        info: [
          'An autonomous beam emplacement left of the',
          'gun. It slews onto the lowest drone or RV in',
          'range and burns it down — weaker at long',
          'range, and it cannot depress below ~15°.',
        ],
      });
    } else {
      const ll = this.laser.level;
      const llMax = ll >= L.upgradeCosts.length;
      items.push({
        label: `Laser Recharge${llMax ? '' : ` (Lv ${ll + 1})`}`,
        desc: `Faster recharge between shots  (now ${this.laser.rechargeTime}s)`,
        cost: llMax ? null : L.upgradeCosts[ll],
        soldOut: false,
        enabled: !llMax && cr >= L.upgradeCosts[ll],
        action: () => this.laser.upgradeRecharge(),
        info: [
          'Shortens the recharge between laser burns',
          `(${L.cooldowns[0]}s down to ${L.cooldowns[L.cooldowns.length - 1]}s), so it clears swarms much faster.`,
        ],
      });
    }

    const fl = this.ciws.fireRateLevel;
    const frMax = fl >= S.fireRateCosts.length;
    items.push({
      label: `Upgrade Fire Rate${frMax ? '' : ` (Lv ${fl + 1})`}`,
      desc: 'Faster CIWS cycle rate',
      cost: frMax ? null : S.fireRateCosts[fl],
      soldOut: false,
      enabled: !frMax && cr >= S.fireRateCosts[fl],
      action: () => this.ciws.upgradeFireRate(),
      info: [
        'Spins the gun faster for a denser tracer',
        'stream — more rounds on target per sweep,',
        'compounding with Twin Barrels.',
      ],
    });

    const hasTwin = this.ciws.twin;
    items.push({
      label: 'Twin Barrels',
      desc: hasTwin ? 'Dual side-by-side cannons' : 'Add a 2nd barrel — double the rounds',
      cost: hasTwin ? null : S.twinBarrelCost,
      soldOut: hasTwin,
      enabled: !hasTwin && cr >= S.twinBarrelCost,
      action: () => this.ciws.upgradeTwin(),
      info: [
        'One-time: mounts a second gatling cluster.',
        'Every trigger pulse sends two rounds flying',
        'side by side — double the stream density.',
      ],
    });

    return items;
  }

  /** Deterministic layout for the shop rows + the proceed button. */
  shopLayout() {
    const items = this.getShopItems();
    const panelW = 480;
    const x = this.screenW / 2 - panelW / 2;
    const top = this.screenH * 0.3;
    const rowH = 46;
    const gap = 8;
    const rows = items.map((item, i) => ({
      item,
      x,
      y: top + i * (rowH + gap),
      w: panelW,
      h: rowH,
    }));
    const lastY = top + items.length * (rowH + gap);
    const nextRect = { x: this.screenW / 2 - 120, y: lastY + 18, w: 240, h: 46 };
    return { rows, nextRect };
  }

  buyItem(item) {
    if (!item || !item.enabled || item.cost == null) {
      sfx.denied();
      return;
    }
    this.credits -= item.cost;
    item.action();
    sfx.buy();
  }

  /** First purchase fits the gun's dome; later ones speed its recharge. */
  buyGunShield() {
    this.shieldLevel++;
    for (const t of this.turrets) {
      if (t.alive && t.shieldMax === 0) {
        t.shieldMax = CONFIG.shield.maxPerStructure;
        t.shields = t.shieldMax; // live immediately
        t.shieldTimer = this.shieldRechargeTime();
      }
    }
  }

  handleShopClick(px, py) {
    const { rows, nextRect } = this.shopLayout();
    if (this._inRect(px, py, nextRect)) {
      this.proceedToNextWave();
      return;
    }
    for (const r of rows) {
      if (this._inRect(px, py, r)) {
        this.buyItem(r.item);
        return;
      }
    }
  }

  /** Any click on the menu / game-over screen deploys. */
  handleMenuClick() {
    this.startGame();
  }

  _inRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  drawShop(ctx) {
    const cx = this.screenW / 2;
    this.dim(ctx, 0.6);
    this.text(`WAVE ${this.wave} CLEARED`, cx, this.screenH * 0.15, {
      size: 38,
      align: 'center',
      weight: 'bold',
      color: C.city,
      glow: true,
    });
    this.text(
      `CREDITS  ${this.credits}    (+${this.waveEarned} this wave)`,
      cx,
      this.screenH * 0.15 + 34,
      { size: 18, align: 'center', color: C.credits }
    );
    const b = this.waveBreakdown;
    if (b) {
      const parts = [
        `Kills +${b.kills}`,
        b.clear > 0 ? `All-clear +${b.clear}` : 'All-clear —',
        `Cities +${b.city}`,
      ];
      this.text(parts.join('     '), cx, this.screenH * 0.15 + 58, {
        size: 13,
        align: 'center',
        color: C.hudDim,
      });
    }
    this.text('ARMORY — click an item or press its number', cx, this.screenH * 0.3 - 16, {
      size: 13,
      align: 'center',
      color: C.hudDim,
    });

    const { rows, nextRect } = this.shopLayout();
    rows.forEach((r, i) => {
      const it = r.item;
      const hover = it.enabled && this._inRect(this.pointerX, this.pointerY, r);
      ctx.fillStyle = it.enabled
        ? hover
          ? C.shopRowHover
          : C.shopRow
        : 'rgba(40,58,86,0.22)';
      this._roundRect(ctx, r.x, r.y, r.w, r.h, 6);
      ctx.fill();

      const labelCol = it.enabled ? C.hud : C.hudDim;
      this.text(`${i + 1}`, r.x + 18, r.y + r.h / 2 + 5, {
        size: 15,
        align: 'center',
        color: it.enabled ? C.crosshair : C.hudDim,
      });
      this.text(it.label, r.x + 40, r.y + 20, { size: 16, color: labelCol, weight: 'bold' });
      this.text(it.desc, r.x + 40, r.y + 38, { size: 12, color: C.hudDim });

      let right;
      if (it.cost == null) right = 'MAX';
      else if (it.soldOut) right = '—';
      else right = `${it.cost} cr`;
      this.text(right, r.x + r.w - 16, r.y + r.h / 2 + 5, {
        size: 16,
        align: 'right',
        color: it.enabled ? C.credits : C.hudDim,
      });
    });

    // Hover tooltip: a side panel with the full explanation of the item
    // under the cursor (hovering works whether or not you can afford it).
    const hovered = rows.find((r) => this._inRect(this.pointerX, this.pointerY, r));
    if (hovered && hovered.item.info) {
      const lines = hovered.item.info;
      const tw = 318;
      const th = lines.length * 17 + 22;
      // Prefer the right side of the panel, then the left; on narrow windows
      // fall back to a strip tucked under the hovered row.
      let tx = hovered.x + hovered.w + 14;
      let ty = hovered.y;
      if (tx + tw > this.screenW - 8) tx = hovered.x - tw - 14;
      if (tx < 8) {
        tx = Math.min(Math.max(8, this.pointerX - tw / 2), this.screenW - tw - 8);
        ty = hovered.y + hovered.h + 6;
      }
      ty = Math.min(ty, this.screenH - th - 8);
      ctx.fillStyle = C.shopPanel;
      this._roundRect(ctx, tx, ty, tw, th, 6);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(120,150,190,0.5)';
      this._roundRect(ctx, tx, ty, tw, th, 6);
      ctx.stroke();
      lines.forEach((l, i) =>
        this.text(l, tx + 12, ty + 22 + i * 17, { size: 12.5, color: C.hud })
      );
    }

    const nr = nextRect;
    const hoverN = this._inRect(this.pointerX, this.pointerY, nr);
    ctx.fillStyle = hoverN ? 'rgba(255,179,71,0.9)' : 'rgba(255,179,71,0.55)';
    this._roundRect(ctx, nr.x, nr.y, nr.w, nr.h, 6);
    ctx.fill();
    this.text('NEXT WAVE ▸', cx, nr.y + nr.h / 2 + 6, {
      size: 18,
      align: 'center',
      weight: 'bold',
      color: '#161008',
    });
    this.text('or press SPACE', cx, nr.y + nr.h + 18, {
      size: 12,
      align: 'center',
      color: C.hudDim,
    });
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  bindInput() {
    const setPointer = (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      const w = this.renderer.screenToWorld(e.clientX, e.clientY);
      this.mouseX = w.x;
      this.mouseY = w.y;
    };

    window.addEventListener('pointermove', setPointer);

    window.addEventListener('pointerdown', (e) => {
      sfx.unlock();
      setPointer(e);
      if (e.button !== 0) return;
      // In play both weapons run themselves — clicks only drive the menus.
      if (this.state === 'menu' || this.state === 'gameover') {
        this.handleMenuClick();
      } else if (this.state === 'intermission') {
        this.handleShopClick(this.pointerX, this.pointerY);
      }
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      sfx.unlock();
      if (key === ' ' || key === 'spacebar') e.preventDefault(); // no page scroll
      this.handleKey(key);
    });

    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Route a (lowercased) key press. Space is context-sensitive: deploy on the
   * menu/game-over, advance in the shop.
   */
  handleKey(key) {
    if (key === ' ' || key === 'spacebar') {
      if (this.state === 'menu' || this.state === 'gameover') this.startGame();
      else if (this.state === 'intermission') this.proceedToNextWave();
      return;
    }
    if (this.state === 'intermission' && key >= '1' && key <= '9') {
      const item = this.getShopItems()[parseInt(key, 10) - 1];
      if (item) this.buyItem(item);
      return;
    }
    if (key === 'p') {
      if (this.state === 'playing') {
        this.paused = !this.paused;
      }
    } else if (key === 'r') {
      this.startGame();
    } else if (key === 'm') {
      sfx.toggleMute();
    }
  }
}
