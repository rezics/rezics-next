import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { candidateFixture } from '../src/kernel/fake/subject-candidates';
import {
  decideProviderCandidate,
  prepareProviderBatch,
  providerDecisionInput,
  providerFailure,
  providerRowKey,
  providerScopeKey,
  providerSelectionInScope,
  readProviderDecisionSubjects,
  runProviderBatch,
  type ProviderDecision,
  type ProviderDecisionResult,
} from '../src/features/import-review/provider-review-actions';
import { readProviderQueue } from '../src/features/import-review/provider-queue';

function visible() {
  const fixture = candidateFixture();
  const scope = { source: 'wikidata', context: fixture.publicRead.subject.context, status: 'unreviewed' };
  const rows = Array.from({ length: 5 }, (_, index) => ({
    subject: fixture.id,
    label: 'The Little Prince',
    propertyLabel: 'Publication date',
    href: '/en/subjects/example',
    related: fixture.publicRead.related,
    candidate: {
      ...structuredClone(fixture.candidate),
      id: `${fixture.id.slice(0, -3)}9${String(index).padStart(2, '0')}`,
      head: index ? index + 3 : null,
    },
  }));
  return { fixture, scope, rows };
}

test('Accept or reject an explicit visible queue selection with honest partial results through the declared native contract with truthful authority and failure states', async () => {
  const { scope, rows } = visible();
  const failures = ['stale', 'denied', 'rate-limited', 'unavailable'] as const;
  const sealed = prepareProviderBatch(
    scope,
    rows,
    rows.map(providerRowKey),
    'accept',
    () => crypto.randomUUID(),
    'original-session',
  )!;
  const calls: ProviderDecision[] = [];
  let first = true;
  const confirm = async (command: ProviderDecision): Promise<ProviderDecisionResult> => {
    calls.push(structuredClone(command));
    const index = sealed.attempts.findIndex((attempt) => attempt.command.key === command.key);
    return first && index > 0 ? { ok: false, reason: failures[index - 1]! } : { ok: true, kind: 'accepted' };
  };
  const partial = await runProviderBatch(sealed, confirm);
  expect(partial.attempts.map((attempt) => attempt.result)).toEqual([
    { ok: true, kind: 'accepted' },
    ...failures.map((reason) => ({ ok: false, reason })),
  ]);
  expect(partial.attempts.map((attempt) => attempt.command.head)).toEqual([null, 4, 5, 6, 7]);
  first = false;
  rows.forEach((row) => {
    row.candidate.head = 99;
  });
  const retried = await runProviderBatch(partial, confirm);
  expect(calls.slice(5)).toEqual(calls.slice(1, 5));
  expect(calls.filter((command) => command.key === sealed.attempts[0]!.command.key)).toHaveLength(1);
  expect(new Set(calls.slice(0, 5).map((command) => command.key)).size).toBe(5);
  expect(retried.attempts.every((attempt) => attempt.result?.ok)).toBe(true);
  const rejected = prepareProviderBatch(scope, rows, [providerRowKey(rows[2]!)], 'reject')!;
  expect((await runProviderBatch(rejected, async () => ({ ok: true, kind: 'rejected' }))).attempts[0]?.result).toEqual({
    ok: true,
    kind: 'rejected',
  });
});

test('selection clears on source, Context or status changes; unloaded and oversized selections cannot be sealed', () => {
  const { scope, rows } = visible();
  const selection = { scope: providerScopeKey(scope), ids: [providerRowKey(rows[0]!)] };
  expect(providerSelectionInScope(selection, providerScopeKey(scope))).toEqual(selection.ids);
  for (const changed of [
    { ...scope, source: 'vndb' },
    { ...scope, context: rows[0]!.subject },
    { ...scope, status: 'accepted' },
  ])
    expect(providerSelectionInScope(selection, providerScopeKey(changed))).toEqual([]);
  expect(prepareProviderBatch(scope, rows.slice(1), selection.ids, 'accept')).toBeNull();
  expect(prepareProviderBatch(scope, rows, [], 'accept')).toBeNull();
  expect(
    prepareProviderBatch(
      scope,
      rows,
      Array.from({ length: 21 }, (_, index) => String(index)),
      'accept',
    ),
  ).toBeNull();
  rows[0]!.candidate.retracted = 4;
  expect(prepareProviderBatch(scope, rows, selection.ids, 'reject')).toBeNull();
});

