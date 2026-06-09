// ---------------------------------------------------------------------------
// Game entities. Each owns its own state plus an update(dt) method. Rendering
// is handled entirely by the WebGL renderer (renderer3d.js), which reads these
// fields directly — entities carry no draw code of their own.
//
// Coordinates are in simulation space: x in [0, W], y from 0 (top) down to the
// ground. The renderer maps that to 3D world space.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { rand, randInt, dist } from './utils.js';
import { airDensity, applyDrag } from './physics.js';

// ---------------------------------------------------------------------------
// City — a cluster of buildings to defend. Static; just alive/dead state plus
// a stable skyline the renderer turns into extruded boxes.
// ---------------------------------------------------------------------------
export class City {
  constructor(x, groundY) {
    this.x = x;
    this.groundY = groundY;
    this.alive = true;
    this.shields = 0; // active bubbles (absorptions available)
    this.shieldMax = 0; // purchased capacity
    this.shieldTimer = CONFIG.shield.rechargeTimes[0]; // regen countdown
    this.shieldFlash = 0; // collapse-effect timer when the shield fails
    this.width = 116;
    this.buildings = [];
    // Two staggered rows of towers: a taller foreground row and a shorter,
    // pushed-back row peeking between them — a proper little skyline. Each
    // entry carries a depth offset (z) and flags the renderer uses for
    // detailing (spire on the tallest, rooftop plant on the chunky ones).
    let tallest = null;
    for (const [row, z, n, hLo, hHi] of [
      [0, 6, 6, 14, 30],
      [1, -7, 7, 22, 48],
    ]) {
      const slot = this.width / n;
      for (let i = 0; i < n; i++) {
        const b = {
          x: -this.width / 2 + i * slot + slot / 2 + rand(-2, 2),
          w: slot - rand(3, 6),
          h: rand(hLo, hHi),
          z,
          spire: false,
          roof: row === 0 && Math.random() < 0.5,
        };
        this.buildings.push(b);
        if (!tallest || b.h > tallest.h) tallest = b;
      }
    }
    tallest.spire = true;
    tallest.roof = false;
  }
}

// ---------------------------------------------------------------------------
// Turret — a CIWS mount. Aims at a target point and fires a rapid bullet
// stream. Holds its own ammo belt and fire-rate cooldown.
// ---------------------------------------------------------------------------
export class Turret {
  constructor(x, groundY) {
    this.x = x;
    this.groundY = groundY;
    this.y = groundY - CONFIG.turret.pivotHeight; // gun trunnion atop the mount
    this.alive = true;
    this.shields = 0; // active bubbles (absorptions available)
    this.shieldMax = 0; // purchased capacity
    this.shieldTimer = CONFIG.shield.rechargeTimes[0]; // regen countdown
    this.shieldFlash = 0; // collapse-effect timer when the shield fails
    this.ammo = CONFIG.turret.startAmmo;
    this.angle = -Math.PI / 2; // pointing straight up
    this.cooldown = 0;
    this.recoil = 0; // visual barrel kickback, decays to 0
    this.muzzleFlash = 0; // brief flash intensity, decays to 0
  }

  get usable() {
    return this.alive && this.ammo > 0;
  }

  aimAt(tx, ty) {
    this.angle = Math.atan2(ty - this.y, tx - this.x);
  }

  update(dt) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.recoil > 0) this.recoil = Math.max(0, this.recoil - dt * 60);
    if (this.muzzleFlash > 0) this.muzzleFlash = Math.max(0, this.muzzleFlash - dt * 8);
  }

  /** Muzzle position for the current aim (used by the CIWS weapon). */
  muzzle() {
    return {
      x: this.x + Math.cos(this.angle) * CONFIG.turret.barrelLength,
      y: this.y + Math.sin(this.angle) * CONFIG.turret.barrelLength,
    };
  }
}

