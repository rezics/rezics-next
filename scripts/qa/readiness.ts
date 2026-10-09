const stopped = Object.freeze({ deadline: true });

function pause(ms: number): { done: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: () => void = () => {};
  const done = new Promise<void>(resolve => {
    finish = resolve;
    timer = setTimeout(resolve, ms);
  });
  return {
    done,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      finish();
    },
  };
}

/** Poll `probe` until it succeeds or `deadline` (epoch milliseconds) passes.
 * A Response body is cancelled on every attempt, including one that resolves
 * after the deadline abandons it. `response.ok` is only that probe's HTTP
 * result; it does not establish graph generation or index readiness. */
export async function pollUntilDeadline(
  probe: (remainingMs: number) => Promise<Response | boolean>,
  deadline: number,
  retryMs = 250,
): Promise<boolean> {
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const limit = pause(remaining);
    let response: Response | undefined;
    let released = false;
    let abandoned = false;
    const cancelResponse = async () => {
      const body = response?.body;
      if (released || !body) return;
      released = true;
      await body.cancel();
    };
    const attempt = probe(remaining).then(value => {
      if (value instanceof Response) response = value;
      return value;
    });
    // A body that arrives after the deadline still has to be released.
    const lateRelease = attempt.then(async () => {
      if (abandoned) await cancelResponse();
    }).catch(() => undefined);
    let result: Response | boolean | typeof stopped;
    try {
      result = await Promise.race([
        attempt,
        limit.done.then(() => stopped),
      ]);
    } catch (error) {
      limit.cancel();
      await cancelResponse();
      throw error;
    }
    limit.cancel();
    if (result === stopped) {
      abandoned = true;
      void lateRelease;
      return false;
    }
    await cancelResponse();
    if (result === true || (result instanceof Response && result.ok)) return true;
    const wait = Math.min(retryMs, deadline - Date.now());
    if (wait <= 0) return false;
    await Bun.sleep(wait);
  }
  return false;
}
