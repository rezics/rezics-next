// Intended merge destination: services/main/tests/title-candidate-transport.test.ts.
// These HTTP transport doubles establish no Account, SQL, custody, or native authority.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { CommandForbidden, CommandOutcomeUnknown, FusekiClient,
  type TitleCandidateCommandEnvelope, type TitleCandidateResult } from '../src/infrastructure/fuseki.ts';
import { createHash } from 'node:crypto';
import { ObjectReadBudgetExceeded, S3ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';

test('selected immutable evidence uses a bounded S3 range with one overflow witness', async () => {
  const bytes = Buffer.from('bound');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const ranges: string[] = [], served: number[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const range = request.headers.get('range') ?? '';
    ranges.push(range);
    const maximum = Number(/^bytes=0-(\d+)$/.exec(range)?.[1]);
    const selected = bytes.subarray(0, maximum + 1);
    served.push(selected.length);
    return new Response(selected, { status: 206,
      headers: { 'content-range': `bytes 0-${selected.length - 1}/${bytes.length}` } });
  } });
  try {
    const objects = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`,
      bucket: 'title-test', prefix: 'work/', accessKeyId: 'local-key', secretAccessKey: 'local-secret' });
    expect(await objects.get(digest, bytes.length)).toEqual(new Uint8Array(bytes));
    await expect(objects.get(digest, bytes.length - 1)).rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
    expect(ranges).toEqual(['bytes=0-5', 'bytes=0-4']);
    expect(served).toEqual([5, 5]);
    for (const budget of [0, -1, NaN, Infinity, 1.5])
      await expect(objects.get(digest, budget)).rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
    expect(ranges).toHaveLength(2);
  } finally { await server.stop(true); }
});

test('immutable evidence refuses a corrupt ranged reply and cancels a chunked overflow', async () => {
  const digest = createHash('sha256').update('bound').digest('hex');
  const objects = new S3ImmutableObjects({ endpoint: 'http://s3.invalid', bucket: 'title-test', prefix: 'work/',
    accessKeyId: 'local-key', secretAccessKey: 'local-secret' });
  let cancelled = false;
  fetchStub(async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(6));
  }, cancel() { cancelled = true; } })));
  await expect(objects.get(digest, 5)).rejects.toBeInstanceOf(ObjectReadBudgetExceeded);
  expect(cancelled).toBe(true);
});

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
const admitted = 'a'.repeat(64), maintenance = 'b'.repeat(64);
const client = (token = admitted) => new FusekiClient('http://fuseki.invalid/rezics/', maintenance, token);
const envelope = (mode: 'accept' | 'lookup' = 'accept'): TitleCandidateCommandEnvelope => ({
  receipt: 'urn:rezics:receipt:' + 'c'.repeat(64), digest: 'd'.repeat(64), update: '', validations: [], deadlineMs: 10000,
  titleCandidate: { frame: '{"format":"transport-only-exact-byte-fixture","title":"東京"}',
    custodySha256: 'e'.repeat(64), mode },
  titleAdmission: { payload: '["original deterministic proof bytes",null,"2026-10-08T00:00:00.000Z"]',
    signature: 'f'.repeat(64) },
});
function fetchStub(handler: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) {
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(handler as typeof fetch);
  restores.push(() => mocked.mockRestore()); return mocked;
}
function readBody(init?: RequestInit): TitleCandidateCommandEnvelope {
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${admitted}`);
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(typeof init?.body).toBe('string');
  return JSON.parse(init!.body as string) as TitleCandidateCommandEnvelope;
}
function retained(input: TitleCandidateCommandEnvelope, status: 'accepted' | 'historical' = 'accepted') {
  return { status, receipt: input.receipt, digest: input.digest,
    record: JSON.stringify({ frame: input.titleCandidate.frame, proof: input.titleAdmission }) };
}

test('lost title acceptance acknowledgement looks up the exact original frame and proof without terminal fallback', async () => {
  const input = envelope(), original = structuredClone(input), fuseki = client();
  const query = spyOn(fuseki, 'query').mockImplementation(async () => { throw new Error('terminal absence must not be queried'); });
  restores.push(() => query.mockRestore());
  const sent: TitleCandidateCommandEnvelope[] = [], urls: string[] = [];
  let derivedWrites = 0; fuseki.attachTemplateIndexWriter(async () => { derivedWrites++; });
  fetchStub(async (url, init) => {
    urls.push(String(url)); sent.push(readBody(init));
    if (sent.length === 1) throw new TypeError('acceptance committed but its reply was lost');
    return Response.json(retained(input, 'historical'));
  });
  expect(await fuseki.commandTitleCandidate(input)).toEqual(retained(input, 'historical'));
  expect(sent).toEqual([original, { ...original, titleCandidate: { ...original.titleCandidate, mode: 'lookup' } }]);
  expect(input).toEqual(original);
  expect(urls).toEqual(['http://fuseki.invalid/rezics/command', 'http://fuseki.invalid/rezics/command']);
  expect(query).not.toHaveBeenCalled(); expect(derivedWrites).toBe(0);
});

