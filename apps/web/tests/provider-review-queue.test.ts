import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderQueue } from '../src/features/import-review/provider-queue-view';
import {
  decideProviderCandidate,
  validQueueDecision,
  validQueueScope,
} from '../src/features/import-review/provider-queue';
import { providerQueueFixture } from '../src/kernel/fake/provider-review-queue';
import { m } from '../src/paraglide/messages.js';

test('preparation, bounded continuation, truthful empty and denial remain distinct visible outcomes', async () => {
  for (const [scenario, text] of [
    ['preparing', m.prq_preparing()],
    ['empty', m.prq_empty()],
    ['denied', m.prq_denied()],
    ['unavailable', m.prq_unavailable()],
  ] as const) {
    const fixture = providerQueueFixture(scenario);
    const markup = renderToStaticMarkup(
      createElement(ProviderQueue, {
        transport: fixture.transport,
        initial: fixture.initial,
        initialScope: fixture.scope,
      }),
    );
    expect(markup).toContain(text);
    expect(markup).toMatch(/<h2\b[^>]*data-content-item-slot="title"[^>]*>/);
    expect(markup).not.toContain(fixture.native.candidate.id);
  }
  const fixture = providerQueueFixture('preparing');
  expect(await fixture.transport.read(fixture.scope)).toEqual({ state: 'preparing', next: 'opaque-continuation' });
  expect((await fixture.transport.read(fixture.scope, 'opaque-continuation')).state).toBe('ready');
  expect(fixture.calls.some((call) => call.path.includes('cursor=opaque-continuation'))).toBe(true);
});

test('generated native calls retain exact Context, head, session and retry key without adopting', async () => {
  const fixture = providerQueueFixture();
  const command = {
    ...fixture.scope,
    context: '019a1b2c-3d4e-7000-8000-001000000001',
    subject: fixture.native.id,
    candidate: fixture.native.candidate.id,
    operation: 'accept' as const,
    head: 7,
    key: crypto.randomUUID(),
    session: 'observed-session',
  };
  expect(validQueueDecision(command)).toBe(true);
  await decideProviderCandidate(fixture.client, 'Bearer reviewer', command);
  await decideProviderCandidate(fixture.client, 'Bearer reviewer', command);
  expect(fixture.calls.map((call) => call.body)).toEqual([
    { context: command.context, expected_head: 7 },
    { context: command.context, expected_head: 7 },
  ]);
  expect(
    fixture.calls.every(
      (call) =>
        call.path.endsWith(':accept') &&
        call.authorization === 'Bearer reviewer' &&
        call.session === 'observed-session',
    ),
  ).toBe(true);
  expect(fixture.calls.map((call) => call.key)).toEqual([JSON.stringify(command.key), JSON.stringify(command.key)]);
  expect(validQueueScope({ ...fixture.scope, source: 'Bad Provider' })).toBe(false);
  expect(validQueueScope({ ...fixture.scope, extra: true })).toBe(false);
  expect(validQueueDecision({ ...command, operation: 'adopt' })).toBe(false);
});

test('A filtered queue with only deleted rows and a real next cursor shows preparing continuation rather than exhausted empty', async () => {
  const fixture = providerQueueFixture('deleted-more');
  const native = await fixture.client['review-candidates'].get({
    query: { ...fixture.scope, limit: 20 },
    headers: { authorization: 'Bearer fixture' },
  });
  expect(native.status).toBe(200);
  expect(native.data).toMatchObject({
    candidates: [fixture.deleted],
    next: fixture.next,
    freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
  });
  expect(fixture.deleted.candidate).toEqual({ id: fixture.deleted.candidate.id, deleted: true });
  fixture.calls.length = 0;

  const read = await fixture.transport.read(fixture.scope, undefined, 'prepared-session');
  expect(read).toEqual({ state: 'preparing', next: fixture.next });
  const html = renderToStaticMarkup(
    createElement(ProviderQueue, { transport: fixture.transport, initial: read, initialScope: fixture.scope }),
  );
  expect(html).toContain(m.prq_preparing());
  expect(html).toMatch(/<h2\b[^>]*data-content-item-slot="title"[^>]*>/);
  expect(html).toContain(m.prq_continue());
  expect(html).not.toContain(m.prq_empty());
  expect(html).not.toContain(fixture.deleted.candidate.id);
  expect(html).not.toContain(fixture.native.candidate.id);
  expect(fixture.calls).toHaveLength(2); // The bounded page plus the existing Context definitions read.
  expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
  if (read.state !== 'preparing') throw new Error('Expected explicit continuation');
  const continued = await fixture.transport.read(fixture.scope, read.next, 'prepared-session');
  expect(continued.state === 'ready' && continued.page.candidates.map((row) => row.candidate.id)).toEqual([
    fixture.native.candidate.id,
  ]);
  const pages = fixture.calls.filter((call) => call.path.startsWith('/v1/review-candidates?'));
  expect(pages).toHaveLength(2);
  expect(pages.every((call) => call.authorization === 'Bearer fixture' && call.session === 'prepared-session')).toBe(
    true,
  );
  const query = new URL(pages[1]!.path, 'https://queue.test').searchParams;
  expect(Object.fromEntries(query)).toEqual({ ...fixture.scope, limit: '20', cursor: fixture.next });
  expect(fixture.calls).toHaveLength(5);
  const subjectRead = fixture.calls[4]!;
  expect(subjectRead).toMatchObject({
    method: 'GET',
    authorization: 'Bearer fixture',
    session: 'queue-session',
    key: null,
  });
  const subjectUrl = new URL(subjectRead.path, 'https://queue.test');
  expect(subjectUrl.pathname).toBe(`/v1/subjects/${fixture.native.id}`);
  expect(Object.fromEntries(subjectUrl.searchParams)).toEqual({ context: fixture.scope.context });
  expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
});

