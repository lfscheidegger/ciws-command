import { describe, it, expect } from 'bun:test';
import { airDensity, applyDrag } from '../js/physics.js';
import { CONFIG } from '../js/config.js';

const GROUND = 930;

describe('airDensity', () => {
  it('is ~1 at sea level (the ground)', () => {
    expect(airDensity(GROUND, GROUND)).toBeCloseTo(1, 6);
  });

  it('decreases with altitude (lower y = higher up = thinner)', () => {
    const low = airDensity(GROUND * 0.9, GROUND); // near ground
    const mid = airDensity(GROUND * 0.5, GROUND);
    const high = airDensity(GROUND * 0.1, GROUND); // near top
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
  });

  it('never drops below the configured floor', () => {
    const wayUp = airDensity(-GROUND * 2, GROUND); // far above the screen
    expect(wayUp).toBe(CONFIG.physics.densityFloor);
    expect(airDensity(0, GROUND)).toBeGreaterThanOrEqual(CONFIG.physics.densityFloor);
  });
});

describe('applyDrag', () => {
  it('reduces speed but preserves direction', () => {
    const o = { vx: 100, vy: 0 };
    applyDrag(o, 0.001, 1, 1); // factor = 1 - 0.001*1*100*1 = 0.9
    expect(o.vx).toBeCloseTo(90, 6);
    expect(o.vy).toBe(0);
  });

  it('scales with air density', () => {
    const dense = { vx: 100, vy: 0 };
    const thin = { vx: 100, vy: 0 };
    applyDrag(dense, 0.001, 1.0, 1);
    applyDrag(thin, 0.001, 0.2, 1);
    expect(100 - dense.vx).toBeGreaterThan(100 - thin.vx);
  });

  it('never reverses velocity even with a huge step', () => {
    const o = { vx: 100, vy: 0 };
    applyDrag(o, 1, 1, 1); // factor clamps to 0
    expect(o.vx).toBe(0);
    expect(o.vy).toBe(0);
  });

  it('drags a diagonal velocity proportionally (direction kept)', () => {
    const o = { vx: 30, vy: 40 }; // speed 50
    applyDrag(o, 0.002, 1, 1); // factor = 1 - 0.002*50 = 0.9
    expect(o.vx).toBeCloseTo(27, 6);
    expect(o.vy).toBeCloseTo(36, 6);
    expect(o.vy / o.vx).toBeCloseTo(40 / 30, 6);
  });
});
