// ---------------------------------------------------------------------------
// Bomber flare countermeasures: dispensing under attack, seeker seduction,
// burnout/reacquisition, and the explosion-radius override that keeps the
// interceptor's blast visual honest.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'bun:test';
import { newGame, withRandom } from './helpers.js';
import { CONFIG } from '../js/config.js';
import { EnemyMissile, Flare, Interceptor } from '../js/entities.js';

const F = CONFIG.missile.bomber.flares;

/** A bomber parked mid-field with a frozen homing interceptor on its tail. */
function bomberUnderAttack(g) {
  g.startGame();
  g.toSpawn = 0;
  g.missiles = [];
  const bomber = new EnemyMissile(-40, 200, 1500, 200, 130, 0, 0, 'bomber');
  bomber.x = bomber.cx = 700;
  g.missiles = [bomber];
  const it = new Interceptor(700, 350, bomber);
  it.update = () => null; // hold it inside evade range forever
  g.interceptorList = [it];
  return { bomber, it };
}

describe('Bomber flares', () => {
  it('punches out a burst while a homing interceptor closes', () => {
    const g = newGame();
    const { bomber } = bomberUnderAttack(g);
    g.update(1 / 60);
    expect(bomber.evading).toBe(true);
    expect(g.flares.length).toBe(F.perBurst);
    expect(bomber.flareBursts).toBe(F.bursts - 1);
    // The dispenser is on cooldown — no second burst the very next frame.
    g.update(1 / 60);
    expect(g.flares.length).toBe(F.perBurst);
  });

  it('carries a limited number of bursts', () => {
    const g = newGame();
    const { bomber } = bomberUnderAttack(g);
    bomber.hp = 99999; // survive any decoyed warhead going off nearby
    bomber.vx = 0; // park it so it can't cruise out of evade range mid-test
    for (let i = 0; i < 600; i++) g.update(1 / 60); // 10s >> all cooldowns
    expect(bomber.flareBursts).toBe(0);
  });

  it('can seduce the seeker off the airframe', () => {
    const g = newGame();
    const { bomber, it } = bomberUnderAttack(g);
    withRandom(0, () => g.dispenseFlares(bomber)); // roll 0 < decoyChance
    expect(it.target).not.toBe(bomber);
    expect(g.flares).toContain(it.target);
  });

  it('a steely seeker ignores the flares', () => {
    const g = newGame();
    const { bomber, it } = bomberUnderAttack(g);
    withRandom(0.99, () => g.dispenseFlares(bomber)); // roll misses decoyChance
    expect(it.target).toBe(bomber);
  });

  it('reacquires when the decoy burns out', () => {
    const g = newGame();
    const { bomber, it } = bomberUnderAttack(g);
    withRandom(0, () => g.dispenseFlares(bomber));
    for (const f of g.flares) f.age = F.life; // gutter them all out
    g.update(1 / 60);
    expect(g.flares.length).toBe(0);
    expect(it.target).toBe(bomber); // only live threat left
  });

  it('the pilot keeps evading while a round chases his own decoy', () => {
    const g = newGame();
    const { bomber, it } = bomberUnderAttack(g);
    withRandom(0, () => g.dispenseFlares(bomber)); // seduce the seeker
    expect(it.target).not.toBe(bomber);
    g.update(1 / 60);
    expect(bomber.evading).toBe(true); // he can't know the decoy took
  });

  it('flares burn for their configured life and fall away', () => {
    const f = new Flare(100, 100, 0, 0);
    const y0 = f.y;
    let t = 0;
    while (!f.dead && t < 10) {
      f.update(1 / 60);
      t += 1 / 60;
    }
    expect(t).toBeGreaterThan(F.life - 0.1);
    expect(t).toBeLessThan(F.life + 0.1);
    expect(f.y).toBeGreaterThan(y0); // gravity won (sim +y is down)
  });
});

