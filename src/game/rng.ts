/**
 * A tiny seeded PRNG (mulberry32).
 *
 * Every deal is derived from a seed held in game state, which means a whole
 * match is reproducible from `{ seed, actions[] }`. That is exactly what the
 * multiplayer layer will need later: peers exchange the seed and the action
 * list rather than the full state, and each device replays to the same result.
 * It also makes bug reports replayable — paste a seed, get the same hand.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates. Returns a new array; the input is untouched. */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0
}

/** Deterministically derive the next hand's seed from the current one. */
export function nextSeed(seed: number): number {
  return Math.floor(mulberry32(seed)() * 0xffffffff) >>> 0
}
