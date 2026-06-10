// ---------------------------------------------------------------------------
// Entry point: wire up the canvases, the Game instance and the rAF loop.
//
// The loop is requestAnimationFrame-driven, so on a 120 Hz display it runs at
// 120 fps as long as a frame fits the ~8.3 ms budget (the simulation is
// dt-based, so game speed is identical at any refresh rate). A small quality
// governor watches sustained frame times and steps the render resolution
// down once if the GPU can't keep up — full-screen bloom at devicePixelRatio
// 2 is by far the dominant cost.
// ---------------------------------------------------------------------------

import { Game } from './game.js';
import { Renderer } from './renderer3d.js';

const sceneCanvas = document.getElementById('scene');
const hudCanvas = document.getElementById('hud');
const renderer = new Renderer(sceneCanvas);
const game = new Game(hudCanvas, renderer);

// Expose for debugging in the console.
window.game = game;

let last = performance.now();

// Quality governor state: exponential moving average of the frame interval.
let emaDt = 8;
let slowSince = 0;
let qualityStepped = false;

function frame(now) {
  const rawDt = now - last;
  last = now;
  let dt = rawDt / 1000;
  if (dt > 0.05) dt = 0.05; // clamp tab-switch / GC pauses

  game.update(dt);
  game.render();

  // Governor: if frames sit above ~13 ms (under ~75 fps) for 3 s straight on
  // a high-density screen, drop the pixel ratio once (2 -> 1.5). One-way —
  // no oscillating back and forth.
  if (!qualityStepped && rawDt < 250) {
    emaDt = emaDt * 0.95 + rawDt * 0.05;
    if (emaDt > 13) {
      if (!slowSince) slowSince = now;
      if (now - slowSince > 3000 && (window.devicePixelRatio || 1) > 1.5) {
        qualityStepped = true;
        renderer.setPixelRatio(1.5);
      }
    } else {
      slowSince = 0;
    }
  }

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
