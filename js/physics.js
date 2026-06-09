// ---------------------------------------------------------------------------
// Shared physics: an altitude-dependent air-density model plus a quadratic drag
// helper. Used by bullets, enemy missiles and interceptors so they all obey the
// same atmosphere — thin and frictionless up high, thick and draggy near the
// ground.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';

/**
 * Air density at simulation height `y` (sim +y is down, so the ground is the
 * largest y). Returns ~1 at sea level and decays exponentially with altitude,
 * clamped to a small floor way up high.
 */
export function airDensity(y, groundY) {
  const P = CONFIG.physics;
  const altitude = Math.max(0, (groundY - y) / groundY); // 0 at ground, ~1 at top
  return Math.max(P.densityFloor, Math.exp(-altitude / P.scaleHeight));
}

/**
 * Apply quadratic aerodynamic drag to an object with vx/vy in place:
 * deceleration ∝ drag coefficient · air density · speed. The per-frame factor
 * is clamped to [0,1] so a large dt can never reverse the velocity.
 */
export function applyDrag(obj, k, rho, dt) {
  const speed = Math.hypot(obj.vx, obj.vy);
  const factor = Math.max(0, 1 - k * rho * speed * dt);
  obj.vx *= factor;
  obj.vy *= factor;
}