// ---------------------------------------------------------------------------
// Bullet — a CIWS tracer round. Straight line, self-destructs after a lifetime
// or when it leaves the world / hits a missile.
// ---------------------------------------------------------------------------
export class Bullet {
  constructor(x, y, angle) {
    const s = CONFIG.bullet.speed;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * s;
    this.vy = Math.sin(angle) * s;
    this.life = CONFIG.bullet.lifetime;
    this.dead = false;
  }

  update(dt, groundY) {
    // Drag (denser air lower down) then gravity, so rounds slow and arc. CIWS
    // rounds feel amplified gravity for a more pronounced drop.
    applyDrag(this, CONFIG.physics.bulletDrag, airDensity(this.y, groundY), dt);
    this.vy += CONFIG.physics.gravity * CONFIG.physics.bulletGravityMul * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
}

// ---------------------------------------------------------------------------
// EnemyMissile — descends from the top toward a target structure. Variants:
//   'normal'  — straight line.
//   'evasive' — weaves side-to-side around its core path (harder to hit).
// May also MIRV-split into children at altitude. Keeps a trail polyline.
// ---------------------------------------------------------------------------
export class EnemyMissile {
  constructor(
    startX,
    startY,
    targetX,
    targetY,
    speed,
    splitsRemaining = 0,
    playHeight = 0,
    type = 'normal'
  ) {
    this.id = EnemyMissile._nextId++; // stable id (used to distribute auto-gun fire)
    this.type = type;
    this.startX = startX;
    this.startY = startY;
    // Core position advances along the straight aim line; the rendered/colliding
    // position adds the weave offset on top.
    this.cx = startX;
    this.cy = startY;
    this.x = startX;
    this.y = startY;
    this.targetX = targetX;
    this.targetY = targetY;
    this.speed = speed;
    this.radius = CONFIG.missile.radius;
    this.dead = false;
    this.reachedGround = false;
    this.age = 0;

    const dx = targetX - startX;
    const dy = targetY - startY;
    const len = Math.hypot(dx, dy) || 1;
    this.vx = (dx / len) * speed;
    this.vy = (dy / len) * speed;
    // Unit perpendicular to the direction of travel (for the weave).
    this.perpX = -this.vy / speed;
    this.perpY = this.vx / speed;
    // Instantaneous heading (core velocity + weave). Renderer points the
    // reentry cone along this so it banks as it jinks.
    this.hx = this.vx;
    this.hy = this.vy;

    const ev = CONFIG.missile.evasive;
    this.weaveAmp = type === 'evasive' ? ev.weaveAmp : 0;
    // Build several sine terms with random freq/phase and random weights that
    // sum to 1, so the lateral offset stays within +/-weaveAmp but follows an
    // irregular, hard-to-read path.
    this.weaveComps = [];
    if (this.weaveAmp > 0) {
      let wsum = 0;
      for (let i = 0; i < ev.weaveComponents; i++) {
        const w = rand(0.4, 1);
        wsum += w;
        this.weaveComps.push({
          w,
          f: rand(ev.weaveFreqMin, ev.weaveFreqMax),
          p: rand(0, Math.PI * 2),
        });
      }
      for (const c of this.weaveComps) c.w /= wsum; // normalize weights
    }

    this.trail = [{ x: startX, y: startY }];

    // MIRV: `childCount` survives for the spawner; `splitsRemaining` is the
    // one-shot trigger flag that update() clears once the split fires.
    this.childCount = splitsRemaining;
    this.splitsRemaining = splitsRemaining;
    if (splitsRemaining > 0 && playHeight > 0) {
      const [lo, hi] = CONFIG.missile.splitAltitude;
      this.splitY = playHeight * rand(lo, hi);
    } else {
      this.splitY = Infinity;
    }

    // Hit points by variant (MIRV carriers and nukes are armoured).
    const hp = CONFIG.missile.hp;
    this.maxHp = splitsRemaining > 0 ? hp.mirv : hp[type] || hp.normal;
    this.hp = this.maxHp;
    this.hitFlash = 0; // brief white flash on a non-killing hit

    // Hypersonics barely feel drag, so they stay fast all the way down.
    this.dragMul = type === 'hypersonic' ? CONFIG.missile.hypersonic.dragFactor : 1;

    // Side-entry types (cruise / drone) fly a waypoint route instead of a
    // straight dive: in level at their spawn altitude, then (cruise only) a
    // pop-up climb, then a terminal dive onto the target. They steer between
    // legs with a capped turn rate, like a real terrain-hugging weapon.
    this.waypoints = null;
    // A stealth cruise missile is cloaked for its whole low-level run-in: no
    // render, no lock-on, no laser — only a blind CIWS sweep can touch it.
    // The cloak drops the moment the pop-up starts.
    this.stealthed = type === 'stealth';
    if (type === 'cruise' || type === 'drone' || type === 'stealth') {
      // Stealth flies the standard cruise profile.
      const cfg = CONFIG.missile[type === 'stealth' ? 'cruise' : type];
      const dir = targetX > startX ? 1 : -1;
      this.turnRate = cfg.turnRate;
      this.dragMul = 0; // powered flight: holds its speed all the way in
      this.waypoints = [];
      if (type !== 'drone') {
        this.waypoints.push({ x: targetX - dir * cfg.popupDist, y: startY });
        this.waypoints.push({
          x: targetX - dir * cfg.popupDist * 0.4,
          y: startY - cfg.popupHeight,
        });
      } else {
        this.waypoints.push({ x: targetX - dir * cfg.diveDist, y: startY });
      }
      this.waypoints.push({ x: targetX, y: targetY });
      this.wpIndex = 0;
      this.vx = dir * speed; // enters flying level
      this.vy = 0;
    }
  }

