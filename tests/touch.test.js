// ---------------------------------------------------------------------------
// Touch mode: the fire-control pad layout, its absolute aim mapping, and the
// renderer inset that letterboxes the field above it.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'bun:test';
import { newGame } from './helpers.js';
import { CONFIG } from '../js/config.js';

describe('Touch mode layout', () => {
  it('is off by default in the test environment', () => {
    const g = newGame();
    expect(g.touchMode).toBe(false);
    expect(g.padRect).toBeNull();
    expect(g.renderer.bottomInset ?? 0).toBe(0);
  });

  it('reserves the pad strip and tells the renderer to letterbox', () => {
    const g = newGame();
    g.setTouchMode(true);
    const P = CONFIG.ui.touchPad;
    const r = g.padRect;
    expect(r).not.toBeNull();
    expect(r.h).toBe(Math.min(P.maxHeight, Math.round(g.screenH * P.heightFrac)));
    expect(r.w).toBe(g.screenW - P.margin * 2);
    expect(r.y + r.h + P.bottomMargin).toBe(g.screenH); // docked to the bottom
    expect(g.renderer.bottomInset).toBe(r.h + P.bottomMargin + 8);

    g.setTouchMode(false);
    expect(g.padRect).toBeNull();
    expect(g.renderer.bottomInset).toBe(0);
  });

  it('maps pad touches to the full field, clamped at the edges', () => {
    const g = newGame();
    g.setTouchMode(true);
    const r = g.padRect;
    g.aimFromPad(r.x + r.w / 2, r.y + r.h / 2);
    expect(g.mouseX).toBeCloseTo(g.W / 2, 0);
    expect(g.mouseY).toBeCloseTo(g.groundY / 2, 0);
    g.aimFromPad(r.x, r.y); // top-left corner of the pad = top-left of field
    expect(g.mouseX).toBe(0);
    expect(g.mouseY).toBe(0);
    g.aimFromPad(r.x + r.w + 50, r.y + r.h + 50); // overshoot clamps
    expect(g.mouseX).toBe(g.W);
    expect(g.mouseY).toBe(g.groundY);
  });

  it('the dev console exposes a touch toggle', () => {
    const g = newGame();
    g.handleKey('`');
    g.handleKey('t');
    expect(g.touchMode).toBe(true);
    g.handleKey('t');
    expect(g.touchMode).toBe(false);
    g.handleKey('`');
  });
});
