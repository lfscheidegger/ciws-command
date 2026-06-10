// ---------------------------------------------------------------------------
// Secret dev console: god mode, sandbox scenarios, and the guarantees that a
// doctored run can't end and can't pollute the high-score table.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'bun:test';
import { newGame } from './helpers.js';
import { CONFIG } from '../js/config.js';
import { DEV_SCENARIOS } from '../js/game.js';
import { EnemyMissile } from '../js/entities.js';

const byKey = (key) => DEV_SCENARIOS.find((s) => s.key === key);

describe('God mode', () => {
  it('a direct hit cannot destroy a city or the gun', () => {
    const g = newGame();
    g.startGame();
    g.devInvincible = true;
    const city = g.cities[0];
    const gun = g.turrets[0];
    g.impact({ type: 'normal', x: city.x, y: g.groundY });
    g.impact({ type: 'normal', x: gun.x, y: g.groundY });
    expect(city.alive).toBe(true);
    expect(gun.alive).toBe(true);
  });

  it('shrugs off a nuke air-burst', () => {
    const g = newGame();
    g.startGame();
    g.devInvincible = true;
    g.impact({ type: 'nuke', x: g.cities[2].x, y: g.groundY - 120 });
    expect(g.cities.every((c) => c.alive)).toBe(true);
    expect(g.turrets.every((t) => t.alive)).toBe(true);
  });

  it('survives a restart, and keeps the run off the score table', () => {
    const g = newGame();
    g.devInvincible = true;
    g.startGame();
    expect(g.devInvincible).toBe(true);
    let banked = 0;
    g.scoreboard = { add: () => banked++ };
    g.gameOver('Cities lost');
    expect(banked).toBe(0);
    expect(g.lastRun).toBeNull();
  });
});

describe('Sandbox scenarios', () => {
  it('bombers respawn forever and the wave never ends', () => {
    const g = newGame();
    g.devLoadout = false; // observe spawning alone
    g.startSandbox(byKey('bombers'));
    expect(g.state).toBe('playing');
    g.update(1 / 60);
    expect(g.missiles.filter((m) => m.type === 'bomber').length).toBeGreaterThan(0);

    // Wipe the sky repeatedly: the spawner keeps refilling it.
    let respawns = 0;
    for (let i = 0; i < 1200; i++) {
      if (g.missiles.length) {
        g.missiles = [];
        respawns++;
      }
      g.update(1 / 60);
    }
    expect(respawns).toBeGreaterThan(2);
    expect(g.state).toBe('playing'); // never went to intermission/menu
  });

  it('respects the live ceiling', () => {
    const g = newGame();
    g.devLoadout = false;
    const sc = byKey('rain');
    g.startSandbox(sc);
    for (let i = 0; i < 600; i++) {
      g.update(1 / 60);
      // Freeze threats in the sky so impacts never thin the count.
      for (const m of g.missiles) m.update = () => null;
      expect(g.missiles.filter((m) => !m.dead).length).toBeLessThanOrEqual(sc.maxLive);
    }
  });

  it('grants the loadout when the toggle is on', () => {
    const g = newGame();
    g.devLoadout = true;
    g.startSandbox(byKey('drones'));
    expect(g.interceptorWeapon.owned).toBe(true);
    expect(g.laser.owned).toBe(true);
  });

  it('devSpawn forces the requested type', () => {
    const g = newGame();
    g.startGame();
    g.wave = 9;
    for (const [type, expected] of [
      ['bomber', 'bomber'],
      ['drone', 'drone'],
      ['cruise', 'cruise'],
      ['stealth', 'stealth'],
      ['hypersonic', 'hypersonic'],
      ['evasive', 'evasive'],
      ['normal', 'normal'],
    ]) {
      g.missiles = [];
      g.devSpawn(type);
      expect(g.missiles.length).toBeGreaterThan(0);
      expect(g.missiles.every((m) => m.type === expected)).toBe(true);
    }
    g.missiles = [];
    g.devSpawn('mirv');
    expect(g.missiles[0].splitsRemaining).toBeGreaterThan(0);
    g.pendingNukes = [];
    g.devSpawn('nuke');
    expect(g.pendingNukes.length).toBe(1); // nukes arrive via the warning
  });

  it('a normal restart exits the sandbox', () => {
    const g = newGame();
    g.startSandbox(byKey('bombers'));
    g.startGame();
    expect(g.devScenario).toBeNull();
    expect(g.toSpawn).toBe(CONFIG.wave.baseMissiles);
  });
});

describe('Dev console input', () => {
  it('backquote toggles the menu and freezes the sim', () => {
    const g = newGame();
    g.startGame();
    g.handleKey('`');
    expect(g.devMenuOpen).toBe(true);
    const t0 = g.time;
    g.update(1);
    expect(g.time).toBe(t0); // frozen while the console is up
    g.handleKey('escape');
    expect(g.devMenuOpen).toBe(false);
  });

  it('hotkeys drive the menu and are swallowed by it', () => {
    const g = newGame();
    g.handleKey('`');
    g.handleKey('g');
    expect(g.devInvincible).toBe(true);
    g.handleKey('1'); // first scenario row
    expect(g.devScenario).toBe(DEV_SCENARIOS[0]);
    expect(g.devMenuOpen).toBe(false); // launching a sandbox closes the menu
    expect(g.state).toBe('playing');
  });
});