  /** Returns 'split', 'impact', or null. */
  update(dt, groundY) {
    this.age += dt;
    if (this.hitFlash > 0) this.hitFlash -= dt;
    // Drag scaled by air density: applied equally to vx/vy so direction toward
    // the target is preserved — the missile just slows as it sinks into denser
    // air near the ground.
    applyDrag(this, CONFIG.physics.missileDrag * this.dragMul, airDensity(this.cy, groundY), dt);

    // Waypoint flyers (cruise / drone): steer the heading toward the current
    // waypoint at a capped turn rate; speed stays constant.
    if (this.waypoints) {
      const wp = this.waypoints[this.wpIndex];
      const curAng = Math.atan2(this.vy, this.vx);
      const desAng = Math.atan2(wp.y - this.cy, wp.x - this.cx);
      let diff = desAng - curAng;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxTurn = this.turnRate * dt;
      if (diff > maxTurn) diff = maxTurn;
      else if (diff < -maxTurn) diff = -maxTurn;
      const ang = curAng + diff;
      this.vx = Math.cos(ang) * this.speed;
      this.vy = Math.sin(ang) * this.speed;
      // Advance to the next leg when this waypoint is reached OR overshot.
      // "Reached" must be at least the turning radius — with a tighter
      // threshold a flyer that misses by a little can circle a mid-air
      // waypoint forever (which stalls the wave). "Overshot" = the waypoint
      // is behind the direction of travel. The last waypoint is the target
      // itself — ride it into the ground.
      if (this.wpIndex < this.waypoints.length - 1) {
        const toX = wp.x - this.cx;
        const toY = wp.y - this.cy;
        const turnRadius = this.speed / this.turnRate;
        const close = Math.hypot(toX, toY) < Math.max(34, turnRadius * 1.1);
        const passed = toX * this.vx + toY * this.vy < 0;
        if (close || passed) {
          this.wpIndex++;
          // Decloak at the pop-up: from here it's visible and targetable.
          if (this.type === 'stealth') this.stealthed = false;
        }
      }
    }

    this.cx += this.vx * dt;
    this.cy += this.vy * dt;

    if (this.weaveAmp > 0) {
      // Lateral offset and its time-derivative (the lateral velocity).
      let off = 0;
      let dOff = 0;
      for (const c of this.weaveComps) {
        off += c.w * Math.sin(this.age * c.f + c.p);
        dOff += c.w * c.f * Math.cos(this.age * c.f + c.p);
      }
      const w = off * this.weaveAmp;
      const dw = dOff * this.weaveAmp;
      this.x = this.cx + this.perpX * w;
      this.y = this.cy + this.perpY * w;
      this.hx = this.vx + this.perpX * dw;
      this.hy = this.vy + this.perpY * dw;
    } else {
      this.x = this.cx;
      this.y = this.cy;
      this.hx = this.vx;
      this.hy = this.vy;
    }

    // Record the trail, throttled by distance travelled.
    const last = this.trail[this.trail.length - 1];
    if (dist(last.x, last.y, this.x, this.y) >= CONFIG.missile.trailMinStep) {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > CONFIG.missile.trailMaxPoints) this.trail.shift();
    }

