import { preparationFixture } from './realm-publication-preparation-fixture';
import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  createPublicationDraft,
  publicationSubjectSearch,
  type PublicationTarget,
} from '../src/community/publication-subject-picker';
import {
  changePublication,
  type PublicationChange,
  type PublicationOutcome,
} from '../src/community/publication-controls';
import type { SuggestionResult } from '../src/search/suggestions';
import type { HeaderSuggestionLoader } from '../src/search/header-search/suggestions';

const id = (n: number) => `01a1a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const disclosed: SuggestionResult = {
  subjects: [{ id: id(40), type: 'schema:Book', labels: { en: 'Disclosed book' }, summary: null }],
  types: { 'schema:Book': { en: 'Book' } },
  as_of: '2026-10-31T00:00:00Z',
};
function target(): PublicationTarget {
  return {
    id: id(40),
    title: 'Disclosed book',
    label: 'Disclosed book',
    labels: { en: 'Disclosed book' },
    types: ['schema:Book'],
    typeName: 'Book',
    cover: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('Realm curation chooses a real disclosed subject before native publish', async () => {
  const calls: { method: string; path: string; head: string | null; key: string | null; body: string }[] = [];
  let denied = false;
  const client = createKernelClient('https://kernel.example', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.headers.get('authorization')).toBe('Bearer curator');
        calls.push({
          method: request.method,
          path: new URL(request.url).pathname,
          head: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
          body: await request.text(),
        });
        return denied
          ? Response.json({ code: 'forbidden' }, { status: 403 })
          : Response.json({ publication: { publicationId: id(51), subjectId: id(40) } }, { status: 201 });
      },
      { preconnect() {} },
    ),
  });
  const load: HeaderSuggestionLoader = async (query, locale, signal, scope) => {
    expect({ query, locale, scope, aborted: signal.aborted }).toEqual({
      query: 'book',
      locale: 'en',
      scope: undefined,
      aborted: false,
    });
    return disclosed;
  };
  const [subject] = await publicationSubjectSearch('en', load)('book', new AbortController().signal);
  expect(subject).toMatchObject({ id: id(40), title: 'Disclosed book', typeLabel: 'Book', cover: null });
  let shelf = [{ ...target(), publicationId: id(50) }];
  const draft = createPublicationDraft(
    id(2),
    (input) => changePublication(client, 'Bearer curator', input),
    (_input, chosen, head) => {
      shelf = [{ ...chosen, publicationId: head }];
    },
    () => shelf,
    true,
    undefined,
    preparationFixture('curator', () => shelf[0]?.publicationId ?? null),
  );
  await draft.choose({ ...target(), id: subject!.id, title: subject!.title });
  expect(calls).toHaveLength(0);
  await draft.choose(null);
  await draft.change('publish');
  expect(calls).toHaveLength(0);
  await draft.choose(target());
  await draft.change('publish');
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    method: 'POST',
    path: `/v1/realms/${id(2)}/publications`,
    head: JSON.stringify(id(50)),
    body: JSON.stringify({ subjectId: id(40) }),
  });
  expect(draft.getSnapshot()).toMatchObject({
    target: { id: id(40), publicationId: id(51) },
    outcome: { kind: 'saved', head: id(51) },
  });
  // A Search disclosure never grants readability/publication; current native refusal clears the disclosed label.
  denied = true;
  await draft.inspect();
  await draft.change('publish');
  expect(draft.getSnapshot()).toMatchObject({ target: null, outcome: { kind: 'denied' } });
  expect(calls).toHaveLength(2);
  expect(
    await changePublication(client, null, {
      realmId: id(2),
      subjectId: id(40),
      action: 'publish',
      idempotencyKey: id(60),
    }),
  ).toEqual({ kind: 'denied' });
  expect(calls).toHaveLength(2);
});

test('uncertain commands retain subject, head, action and key; conflict recovery requires a new explicit decision', async () => {
  for (const action of ['publish', 'withdraw', 'reject'] as const) {
    const writes: PublicationChange[] = [];
    const first = deferred<PublicationOutcome>();
    let response: PublicationOutcome = { kind: 'conflict', currentHead: id(55) };
    let shelf = [{ ...target(), publicationId: id(50) }];
    const draft = createPublicationDraft(
      id(2),
      async (input) => {
        writes.push(input);
        return writes.length === 1 ? first.promise : response;
      },
      () => {},
      () => shelf,
      true,
      undefined,
      preparationFixture('curator', () => shelf[0]?.publicationId ?? null),
    );
    const selected = target();
    await draft.choose(selected);
    const pending = draft.change(action);
    await draft.choose(null);
    await draft.change('publish', { ...target(), id: id(41) });
    expect(writes).toHaveLength(1);
    selected.id = id(99);
    shelf = [{ ...target(), publicationId: id(54) }];
    first.resolve({ kind: 'unavailable' });
    await pending;
    await draft.choose(null);
    expect(draft.getSnapshot().target?.id).toBe(id(40));
    await draft.retry();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[1]).toMatchObject({ realmId: id(2), subjectId: id(40), action, expectedHead: id(50) });
    expect(writes).toHaveLength(2);
    response = { kind: 'saved', head: id(56) };
    shelf = [{ ...target(), publicationId: id(55) }];
    await draft.review();
    expect(writes).toHaveLength(2);
    await draft.change(action);
    expect(writes[2]).toMatchObject({ subjectId: id(40), action, expectedHead: id(55) });
    expect(writes[2]!.idempotencyKey).not.toBe(writes[1]!.idempotencyKey);
    await draft.retry();
    expect(writes).toHaveLength(3);
    // Explicit clearing also discards old recovery intent; it cannot queue a hidden write.
    await draft.choose(null);
    await draft.review();
    await draft.change(action);
    expect(writes).toHaveLength(3);
  }
});

test('Search failure, late queries and retired Realm or reader drafts cannot disclose or publish stale choices', async () => {
  const late = deferred<SuggestionResult>();
  let loads = 0;
  const search = publicationSubjectSearch('en', async () => {
    loads += 1;
    return late.promise;
  });
  const abort = new AbortController();
  const prior = search('prior', abort.signal);
  abort.abort();
  late.resolve(disclosed);
  await expect(prior).rejects.toThrow();
  expect(loads).toBe(1);
  const failed = publicationSubjectSearch('en', async () => {
    throw new Error('Search unavailable');
  });
  await expect(failed('book', new AbortController().signal)).rejects.toThrow('Search unavailable');
  expect(
    await publicationSubjectSearch('en', async () => ({ ...disclosed, subjects: [] }))(
      'none',
      new AbortController().signal,
    ),
  ).toEqual([]);
  const bounded = await publicationSubjectSearch('en', async () => ({
    ...disclosed,
    subjects: Array.from({ length: 20 }, () => disclosed.subjects[0]!),
  }))('book', new AbortController().signal);
  expect(bounded).toHaveLength(8);
  const reply = deferred<PublicationOutcome>();
  let writes = 0;
  let saved = 0;
  const draft = createPublicationDraft(
    id(2),
    async () => {
      writes += 1;
      return reply.promise;
    },
    () => {
      saved += 1;
    },
    () => [],
    true,
    undefined,
    preparationFixture('curator', () => null),
  );
  await draft.choose(target());
  const pending = draft.change('publish');
  draft.retire();
  reply.resolve({ kind: 'saved', head: id(51) });
  await pending;
  expect(saved).toBe(0);
  await draft.retry();
  await draft.review();
  await draft.change('publish');
  await draft.choose(target());
  expect(writes).toBe(1);
  const next = createPublicationDraft(
    id(3),
    async () => {
      writes += 1;
      return { kind: 'denied' };
    },
    () => {},
    () => [],
    true,
    undefined,
    preparationFixture('curator', () => null),
  );
  expect(next.getSnapshot().target).toBeNull();
  await next.change('publish');
  expect(writes).toBe(1);
});

test('retirement is irreversible and duplicate explicit actions cross transport once', async () => {
  const reply = deferred<PublicationOutcome>();
  let writes = 0;
  let saved = 0;
  const draft = createPublicationDraft(
    id(2),
    async () => {
      writes += 1;
      return reply.promise;
    },
    () => {
      saved += 1;
    },
    () => [],
    true,
    undefined,
    preparationFixture('curator', () => null),
  );
  await draft.choose(target());
  const pending = draft.change('publish');
  await draft.change('publish');
  expect(writes).toBe(1);
  draft.retire();
  draft.activate();
  reply.resolve({ kind: 'saved', head: id(51) });
  await pending;
  await draft.change('publish');
  await draft.choose(target());
  expect(writes).toBe(1);
  expect(saved).toBe(0);
  expect(draft.getSnapshot()).toEqual({ target: null, outcome: null, busy: false });
});

test('a caller retired during the busy publication boundary never reaches transport', async () => {
  let valid = true;
  let writes = 0;
  const draft = createPublicationDraft(
    id(2),
    async () => {
      writes += 1;
      return { kind: 'saved', head: id(51) };
    },
    () => {},
    () => [],
    true,
    { current: () => valid },
    preparationFixture('curator', () => null),
  );
  await draft.choose(target());
  const unsubscribe = draft.subscribe(() => {
    if (draft.getSnapshot().busy) valid = false;
  });
  await draft.change('publish');
  unsubscribe();
  expect(writes).toBe(0);
  expect(draft.getSnapshot()).toEqual({ target: null, outcome: null, busy: false });
});
