interface SetupOptions {
  /** Absolute wall-clock limit shared by the setup phase, not renewed on retry. */
  readonly deadline: number;
  readonly status?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
}

/** Setup only: scenario requests must keep their first response observable. */
export async function setupRequest(
  handle: (request: Request) => Promise<Response>,
  request: Request,
  options: SetupOptions,
): Promise<Response> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const headers = new Headers(request.headers);
  if (!['GET', 'HEAD'].includes(request.method) && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', JSON.stringify(crypto.randomUUID()));
  }
  // Keep an unconsumed template so the handler can consume each attempt's body.
  const template = new Request(request, { headers });
  let failure = `Setup ${request.method} ${request.url} exceeded its deadline before the first attempt`;
  for (let attempt = 0; attempt < 6 && now() < options.deadline; attempt++) {
    const response = await handle(template.clone());
    if (options.status === undefined ? response.ok : response.status === options.status) return response;
    const body = await response.text();
    failure = `Setup ${request.method} ${request.url} failed (${response.status}): ${body}`;
    if (response.status !== 503 || attempt === 5) break;
    let problem;
    try {
      problem = JSON.parse(body);
    } catch {
      break;
    }
    if (problem?.retryable !== true || !['not_applied', 'not_applicable'].includes(problem?.effect_status)) break;
    const retryAfter = response.headers.get('Retry-After');
    let delay = 50 * 2 ** attempt;
    if (retryAfter !== null) {
      const value = retryAfter.trim();
      const parsed = /^\d+$/.test(value)
        ? Number(value) * 1000
        : /^[A-Za-z]{3}[, ]/.test(value)
          ? Date.parse(value) - now()
          : NaN;
      if (Number.isFinite(parsed)) delay = Math.max(0, parsed);
    }
    // Do not send early when Retry-After would use the remaining setup budget.
    if (now() + delay >= options.deadline) break;
    await sleep(delay);
  }
  throw new Error(failure);
}