    if (this.splitsRemaining > 0 && this.cy >= this.splitY) {
      this.splitsRemaining = 0;
      this.splitY = Infinity;
      // Post-split it's a regular red RV: shed the carrier's armour.
      this.maxHp = CONFIG.missile.hp.normal;
      this.hp = Math.min(this.hp, this.maxHp);
      return 'split';
    }
    if (this.cy >= groundY) {
      this.y = groundY;
      this.reachedGround = true;
      this.dead = true;
      return 'impact';
    }
    return null;
  }
}
EnemyMissile._nextId = 1;

// ---------------------------------------------------------------------------
// Interceptor — the player's secondary weapon: a homing anti-missile launched
// at a locked target. Steers toward the target each frame (capped turn rate)
// and detonates with an area blast on arrival.
// ---------------------------------------------------------------------------
export class Interceptor {
  constructor(x, y, target) {
    const cfg = CONFIG.interceptor;
    this.x = x;
    this.y = y;
    this.target = target;
    this.age = 0;
    this.boosting = true;
    // Cold-launched straight up out of the pod — it has to turn onto an
    // intercept course in flight (low, far targets cost real turning time).
    this.vx = 0;
    this.vy = -cfg.launchSpeed;
    this.life = cfg.lifetime;
    this.dead = false;
    this.trail = [{ x, y }];
  }