describe('Bomber defensive flying', () => {
  it('commits to a hard break away from a close-in round', () => {
    const g = newGame();
    const { bomber, it } = bomberUnderAttack(g);
    bomber.y = bomber.cy = 600; // mid-band, with room to haul upward
    it.x = bomber.x;
    it.y = bomber.y + 150; // closing from below, inside breakRange
    g.update(1 / 60);
    expect(bomber.breaking).toBe(true);
    expect(bomber.breakDir).toBe(-1); // pull up, away from the approach
    // Sample mid-break (it ends itself once the bomber wins separation).
    // The pull is bounded by the energy model: total speed stays near
    // cruise, so the climb rate is judged relative to the bomber's speed.
    for (let i = 0; i < 15; i++) g.update(1 / 60);
    expect(bomber.vy).toBeLessThan(-0.6 * bomber.speed);
    const total = Math.hypot(bomber.vx, bomber.vy);
    expect(total).toBeLessThanOrEqual(
      bomber.speed * CONFIG.missile.bomber.maxSpeedFactor * 1.01
    );
  });

  it('a pilot forced to jink aborts his bombing run for good', () => {
    const g = newGame();
    const { bomber, it } = bomberUnderAttack(g);
    expect(bomber.bombsLeft).toBeGreaterThan(0);
    g.update(1 / 60);
    expect(bomber.evading).toBe(true);
    expect(bomber.bombsAborted).toBe(true);
    // Threat gone — the run STAYS aborted; no bombs ever come off the rack.
    it.dead = true;
    bomber.x = bomber.cx = 700; // over the field, where drops would happen
    const racked = bomber.bombsLeft;
    for (let i = 0; i < 300; i++) {
      bomber.x = bomber.cx = 700; // hold it over the field
      g.update(1 / 60);
    }
    expect(bomber.bombsLeft).toBe(racked);
    expect(g.missiles.filter((m) => m.type === 'glidebomb').length).toBe(0);
  });

  it('weaves out of an incoming CIWS stream', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    const bomber = new EnemyMissile(-40, 200, 1500, 200, 130, 0, 0, 'bomber');
    bomber.x = bomber.cx = 700;
    bomber.y = bomber.cy = 400;
    g.missiles = [bomber];
    // A round dead on course for the airframe vs one sailing wide.
    g.bullets = [{ x: 700, y: 700, vx: 0, vy: -1120, dead: false }];
    expect(g.bulletThreatens(bomber)).toBe(true);
    g.bullets = [{ x: 200, y: 700, vx: 0, vy: -1120, dead: false }];
    expect(g.bulletThreatens(bomber)).toBe(false);
  });

  it('never leaves its altitude band, even mid-break', () => {
    const g = newGame();
    const { bomber } = bomberUnderAttack(g);
    const minY = g.groundY * CONFIG.missile.bomber.bandFrac[0];
    bomber.y = bomber.cy = minY - 2; // pushed past the band ceiling
    bomber.breaking = true;
    bomber.breakDir = -1; // still pulling up, into the ceiling
    bomber.update(1 / 60, g.groundY);
    expect(bomber.vy).toBe(0); // pinned...
    expect(bomber.breakDir).toBe(1); // ...and the pull flips downward
  });
});

describe('Interceptor target exclusions', () => {
  it('the launcher never spends a round on a lone glide bomb', () => {
    const g = newGame();
    g.startGame();
    g.toSpawn = 0;
    const bomb = new EnemyMissile(700, 300, 800, g.groundY, 160, 0, 0, 'glidebomb');
    g.missiles = [bomb];
    g.interceptorWeapon.buy();
    g.interceptorWeapon.timer = 0;
    g.updateInterceptorLauncher(1 / 60);
    expect(g.interceptorList.length).toBe(0); // held fire
  });

  it('retasking skips glide bombs too', () => {
    const g = newGame();
    g.startGame();
    const bomb = new EnemyMissile(700, 300, 800, g.groundY, 160, 0, 0, 'glidebomb');
    g.missiles = [bomb];
    expect(g.nearestInterceptTarget({ x: 700, y: 400 })).toBeNull();
  });
});

describe('Explosion radius override', () => {
  it('boom() honours an explicit radius, else the size preset', () => {
    const g = newGame();
    g.startGame();
    g.explosions = [];
    g.boom(10, 10, 'medium', '#fff', 72);
    g.boom(10, 10, 'medium', '#fff');
    expect(g.explosions[0].maxR).toBe(72);
    expect(g.explosions[1].maxR).toBe(CONFIG.explosion.medium.radius);
  });

  it('the interceptor blast visual matches its kill radius', () => {
    const g = newGame();
    g.startGame();
    g.explosions = [];
    g.missiles = [];
    const it = new Interceptor(700, 400, null);
    g.detonateInterceptor(it);
    expect(g.explosions[0].maxR).toBe(CONFIG.interceptor.blastRadius);
  });
});
