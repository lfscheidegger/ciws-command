// ---------------------------------------------------------------------------
// Test preload: stub the few browser globals the game logic touches at runtime
// (Game.resize / bindInput). The renderer is dependency-injected and audio is
// inert until unlock(), so nothing else from the DOM is needed.
// ---------------------------------------------------------------------------

const noop = () => {};

if (!globalThis.window) {
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    addEventListener: noop,
    removeEventListener: noop,
  };
}

if (!globalThis.document) {
  globalThis.document = { addEventListener: noop, removeEventListener: noop };
}
