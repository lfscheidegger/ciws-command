// ---------------------------------------------------------------------------
// Shared test helpers: a fake 2D canvas, a stub renderer, a Game factory, and a
// deterministic Math.random override.
// ---------------------------------------------------------------------------

import { Game } from '../js/game.js';

/** A canvas whose 2D context swallows every call (we never assert on drawing). */
export function makeFakeCanvas() {
  const ctx = new Proxy(
    {},
    {
      get: () => () => {}, // every property resolves to a no-op function
      set: () => true,
    }
  );
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 800 }),
  };
}

/** Identity-projection stub standing in for the WebGL renderer. */
export function makeStubRenderer() {
  return {
    setSize() {},
    setBottomInset(px) {
      this.bottomInset = px; // recorded so tests can assert on the layout
    },
    syncStructures() {},
    render() {},
    screenToWorld(x, y) {
      return { x, y };
    },
    worldToScreen(x, y) {
      return { x, y };
    },
  };
}

/** Construct a headless Game wired to the fakes. */
export function newGame() {
  return new Game(makeFakeCanvas(), makeStubRenderer());
}

/**
 * Run `fn` with Math.random replaced. Pass a number for a constant, an array
 * for a finite sequence (last value repeats), or a function for full control.
 * Always restores the original afterwards.
 */
export function withRandom(value, fn) {
  const orig = Math.random;
  if (typeof value === 'function') {
    Math.random = value;
  } else if (Array.isArray(value)) {
    let i = 0;
    Math.random = () => value[Math.min(i++, value.length - 1)];
  } else {
    Math.random = () => value;
  }
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}
