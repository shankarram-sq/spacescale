interface BucketState {
  tokens: number;
  updatedAt: number;
  violations: number;
}

export class TokenBucket {
  readonly #states = new Map<string, BucketState>();

  consume(key: string, sustainedPerSecond: number, burst: number, now = Date.now()): boolean {
    const previous = this.#states.get(key) ?? { tokens: burst, updatedAt: now, violations: 0 };
    const elapsed = Math.max(0, now - previous.updatedAt) / 1_000;
    const tokens = Math.min(burst, previous.tokens + elapsed * sustainedPerSecond);
    if (tokens < 1) {
      this.#states.set(key, { tokens, updatedAt: now, violations: previous.violations + 1 });
      return false;
    }
    this.#states.set(key, {
      tokens: tokens - 1,
      updatedAt: now,
      violations: Math.max(0, previous.violations - 1),
    });
    return true;
  }

  violations(key: string): number {
    return this.#states.get(key)?.violations ?? 0;
  }

  delete(key: string): void {
    this.#states.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of this.#states.keys()) {
      if (key.startsWith(prefix)) this.#states.delete(key);
    }
  }
}