test('an incomplete title reply has one exact history retry, including an already historical request', async () => {
  const input = envelope('lookup'); let calls = 0;
  const fetch = fetchStub(async (_url, init) => {
    expect(readBody(init)).toEqual(input);
    return ++calls === 1 ? new Response('{"status":"historical"', { headers: { 'content-type': 'application/json' } })
      : Response.json(retained(input, 'historical'));
  });
  expect(await client().commandTitleCandidate(input)).toEqual(retained(input, 'historical'));
  expect(fetch).toHaveBeenCalledTimes(2);
});

for (const [name, mutate] of [
  ['unknown envelope field', (value: Record<string, unknown>) => { value.ready = true; }],
  ['unknown candidate field', (value: Record<string, unknown>) => { (value.titleCandidate as Record<string, unknown>).ready = true; }],
  ['unknown proof field', (value: Record<string, unknown>) => { (value.titleAdmission as Record<string, unknown>).actor = 'caller'; }],
  ['nonempty update', (value: Record<string, unknown>) => { value.update = 'INSERT DATA {}'; }],
  ['nonempty outer validations', (value: Record<string, unknown>) => { value.validations = [{}]; }],
  ['different deadline', (value: Record<string, unknown>) => { value.deadlineMs = 10001; }],
  ['unknown mode', (value: Record<string, unknown>) => { (value.titleCandidate as Record<string, unknown>).mode = 'promote'; }],
  ['frame UTF-8 overflow', (value: Record<string, unknown>) => { (value.titleCandidate as Record<string, unknown>).frame = '東'.repeat(10923); }],
] as const) {
  test(`title transport refuses ${name} before HTTP`, async () => {
    const value = structuredClone(envelope()) as unknown as Record<string, unknown>; mutate(value);
    const fetch = fetchStub(async () => { throw new Error('invalid internal envelope must not dispatch'); });
    await expect(client().commandTitleCandidate(value as unknown as TitleCandidateCommandEnvelope)).rejects.toThrow('invalid Fuseki title candidate envelope');
    expect(fetch).not.toHaveBeenCalled();
  });
}

test('candidate transport requires admitted capability and does not substitute the maintenance token', async () => {
  const fetch = fetchStub(async () => { throw new Error('missing admitted authority must not dispatch'); });
  for (const token of ['', 'invalid'])
    await expect(client(token).commandTitleCandidate(envelope())).rejects.toThrow('Fuseki admitted command capability is required');
  expect(fetch).not.toHaveBeenCalled();
});
test('native capability refusal is definite and has no lookup retry', async () => {
  const fetch = fetchStub(async () => new Response('', { status: 403 }));
  await expect(client().commandTitleCandidate(envelope())).rejects.toBeInstanceOf(CommandForbidden);
  expect(fetch).toHaveBeenCalledTimes(1);
});

for (const [name, response] of [
  ['leaked internal changed', (input: TitleCandidateCommandEnvelope) => ({ ...retained(input), changed: false })],
  ['ordinary committed status', (input: TitleCandidateCommandEnvelope) => ({ status: 'committed', receipt: input.receipt })],
  ['wrong retained receipt', (input: TitleCandidateCommandEnvelope) => ({ ...retained(input), receipt: 'urn:rezics:receipt:other' })],
  ['wrong retained digest', (input: TitleCandidateCommandEnvelope) => ({ ...retained(input), digest: '0'.repeat(64) })],
  ['missing retained bytes', (input: TitleCandidateCommandEnvelope) => ({ ...retained(input), record: null })],
  ['unknown retained field', (input: TitleCandidateCommandEnvelope) => ({ ...retained(input), ready: true })],
  ['invalid terminal outcome', (input: TitleCandidateCommandEnvelope) => ({ status: 'terminal', receipt: input.receipt,
    digest: input.digest, outcome: 'accepted' })],
] as const) {
  test(`malformed ${name} cannot become terminal success or unbounded retry`, async () => {
    const input = envelope(), sent: TitleCandidateCommandEnvelope[] = [];
    const fetch = fetchStub(async (_url, init) => { sent.push(readBody(init)); return Response.json(response(input)); });
    await expect(client().commandTitleCandidate(input)).rejects.toBeInstanceOf(CommandOutcomeUnknown);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sent.map(value => value.titleCandidate.mode)).toEqual(['accept', 'lookup']);
    expect(sent.every(value => value.titleCandidate.frame === input.titleCandidate.frame
      && JSON.stringify(value.titleAdmission) === JSON.stringify(input.titleAdmission))).toBe(true);
  });
}

test('definite candidate conflict, deadline and original terminal outcomes bypass ordinary receipt reconciliation', async () => {
  const input = envelope(), fuseki = client();
  const query = spyOn(fuseki, 'query').mockImplementation(async () => { throw new Error('no terminal fallback'); });
  restores.push(() => query.mockRestore());
  const replies: TitleCandidateResult[] = [retained(input), { status: 'conflict', reason: 'stale captured basis' }, { status: 'deadline' },
    { status: 'terminal', receipt: input.receipt, digest: input.digest, outcome: 'cancelled' },
    { status: 'terminal', receipt: input.receipt, digest: input.digest, outcome: 'succeeded' }];
  let reply: TitleCandidateResult;
  const fetch = fetchStub(async (_url, init) => { expect(readBody(init)).toEqual(input); return Response.json(reply); });
  for (reply of replies) expect(await fuseki.commandTitleCandidate(input)).toEqual(reply);
  expect(fetch).toHaveBeenCalledTimes(replies.length); expect(query).not.toHaveBeenCalled();
});