  /** Returns 'detonate' (warhead burst), 'fizzle' (dud), or null. */
  update(dt, groundY) {
    const cfg = CONFIG.interceptor;
    this.age += dt;
    if (this.target && this.target.dead) this.target = null;

    // Steer the velocity heading toward the target, capped by the turn rate.
    let dirX = this.vx;
    let dirY = this.vy;
    if (this.target) {
      dirX = this.target.x - this.x;
      dirY = this.target.y - this.y;
    }
    const curAng = Math.atan2(this.vy, this.vx);
    const desAng = Math.atan2(dirY, dirX);
    let diff = desAng - curAng;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = cfg.turnRate * dt;
    if (diff > maxTurn) diff = maxTurn;
    else if (diff < -maxTurn) diff = -maxTurn;
    const ang = curAng + diff;
    let speed = Math.hypot(this.vx, this.vy);
    this.vx = Math.cos(ang) * speed;
    this.vy = Math.sin(ang) * speed;

    // Boost phase: thrust along the heading. Coast phase: gravity + drag.
    this.boosting = this.age < cfg.boostTime;
    if (this.boosting) {
      speed = Math.min(cfg.maxSpeed, speed + cfg.thrust * dt);
      this.vx = Math.cos(ang) * speed;
      this.vy = Math.sin(ang) * speed;
    } else {
      this.vy += CONFIG.physics.gravity * dt;
      applyDrag(this, CONFIG.physics.interceptorDrag, airDensity(this.y, groundY), dt);
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    const last = this.trail[this.trail.length - 1];
    if (dist(last.x, last.y, this.x, this.y) >= cfg.trailMinStep) {
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > cfg.trailMaxPoints) this.trail.shift();
    }

    this.life -= dt;

    if (this.target && dist(this.x, this.y, this.target.x, this.target.y) <= cfg.detonateRadius) {
      this.dead = true;
      return 'detonate';
    }
    // Ground contact ends the flight — no skimming through the dirt for
    // another pass. With a live target the warhead fuzes on impact; without
    // one the dud just buries itself.
    if (this.y >= groundY) {
      this.y = groundY;
      this.dead = true;
      return this.target ? 'detonate' : 'fizzle';
    }
    if (this.life <= 0 || this.y < -40) {
      this.dead = true;
      return this.target ? 'detonate' : 'fizzle';
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Particle — a single spark in an explosion. Cheap; spawned in bursts and
// rendered as additive points.
// ---------------------------------------------------------------------------
export class Particle {
  constructor(x, y, color, kind = 'spark') {
    const a = rand(0, Math.PI * 2);
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.color = color;
    this.dead = false;
    if (kind === 'smoke') {
      // Slow drifting puff that rises (sim +y is down), grows and thins out.
      const sp = rand(8, 40);
      this.vx = Math.cos(a) * sp;
      this.vy = Math.sin(a) * sp * 0.5 - rand(18, 46);
      this.life = rand(1.2, 2.4);
      this.size = rand(14, 30);
      this.grav = -12; // gentle buoyancy
      this.dragK = 0.985;
    } else if (kind === 'ember') {
      // Hot debris chunk: thrown hard, falls under gravity, burns out slow.
      const sp = rand(90, 380);
      this.vx = Math.cos(a) * sp;
      this.vy = Math.sin(a) * sp - rand(20, 120);
      this.life = rand(0.5, 1.1);
      this.size = rand(5, 10);
      this.grav = CONFIG.physics.gravity * 0.55;
      this.dragK = 0.985;
    } else {
      // Spark: fast, bright, short-lived.
      const sp = rand(40, 280);
      this.vx = Math.cos(a) * sp;
      this.vy = Math.sin(a) * sp;
      this.life = rand(0.3, 0.7);
      this.size = rand(4, 9);
      this.grav = CONFIG.physics.gravity * 0.25;
      this.dragK = 0.92;
    }
    this.maxLife = this.life;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= this.dragK;
    this.vy = this.vy * this.dragK + this.grav * dt;
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
}

/** Spawn a burst of particles into `out` (a mix of sparks and hot embers). */
export function explode(out, x, y, color, count = 16) {
  for (let i = 0; i < count; i++) {
    out.push(new Particle(x, y, color, i % 3 === 0 ? 'ember' : 'spark'));
  }
}

/** Spawn lingering smoke puffs into `out` (rendered as soft non-glowing cloud). */
export function smokePuff(out, x, y, count = 6, color = CONFIG.colors.smoke) {
  for (let i = 0; i < count; i++) out.push(new Particle(x, y, color, 'smoke'));
}

/**
 * Expanding ring burst: sparks thrown outward at a uniform speed with a
 * tangential swirl, so the debris whirls apart (evasive-kill signature).
 */
export function explodeRing(out, x, y, color, count = 16) {
  for (let i = 0; i < count; i++) {
    const p = new Particle(x, y, color, 'spark');
    const a = (i / count) * Math.PI * 2;
    const sp = rand(150, 210);
    const swirl = sp * 0.6;
    p.vx = Math.cos(a) * sp - Math.sin(a) * swirl;
    p.vy = Math.sin(a) * sp + Math.cos(a) * swirl;
    p.life = p.maxLife = rand(0.45, 0.7);
    out.push(p);
  }
}

/**
 * Directional debris cone along (dirX, dirY): the wreck keeps most of its
 * momentum and streaks on past the kill point (hypersonic-kill signature).
 */
export function explodeCone(out, x, y, dirX, dirY, color, count = 16) {
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len;
  const uy = dirY / len;
  for (let i = 0; i < count; i++) {
    const p = new Particle(x, y, color, i % 2 === 0 ? 'ember' : 'spark');
    const sp = rand(180, 460);
    const spread = rand(-0.45, 0.45); // radians off the travel axis
    const cs = Math.cos(spread);
    const sn = Math.sin(spread);
    p.vx = (ux * cs - uy * sn) * sp;
    p.vy = (ux * sn + uy * cs) * sp;
    out.push(p);
  }
}

export { randInt };