test('generated native decisions forward the current viewer, exact Context/head/key and session without adoption or deletion', async () => {
  const { scope, rows } = visible();
  const observed: { path: string; headers: Headers; body: unknown }[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = (await request.json()) as { context: string };
      const path = new URL(request.url).pathname;
      observed.push({ path, headers: request.headers, body });
      return new Response(
        JSON.stringify({
          acceptance: {
            context: body.context,
            candidate: rows[0]!.candidate.id,
            decision: path.endsWith(':accept') ? 'accept' : 'reject',
            head: 8,
          },
          revision: 9,
        }),
        { headers: { 'content-type': 'application/json', 'rezics-session-token': 'after-write' } },
      );
    }) as typeof fetch,
  });
  for (const operation of ['accept', 'reject'] as const) {
    const command = prepareProviderBatch(
      { ...scope, context: rows[1]!.subject },
      rows,
      [providerRowKey(rows[0]!)],
      operation,
      () => crypto.randomUUID(),
      'before-write',
    )!.attempts[0]!.command;
    expect(providerDecisionInput(command)).toEqual(command);
    expect(await decideProviderCandidate(client, 'Bearer current-viewer', command)).toEqual({
      ok: true,
      kind: operation === 'accept' ? 'accepted' : 'rejected',
      session: 'after-write',
    });
    const request = observed.at(-1)!;
    expect(request.path).toBe(`/v1/subjects/${command.subject}/candidates/${command.candidate}:${operation}`);
    expect(request.body).toEqual({ context: command.context, expected_head: null });
    expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(request.headers.get('idempotency-key')).toBe(command.key);
    expect(request.headers.get('rezics-session-token')).toBe('before-write');
  }
  expect(observed).toHaveLength(2);
});

