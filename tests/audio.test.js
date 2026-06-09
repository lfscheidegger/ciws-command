import { describe, it, expect } from 'bun:test';
import { sfx } from '../js/audio.js';

const EFFECTS = [
  'fire',
  'dryFire',
  'kill',
  'hit',
  'groundImpact',
  'targetHit',
  'waveClear',
  'gameOver',
  'hypersonicLaunch',
  'rocketBurn',
  'interceptorBoom',
  'shieldBreak',
  'denied',
  'buy',
  'laser',
  'alarm',
  'nukeBlast',
];

describe('sfx', () => {
  it('exposes every effect as a function', () => {
    for (const name of EFFECTS) expect(typeof sfx[name]).toBe('function');
  });

  it('all effects are safe no-ops before unlock (no AudioContext)', () => {
    expect(() => {
      for (const name of EFFECTS) sfx[name]();
    }).not.toThrow();
  });

  it('unlock() is safe without a real AudioContext', () => {
    expect(() => sfx.unlock()).not.toThrow();
  });

  it('toggleMute() flips and reports the mute state', () => {
    const before = sfx.muted;
    expect(sfx.toggleMute()).toBe(!before);
    sfx.toggleMute(); // restore
    expect(sfx.muted).toBe(before);
  });
});
