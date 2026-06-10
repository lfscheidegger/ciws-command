import { describe, it, expect } from 'bun:test';
import { ScoreBoard, MAX_SCORES } from '../js/scores.js';

/** Minimal in-memory localStorage stand-in. */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

describe('ScoreBoard', () => {
  it('records runs sorted best-first and reports the new rank', () => {
    const sb = new ScoreBoard(fakeStorage());
    expect(sb.load()).toEqual([]);
    expect(sb.add(100, 3).rank).toBe(0);
    expect(sb.add(50, 2).rank).toBe(1);
    const r = sb.add(200, 5);
    expect(r.rank).toBe(0);
    expect(r.scores.map((s) => s.score)).toEqual([200, 100, 50]);
    expect(sb.load()[0].wave).toBe(5);
  });

  it('keeps only the top entries and ranks off-table runs as -1', () => {
    const sb = new ScoreBoard(fakeStorage());
    for (let i = 1; i <= MAX_SCORES; i++) sb.add(i * 100, i);
    expect(sb.load()).toHaveLength(MAX_SCORES);
    const dud = sb.add(1, 1); // worse than everything on a full table
    expect(dud.rank).toBe(-1);
    expect(sb.load()).toHaveLength(MAX_SCORES);
    expect(sb.load()[MAX_SCORES - 1].score).toBe(100);
  });

  it('is a safe no-op without storage (headless / blocked)', () => {
    const sb = new ScoreBoard(null);
    expect(sb.load()).toEqual([]);
    const r = sb.add(500, 4);
    expect(r.rank).toBe(0); // still ranks the in-memory result
    expect(sb.load()).toEqual([]); // nothing persisted
  });
});
