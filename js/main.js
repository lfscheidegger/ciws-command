// ---------------------------------------------------------------------------
// Entry point: wire up the canvases, the Game instance and the rAF loop.
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

function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.05) dt = 0.05; // clamp tab-switch / GC pauses

  game.update(dt);
  game.render();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
