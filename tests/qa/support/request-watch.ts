export const requestWatchPrefix = '[persona-request]';

interface RequestIdentity {
  persona: string;
  service: 'Main' | 'Account';
  method: string;
  url: URL;
}
interface WatchRuntime {
  now(): number;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(timer: unknown): void;
  log(line: string): void;
}

// Verification URLs contain credentials; ordinary query terms remain diagnostic.
function requestPath(url: URL): string {
  const query = new URLSearchParams(url.search);
  let redacted = false;
  for (const name of [...query.keys()]) {
    if (/(token|bearer|cookie|password|secret|authorization|credential|code|api[-_]?key)/i.test(name)) {
      query.set(name, '[redacted]');
      redacted = true;
    }
  }
  if (!redacted) return url.pathname + url.search;
  const search = query.toString();
  return url.pathname + (search ? `?${search}` : '');
}

/** One timer and entry per HTTP attempt; never retains request headers or bodies. */
export class RequestWatch {
  private readonly pending = new Map<object, {
    identity: Omit<RequestIdentity, 'url'> & { path: string };
    started: number;
    timer: unknown;
  }>();

  constructor(private readonly runtime: WatchRuntime = {
    now: () => performance.now(),
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    log: line => console.info(line),
  }) {}

  get size(): number { return this.pending.size; }

  start(request: RequestIdentity): (response?: Response) => void {
    const key = {};
    const entry = {
      identity: { persona: request.persona, service: request.service,
        method: request.method, path: requestPath(request.url) },
      started: this.runtime.now(),
      timer: undefined as unknown,
    };
    entry.timer = this.runtime.setTimer(() => {
      if (this.pending.has(key)) this.line('pending', entry);
    }, 10_000);
    this.pending.set(key, entry);
    return response => {
      if (!this.pending.delete(key)) return;
      this.runtime.clearTimer(entry.timer);
      if (this.runtime.now() - entry.started > 5_000) {
        const ids: Record<string, string> = {};
        for (const header of ['traceparent', 'x-trace-id', 'x-request-id', 'request-id']) {
          const value = response?.headers.get(header);
          if (value) ids[header] = value;
        }
        this.line('completed', entry, { status: response?.status ?? 'error', ...ids });
      }
    };
  }

  reportPending(): void {
    for (const entry of this.pending.values()) this.line('test-end', entry);
  }

  private line(event: string, entry: {
    identity: Omit<RequestIdentity, 'url'> & { path: string }; started: number;
  }, answer: Record<string, string | number> = {}): void {
    this.runtime.log(`${requestWatchPrefix} ${JSON.stringify({ event, ...entry.identity,
      elapsedMs: Math.round(this.runtime.now() - entry.started), ...answer })}`);
  }
}

/** Shared by fixture requests and the runner's teardown diagnostics. */
export const personaRequests = new RequestWatch();
