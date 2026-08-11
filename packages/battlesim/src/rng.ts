/**
 * Seeded PRNG (mulberry32). The whole point of the simulator is comparing two
 * balance tweaks, so a run has to be reproducible — `Math.random()` would make
 * every report differ from the last by noise alone. Same reasoning the plan
 * gives for seeding the M8 runtime (§3 M8's "亂數非決定性" row), just needed
 * three milestones earlier.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 0 is a fine seed for mulberry32 (the counter is added before mixing).
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** MZ's `Math.randomInt(n)`: an integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}
