// ---------------------------------------------------------------------------
// Local high-score table, persisted in localStorage. Storage is injectable
// (and gracefully absent in headless tests or when the browser blocks it) —
// every operation is a safe no-op without it.
// ---------------------------------------------------------------------------

const KEY = 'ciws-command-highscores';
export const MAX_SCORES = 10;

function defaultStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch (e) {
    // storage blocked (private mode / permissions) — run without persistence
  }
  return null;
}

export class ScoreBoard {
  constructor(storage = defaultStorage()) {
    this.storage = storage;
  }

  /** All saved entries, best first: [{score, wave, date}]. */
  load() {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Record a finished run. Returns { scores, rank } where rank is the new
   * entry's position in the table (0 = best ever) or -1 if it didn't place.
   */
  add(score, wave) {
    const entry = { score, wave, date: new Date().toISOString().slice(0, 10) };
    const scores = this.load();
    scores.push(entry);
    scores.sort((a, b) => b.score - a.score || b.wave - a.wave);
    const rank = scores.indexOf(entry);
    if (scores.length > MAX_SCORES) scores.length = MAX_SCORES;
    if (this.storage) {
      try {
        this.storage.setItem(KEY, JSON.stringify(scores));
      } catch (e) {
        // quota / blocked — the table just won't persist
      }
    }
    return { scores, rank: rank < MAX_SCORES ? rank : -1 };
  }
}

export const scoreboard = new ScoreBoard();
