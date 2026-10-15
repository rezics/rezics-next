import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';

export type RecordedState = 'populated' | 'empty' | 'error' | 'loading' | 'pending';
export interface RecordedSelection {
  label: string;
  state: RecordedState;
}

function sameBody(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.entries(left), b = Object.entries(right);
  return a.length === b.length && a.every(([key, value]) =>
    Object.hasOwn(right, key) && sameBody(value, (right as Record<string, unknown>)[key]));
}

/** A query is its parameters: two callers write the same ones in different orders and the API reads
 * them by name. The values of one repeated name keep their order. */
function requestKey(path: string): string {
  const at = path.indexOf('?');
  if (at < 0) return path;
  const pairs = [...new URLSearchParams(path.slice(at + 1))];
  if (!pairs.length) return path.slice(0, at);
  pairs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `${path.slice(0, at)}?${new URLSearchParams(pairs)}`;
}

/** Each mount owns a transport and disposes it at teardown. Labels choose answers;
 * the caller knows which completed sample is empty. No domain rules run in this fetch.
 * JSON bodies and query parameters match by value; the path retains its exact wire spelling.
 * `sequence` admits successive recorded answers for repeated refresh requests,
 * advancing only their exact matches and repeating their last recorded answer. */
export function recordedFetch(
  record: AnswerRecord,
  persona: AnswerPersona,
  selections: readonly RecordedSelection[],
  { pathPrefix = '', sequence = false, readBinary }: { pathPrefix?: string; sequence?: boolean;
    /** Node callers read repository files; browser callers read the bundler's URL for that same fixture. */
    readBinary?: (source: string) => Promise<Uint8Array> } = {},
): { fetcher: typeof fetch; dispose: () => void } {
  if (pathPrefix && (!pathPrefix.startsWith('/') || pathPrefix.endsWith('/'))) {
    throw new Error('Recorded fetch pathPrefix must be a path without a trailing slash');
  }
  const samples = selections.map(({ label, state }) => {
    const found = record.personas[persona].filter(sample => sample.label === label);
    if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
    const sample = found[0]!;
    // A create answers 201 and a removal 204: both are complete, unlike the 202 of a command still running.
    const admitted = state === 'loading' ||
      ((state === 'populated' || state === 'empty') && [200, 201, 204].includes(sample.status)) ||
      (state === 'pending' && sample.status === 202) ||
      (state === 'error' && sample.status >= 400 && sample.status <= 599);
    if (!admitted) throw new Error(`Recorded sample ${label} (${sample.status}) cannot supply ${state}`);
    return { sample, state, used: false };
  });
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i]!.sample;
    if (!sequence && samples.slice(0, i).some(({ sample }) => sample.method === current.method &&
      requestKey(sample.path) === requestKey(current.path) && sameBody(sample.body, current.body))) {
      throw new Error(`Ambiguous recorded request: ${current.method} ${current.path}`);
    }
  }

  let disposed = false;
  const held = new Set<() => void>();
  const ended = () => new DOMException('Recorded story ended', 'AbortError');
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (disposed) throw ended();
    // Construct a copy so reading a caller's Request never consumes its body.
    const request = new Request(input instanceof Request ? input.clone() :
      new URL(String(input), 'https://recorded.invalid'), init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    const path = url.pathname.startsWith(`${pathPrefix}/`)
      ? url.pathname.slice(pathPrefix.length) + url.search : url.pathname + url.search;
    const text = await request.text();
    let body: unknown = undefined;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = text; }
    }
    if (disposed) throw ended();
    request.signal.throwIfAborted();
    const key = requestKey(path);
    const matches = samples.filter(({ sample }) => sample.method === request.method &&
      requestKey(sample.path) === key && sameBody(sample.body, body));
    // A production refresh repeats a request after its command. In sequence mode
    // matching samples advance in recorded order; the final answer remains current.
    const match = sequence ? matches.find(item => !item.used) ?? matches.at(-1) : matches[0];
    if (match && sequence) match.used = true;
    if (!match) throw new Error(`Unmatched recorded request (${record.row}/${persona}): ${JSON.stringify({
      method: request.method, path: url.pathname + url.search, body: body === undefined ? '<absent>' : body,
    })}`);
    if (match.state === 'loading') return new Promise<Response>((_resolve, reject) => {
      const release = () => {
        held.delete(release);
        request.signal.removeEventListener('abort', release);
        reject(request.signal.aborted ? request.signal.reason : ended());
      };
      held.add(release);
      request.signal.addEventListener('abort', release, { once: true });
    });
    const { status, headers, answer } = match.sample;
    if (match.sample.binary) {
      const { source, byteLength, sha256 } = match.sample.binary;
      if (!readBinary) throw new Error(`Recorded binary source loader is absent: ${source}`);
      const bytes = await readBinary(source);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (bytes.byteLength !== byteLength || digest !== sha256) throw new Error(`Recorded binary source integrity mismatch: ${source}`);
      if (disposed) throw ended();
      request.signal.throwIfAborted();
      return new Response(new Uint8Array(bytes), { status, headers });
    }
    return new Response([204, 205, 304].includes(status) ? null : JSON.stringify(answer), { status, headers });
  }) as typeof fetch;

  return {
    fetcher,
    dispose() {
      disposed = true;
      for (const release of held) release();
    },
  };
}