test('Mixed pages retain readable decisions while exhausted deleted pages stay empty and inconsistent native empty pages fail closed', async () => {
  for (const status of ['pending', 'accepted_unselected'] as const) {
    const fixture = providerQueueFixture('mixed');
    const read = await fixture.transport.read({ ...fixture.scope, status });
    if (read.state !== 'ready') throw new Error('Expected the useful mixed page');
    expect(read.page.candidates).toEqual([
      {
        subject: fixture.native.id,
        candidate: {
          ...fixture.native.candidate,
          ...(status === 'accepted_unselected' ? { decision: 'accepted', head: 1 } : {}),
        },
        adoption: null,
      },
    ]);
    expect(read.page.next).toBe(fixture.next);
    expect(read.page.freshness).toEqual({ consistency: 'eventual', target_seconds: 10, caught_up: true });
    expect(read.session).toBe('queue-session');
    const html = renderToStaticMarkup(
      createElement(ProviderQueue, {
        transport: fixture.transport,
        initial: read,
        initialScope: { ...fixture.scope, status },
      }),
    );
    expect(html).toContain(`/subjects/${fixture.native.id}/`);
    expect(html).not.toContain(fixture.deleted.candidate.id);
    expect(html).not.toContain(m.prq_empty());
    expect(html).toContain(m.prq_continue());
  }
  for (const scenario of ['deleted', 'empty', 'empty-more', 'empty-lagging'] as const) {
    const fixture = providerQueueFixture(scenario);
    const read = await fixture.transport.read(fixture.scope);
    if (scenario === 'empty-more' || scenario === 'empty-lagging') {
      expect(read).toEqual({ state: 'unavailable' });
    } else {
      expect(read.state === 'ready' && read.page.candidates).toEqual([]);
      expect(read.state === 'ready' && read.page.next).toBeNull();
    }
    const html = renderToStaticMarkup(
      createElement(ProviderQueue, { transport: fixture.transport, initial: read, initialScope: fixture.scope }),
    );
    expect(html).toContain(
      scenario === 'empty-more' || scenario === 'empty-lagging' ? m.prq_unavailable() : m.prq_empty(),
    );
    expect(html).not.toContain(fixture.deleted.candidate.id);
    expect(html).not.toContain(fixture.native.candidate.id);
  }
});

// Authored UNRUN: these retain native bounds as unrelated fixture populations grow.
test('unrelated Contexts Subjects candidates and revisions do not enlarge the explicit queue or exact read neighbourhood', async () => {
  for (const scale of [0, 1000, 10000]) {
    const fixture = providerQueueFixture('comparison');
    for (const relation of Object.values(fixture.population))
      for (let index = 0; index < scale; index++) relation.push({ id: index });
    const read = await fixture.transport.read(fixture.scope, undefined, 'original-native-session');
    expect(read.state).toBe('ready');
    if (read.state !== 'ready') throw new Error('Expected bounded native page');
    expect(read.page.candidates).toHaveLength(2);
    expect(read.readings).toHaveLength(1);
    expect(fixture.calls).toHaveLength(3); // Queue, Context terms, one distinct exact Subject/Context.
    expect(new URL(fixture.calls[0]!.path, 'https://queue.test').searchParams.get('limit')).toBe('20');
    expect(fixture.calls[2]!.session).toBe('queue-session');
  }
});

test('unavailable action hydration preserves comparisons but grants no fresh queue decisions', () => {
  const fixture = providerQueueFixture();
  if (fixture.initial.state !== 'ready') throw new Error('Expected page');
  const initial = structuredClone(fixture.initial);
  initial.page.actions = { state: 'unavailable' };
  const html = renderToStaticMarkup(
    createElement(ProviderQueue, {
      transport: fixture.transport,
      initial,
      initialScope: fixture.scope,
    }),
  );
  expect(html).toContain(m.prq_actions_unavailable());
  expect(html).toContain(fixture.native.publicRead.subject.labels.en!);
  expect(html).toMatch(/<[^>]+(?=[^>]*role="checkbox")(?=[^>]*disabled)[^>]+>/);
  expect(html).not.toContain(m.prq_selection_not_allowed());
});