test('an unserved queue, lost response, current denial and concealed suggestion remain failures', async () => {
  expect(await readProviderQueue()).toEqual({ ok: false, reason: 'unavailable' });
  expect(providerFailure(404)).toEqual({ ok: false, reason: 'missing' });
  expect(providerFailure(429, { 'retry-after': '12' })).toEqual({
    ok: false,
    reason: 'rate-limited',
    retryAfter: '12',
  });
  expect(providerFailure(422)).toEqual({ ok: false, reason: 'key-conflict' });
  const { scope, rows } = visible();
  const batch = prepareProviderBatch(scope, rows, [providerRowKey(rows[0]!)], 'accept')!;
  const lost = await runProviderBatch(batch, async () => {
    throw new Error('Response lost');
  });
  expect(lost.attempts[0]?.result).toEqual({ ok: false, reason: 'unavailable' });
  expect(lost.attempts[0]?.command).toEqual(batch.attempts[0]?.command);
  const deniedClient = createKernelClient('https://kernel.test', {
    fetch: (async () =>
      new Response(JSON.stringify({ code: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
  });
  expect(await decideProviderCandidate(deniedClient, 'Bearer revoked-viewer', batch.attempts[0]!.command)).toEqual({
    ok: false,
    reason: 'denied',
  });
  expect(() => providerDecisionInput({ ...batch.attempts[0]!.command, operation: 'adopt' })).toThrow();
});

test('current subject readings refresh independently in parallel with exact identities and no per-field reads', async () => {
  const { scope, rows, fixture } = visible();
  const commands = prepareProviderBatch(scope, rows, rows.slice(0, 2).map(providerRowKey), 'accept')!.attempts.map(
    (attempt) => attempt.command,
  );
  commands[1] = { ...commands[1]!, subject: rows[1]!.candidate.id };
  const requests: Request[] = [];
  const releases: (() => void)[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      await new Promise<void>((resolve) => releases.push(resolve));
      const current = structuredClone(fixture.publicRead);
      current.subject.id = new URL(request.url).pathname.split('/').at(-1)!;
      return new Response(JSON.stringify(current), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const reading = readProviderDecisionSubjects(client, 'Bearer current-viewer', commands);
  for (let turn = 0; turn < 20 && releases.length < 2; turn++) await Promise.resolve();
  expect(requests).toHaveLength(2);
  releases.forEach((release) => release());
  expect((await reading).every((entry) => entry.result.ok)).toBe(true);
  expect(
    requests.every(
      (request) =>
        request.headers.get('authorization') === 'Bearer current-viewer' &&
        new URL(request.url).searchParams.get('context') === scope.context,
    ),
  ).toBe(true);
});

// Additional immutable-custody acceptance; authored UNRUN for the connected Web delivery.
test('unknown-write failed reread retains original intent and native confirmed successes cannot be resubmitted', async () => {
  const { scope, rows } = visible();
  const batch = prepareProviderBatch(
    scope,
    rows,
    rows.slice(0, 2).map(providerRowKey),
    'reject',
    () => crypto.randomUUID(),
    'original-native-session',
  )!;
  const original = structuredClone(batch);
  const calls: ProviderDecision[] = [];
  const partial = await runProviderBatch(batch, async (command) => {
    calls.push(structuredClone(command));
    return calls.length === 1 ? { ok: true, kind: 'rejected' } : { ok: false, reason: 'unavailable' };
  });
  const deniedClient = createKernelClient('https://denied.test', {
    fetch: async () => Response.json({ code: 'unavailable' }, { status: 503 }),
  });
  const reread = await readProviderDecisionSubjects(
    deniedClient,
    'Bearer original',
    partial.attempts.map((entry) => entry.command),
  );
  expect(reread.every((entry) => !entry.result.ok && entry.result.reason === 'unavailable')).toBe(true);
  expect(partial.attempts[1]!.result).toEqual({ ok: false, reason: 'unavailable' });
  expect(calls).toHaveLength(2);
  rows.forEach((row) => {
    row.candidate.head = 100;
    row.label = 'New display label';
  });
  const retried = await runProviderBatch(partial, async (command) => {
    calls.push(structuredClone(command));
    return { ok: true, kind: 'rejected' };
  });
  expect(calls).toHaveLength(3);
  expect(calls[2]).toEqual(original.attempts[1]!.command);
  expect(retried.attempts[0]!.command).toEqual(original.attempts[0]!.command);
  expect(retried.attempts[1]!.command.session).toBe('original-native-session');
});

test('fresh decisions require native operations independently of queue eligibility; sealed retries retain their operands', async () => {
  const { scope, rows } = visible();
  const row = { ...rows[0]!, operations: [] as string[] };
  const selected = [providerRowKey(row)];
  expect(prepareProviderBatch(scope, [row], selected, 'accept')).toBeNull();
  expect(prepareProviderBatch(scope, [row], selected, 'reject')).toBeNull();
  row.operations = ['subject.accept_candidate'];
  const sealed = prepareProviderBatch(scope, [row], selected, 'accept')!;
  expect(sealed.attempts).toHaveLength(1);
  expect(prepareProviderBatch(scope, [row], selected, 'reject')).toBeNull();
  const unknown = await runProviderBatch(sealed, async () => ({ ok: false, reason: 'unavailable' }));
  row.operations = [];
  row.candidate.head = 99;
  const retried: ProviderDecision[] = [];
  await runProviderBatch(unknown, async (command) => {
    retried.push(command);
    return { ok: false, reason: 'denied' };
  });
  expect(retried).toEqual(sealed.attempts.map(({ command }) => command));
  expect(prepareProviderBatch(scope, [row], selected, 'accept')).toBeNull();
});

test('a malformed native acknowledgment remains uncertain and retries the identical command', async () => {
  const { scope, rows } = visible();
  const batch = prepareProviderBatch(scope, rows, [providerRowKey(rows[0]!)], 'accept')!;
  const received: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input) => {
      const request = input as Request;
      received.push(JSON.stringify([await request.json(), request.headers.get('idempotency-key')]));
      return Response.json({
        acceptance: { context: scope.context, candidate: rows[0]!.candidate.id, decision: 'accept' },
      });
    },
  });
  const confirm = (command: ProviderDecision) => decideProviderCandidate(client, 'Bearer current', command);
  const uncertain = await runProviderBatch(batch, confirm);
  expect(uncertain.attempts[0]!.result).toEqual({ ok: false, reason: 'unavailable' });
  await runProviderBatch(uncertain, confirm);
  expect(received).toHaveLength(2);
  expect(received[0]).toBe(received[1]);
});
