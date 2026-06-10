// ---------------------------------------------------------------------------
// Weapon systems. Each weapon owns its own stats, inventory and upgrade state
// plus the logic to produce projectiles. The Game owns the projectile lists and
// their world simulation/collision; weapons just answer "what do I have and how
// do I fire". Adding a new weapon = one new class here + a projectile type.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { deg2rad, rand } from './utils.js';
import { Bullet, Interceptor } from './entities.js';

/**
 * CIWS — the primary rapid-fire guns. Stats (fire interval, dispersion, ammo
 * capacity) live here and are mutated by shop upgrades. The turret is just a
 * mount: this drives the firing and writes back its cooldown/ammo.
 */
export class CIWSWeapon {
  constructor() {
    this.name = 'CIWS';
    this.baseInterval = CONFIG.turret.fireInterval;
    this.baseDispersion = CONFIG.turret.dispersionDeg;
    this.ammoCapacity = CONFIG.turret.startAmmo; // Infinity — the belt never runs dry
    this.fireRateLevel = 0;
    this.twin = false; // twin-barrel upgrade: fires two rounds side by side
  }

  get barrels() {
    return this.twin ? 2 : 1;
  }

  get fireInterval() {
    return this.baseInterval * Math.pow(CONFIG.shop.fireRateFactor, this.fireRateLevel);
  }

  get dispersionDeg() {
    return this.baseDispersion;
  }

  /** Refill every operational gun to the current capacity. */
  reloadAll(turrets) {
    for (const t of turrets) if (t.alive) t.ammo = this.ammoCapacity;
  }

  /**
   * Fire a volley from a turret. Returns an array of Bullets (one per barrel, so
   * two side-by-side rounds with the twin upgrade), or [] if it can't fire.
   */
  fireFrom(turret) {
    if (!turret.usable || turret.cooldown > 0) return [];
    const count = Math.min(this.barrels, turret.ammo); // can't fire more than we have
    turret.cooldown = this.fireInterval;
    turret.ammo -= count;
    turret.recoil = 6;
    turret.muzzleFlash = 1;
    const spread = deg2rad(this.dispersionDeg);
    const m = turret.muzzle();
    // Offset each barrel perpendicular to the aim so the rounds run parallel a
    // few px apart.
    const px = -Math.sin(turret.angle);
    const py = Math.cos(turret.angle);
    const gap = CONFIG.turret.twinSpacing;
    const shots = [];
    for (let i = 0; i < count; i++) {
      const off = count === 1 ? 0 : (i - (count - 1) / 2) * gap;
      shots.push(
        new Bullet(m.x + px * off, m.y + py * off, turret.angle + rand(-spread, spread))
      );
    }
    return shots;
  }

  upgradeFireRate() {
    this.fireRateLevel++;
  }

  upgradeTwin() {
    this.twin = true;
  }
}

/**
 * Interceptor launcher — a cheap shop purchase that then fires itself:
 * unlimited stock, gated by a reload cooldown that shop upgrades buy down
 * (6s -> 1s). Does nothing until bought.
 */
export class InterceptorWeapon {
  constructor() {
    this.name = 'Interceptor';
    this.owned = false;
    this.cooldownLevel = 0;
    this.timer = 0; // seconds until the next launch is ready
  }

  /** Field the battery; fresh from the factory it arrives fully loaded. */
  buy() {
    this.owned = true;
    this.timer = 0;
  }

  /** Current reload time between launches, by upgrade level. */
  get cooldown() {
    return CONFIG.interceptor.cooldowns[this.cooldownLevel];
  }

  get canLaunch() {
    return this.owned && this.timer <= 0;
  }

  /** Fraction of the reload remaining (1 = just fired, 0 = ready). */
  get reloadFrac() {
    return Math.max(0, this.timer / this.cooldown);
  }

  update(dt) {
    if (this.timer > 0) this.timer -= dt;
  }

  /** Wave start: the pod comes back fully loaded and ready. */
  refill() {
    this.timer = 0;
  }

  /** Launch a homing Interceptor and start the reload, or null if reloading. */
  launch(x, y, target) {
    if (!this.canLaunch) return null;
    this.timer = this.cooldown;
    return new Interceptor(x, y, target);
  }

  upgradeCooldown() {
    if (this.cooldownLevel < CONFIG.interceptor.cooldowns.length - 1) this.cooldownLevel++;
  }
}

/**
 * Laser — a purchasable, fully autonomous point-defense beam left of the
 * CIWS mount. It latches onto one eligible target and burns it down over
 * time (dps), so a drone dies in a blink while an armoured MIRV bus takes a
 * long, committed burn. It only tracks slow, predictable targets: drones and
 * normal-type missiles (including MIRV carriers) — never the fast movers.
 * After each kill it recharges; upgrades buy a faster recharge.
 */
export class LaserWeapon {
  constructor() {
    this.name = 'Laser';
    this.owned = false;
    this.level = 0; // recharge upgrade level
    this.timer = 0; // seconds until the next burn is ready
    this.target = null; // missile currently being burned
    this.angle = -Math.PI / 2; // emitter aim (sim angle; starts straight up)
  }

  get rechargeTime() {
    return CONFIG.laser.cooldowns[this.level];
  }

  /** HP burned off the latched target per second. */
  get dps() {
    return CONFIG.laser.dps;
  }

  get canFire() {
    return this.owned && this.timer <= 0;
  }

  get burning() {
    return this.target != null;
  }

  /** Fraction of the recharge remaining (1 = just fired, 0 = ready). */
  get chargeFrac() {
    return this.owned ? 1 - Math.max(0, this.timer / this.rechargeTime) : 0;
  }

  update(dt) {
    if (this.timer > 0) this.timer -= dt;
  }

  /** Whether the laser will engage this missile. */
  canTarget(m) {
    return (
      !m.dead &&
      (m.type === 'drone' || m.type === 'normal' || m.type === 'glidebomb')
    );
  }

  fire() {
    this.timer = this.rechargeTime;
  }

  buy() {
    this.owned = true;
    this.timer = 0;
  }

  upgradeRecharge() {
    if (this.level < CONFIG.laser.cooldowns.length - 1) this.level++;
  }
}
