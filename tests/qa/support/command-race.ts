type CommandResponse = Response | { status: number; body: unknown };

type RaceOptions = {
  maxAttempts?: number;
  timeoutMs?: number;
  phase?: string;
  sleep?: (afterMs: number) => Promise<unknown>;
};

async function bodyOf(response: CommandResponse): Promise<unknown> {
  if (!(response instanceof Response)) return response.body;
  const text = await response.clone().text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Retry the original losing intent and key; changing either can admit another successor. */
export async function assertCommandRace<T extends CommandResponse>(
  responses: readonly T[],
  expectedStatus: 200 | 201,
  resend: (index: number) => Promise<T>,
  options: RaceOptions = {},
): Promise<T[]> {
  const maxAttempts = options.maxAttempts ?? 5;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error('Command race requires a positive retry count and timeout');
  }
  const evidence = await Promise.all(
    responses.map(async (response, index) => ({
      index,
      attempt: 0,
      status: response.status,
      body: await bodyOf(response),
    })),
  );
  const fail = (reason: string): never => {
    throw new Error(`Command race: ${reason}; responses=${JSON.stringify(evidence)}`);
  };
  if (
    responses.length < 2 ||
    responses.filter((response) => response.status === expectedStatus).length !== 1
  ) {
    fail(`expected exactly one ${expectedStatus} success among at least two contenders`);
  }
  const deadline = Date.now() + timeoutMs;
  const settled = [...responses];
  for (let index = 0; index < settled.length; index++) {
    let response = settled[index]!;
    if (response.status === expectedStatus) continue;
    let operationId: string | undefined;
    let attempt = 0;
    while (response.status === 202) {
      const pending = (await bodyOf(response)) as {
        operationId?: unknown;
        status?: unknown;
        phase?: unknown;
        result?: unknown;
        retry?: { allowed?: unknown; afterMs?: unknown };
      } | null;
      const afterMs = pending?.retry?.afterMs;
      if (
        pending?.status !== 'reconciling' ||
        pending.result !== null ||
        typeof pending.operationId !== 'string' ||
        !pending.operationId.length ||
        typeof pending.phase !== 'string' ||
        !pending.phase.length ||
        (options.phase !== undefined && pending.phase !== options.phase) ||
        pending.retry?.allowed !== true ||
        typeof afterMs !== 'number' ||
        !Number.isFinite(afterMs) ||
        afterMs < 0
      ) {
        fail(`contender ${index} returned an invalid reconciling answer`);
      }
      operationId ??= pending!.operationId as string;
      if (pending!.operationId !== operationId)
        fail(`contender ${index} changed operation identity`);
      if (attempt >= maxAttempts || Date.now() + (afterMs as number) >= deadline) {
        fail(`contender ${index} did not settle within ${maxAttempts} retries / ${timeoutMs}ms`);
      }
      await (options.sleep ?? Bun.sleep)(afterMs as number);
      attempt++;
      // Bound the resend itself, including a hung request, by the same deadline.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        response = await Promise.race([
          resend(index),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Command race resend timed out')),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        fail(`contender ${index} retry ${attempt} failed: ${String(error)}`);
      } finally {
        clearTimeout(timer);
      }
      evidence.push({ index, attempt, status: response.status, body: await bodyOf(response) });
    }
    if (response.status !== 409)
      fail(`contender ${index} settled to ${response.status}, expected 409`);
    settled[index] = response;
  }
  return settled;
}
