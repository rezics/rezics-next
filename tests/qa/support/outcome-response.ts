/** Repeat only named refusals, within the caller's existing request budget. */
export async function outcomeResponse(
  request: (signal: AbortSignal) => Promise<Response>,
  deadlineMs = 45_000,
  call: { method?: string; path?: string; idempotencyKey?: string } = {},
): Promise<Response> {
  const signal = AbortSignal.timeout(deadlineMs);
  const deadline = Date.now() + deadlineMs;
  const method = (call.method ?? 'GET').toUpperCase();
  const read = ['GET', 'HEAD'].includes(method);
  let previous: Response | undefined;
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try { response = await request(signal); }
    catch (error) { if (signal.aborted && previous) return previous; throw error; }
    await previous?.body?.cancel();
    if (response.status !== 503) return response;
    const problem = await response.clone().json().catch(() => null) as { code?: string } | null;
    // AdmissionUnavailable also occurs after committed writes. Its shared
    // dependency code cannot establish that a command had no effects.
    const repeat = (problem?.code === 'dependency_unavailable' && read)
      || (problem?.code === 'work_read_unavailable' && (read || call.idempotencyKey !== undefined));
    if (!repeat || signal.aborted) return response;
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter === null ? 1 : Number(retryAfter);
    const date = retryAfter === null ? NaN : Date.parse(retryAfter);
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
    await Bun.sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    if (signal.aborted || Date.now() >= deadline) return response;
    previous = response;
    console.info(`Persona repeat ${method} ${call.path ?? '<read>'} ${problem!.code} try ${attempt + 1}`);
  }
}

