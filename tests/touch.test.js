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

  it('armory: a row tap selects, only the BUY button spends', () => {
    const g = newGame();
    g.setTouchMode(true);
    g.startGame();
    g.credits = 500;
    g.endWave(); // -> intermission, selection reset to the top row
    expect(g.state).toBe('intermission');
    expect(g.shopSelected).toBe(0);

    const { rows, buyRect, nextRect } = g.shopLayout();
    expect(buyRect).toBeDefined();

    // Tapping a row selects it — and does NOT buy.
    const cr0 = g.credits;
    g.handleShopClick(rows[2].x + 10, rows[2].y + 10);
    expect(g.shopSelected).toBe(2);
    expect(g.credits).toBe(cr0);

    // The BUY button purchases the selected item.
    g.handleShopClick(rows[0].x + 10, rows[0].y + 10); // interceptor row
    const item = g.shopLayout().rows[0].item;
    expect(item.enabled).toBe(true);
    g.handleShopClick(buyRect.x + 10, buyRect.y + 10);
    expect(g.credits).toBe(cr0 - item.cost);
    expect(g.interceptorWeapon.owned).toBe(true);

    // NEXT WAVE proceeds.
    g.handleShopClick(nextRect.x + 10, nextRect.y + 10);
    expect(g.state).toBe('playing');
  });

  it('armory: desktop click-to-buy is unchanged', () => {
    const g = newGame();
    g.startGame();
    g.credits = 500;
    g.endWave();
    const { rows, buyRect } = g.shopLayout();
    expect(buyRect).toBeUndefined(); // no touch buttons on desktop
    const cr0 = g.credits;
    g.handleShopClick(rows[0].x + 10, rows[0].y + 10);
    expect(g.credits).toBeLessThan(cr0); // bought directly
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
