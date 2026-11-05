type Started<T> = { ok: true; value: T } | { ok: false };

const stopped = { ok: false } as const;

/** Shares the first failure across a request's bounded Source workers. */
export class RequestSourceLifetime {
  #stopped = false;
  #failure: unknown;

  get stopped(): boolean {
    return this.#stopped;
  }

  async start<T>(operation: () => Promise<T>): Promise<Started<T>> {
    if (this.#stopped) return stopped;
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      this.fail(error);
      return stopped;
    }
  }

  fail(error: unknown): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#failure = error;
  }

  throwIfFailed(): void {
    if (this.#stopped) throw this.#failure;
  }
}
