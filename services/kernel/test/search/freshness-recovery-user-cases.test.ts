import { afterAll, beforeAll, expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { parseText } from '../../src/search/text.ts';
import {
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import type { ReleasedNativeBoundRequest } from './support/released-discovery-runtime.ts';

import assert from 'node:assert/strict';
import { PROFILE_FORMAT, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionView, DynamicCollectionView } from '../../../../specs/dynamic-collections-driver.ts';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerOperations } from '../../src/search/public-filter-consumer-contract.ts';
import { KERNEL_WORK_MODULES } from '../../src/work/modules.ts';
import {
  createReleasedLibraryPopulation,
  type EntryHandle,
  type ReleasedLibraryPopulation,
} from '../library/support/released-library-population.ts';
import { discoveryKey, discoveryStatement, type DiscoveryPersona } from '../support/released-discovery.ts';

let population: ReleasedLibraryPopulation;
beforeAll(async () => {
  population = await createReleasedLibraryPopulation({ version: 1, search: 'native' });
  fixture = population.base;
  await population.base.setup.openFeatures(['search', 'search_advanced', 'personal_library']);
  witness = await fixture.createSubject('schema:Book', timingMarker);
  await fixture.search!.converge([witness]);
}, 120_000);
afterAll(async () => {
  await population?.close();
}, 180_000);

const marker = (name: string) => `${name}${crypto.randomUUID().replaceAll('-', '')}`;
function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response;
}
function noCounts(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(['count', 'total', 'estimate']).not.toContain(key);
    noCounts(child);
  }
}
function readiness(response: HttpResponse) {
  status(response, 503);
  expect(['index_not_ready', 'semantic_not_ready']).toContain(String(response.body.code));
  expect(response.headers.get('retry-after')).toBe('1');
  for (const field of ['subjects', 'members', 'next', 'count', 'total'])
    expect(response.body).not.toHaveProperty(field);
}
function searchPage(response: HttpResponse, size: number) {
  status(response, 200);
  noCounts(response.body);
  assert(Array.isArray(response.body.subjects));
  assert(response.body.next === null || typeof response.body.next === 'string');
  const rows = response.body.subjects as { id: string }[];
  expect(rows.length).toBeLessThanOrEqual(size);
  if (response.body.next !== null) {
    expect(response.body.next.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(size);
  }
  for (const row of rows) assert(typeof row.id === 'string');
  return { ids: rows.map(({ id }) => id), next: response.body.next as string | null };
}
const words: FilterDocument = {
  and: [
    { type: { in: ['schema:Book'] } },
    { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } },
  ],
};

// Elapsed time measures the public outcome; it never supplies an owner timestamp or clock.
async function searchableWithin60Seconds(started: number, text: string, filter: FilterDocument, expected: string[]) {
  for (;;) {
    const response = await population.request('anonymous', 'POST', '/v1/subjects:search', {
      text,
      filter,
      sort: 'id',
      limit: 2,
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThanOrEqual(60_000);
    if (response.status === 200) {
      const page = searchPage(response, 2);
      if (JSON.stringify(page.ids) === JSON.stringify(expected)) {
        expect(page.next).toBeNull();
        return;
      }
    } else readiness(response);
    // The healthy-operation deadline includes every relay/preparation/search request and wait.
    assert(elapsed < 60_000, 'Committed catalogue edit was not searchable within 60 seconds');
    await Bun.sleep(Math.min(25, 60_000 - elapsed));
  }
}

test('healthy public word-count edit becomes filterable within sixty seconds through the actual default worker', async () => {
  const text = marker('Wordfreshness');
  const subject = await population.base.createSubject('schema:Book', text);
  await population.base.catchUp([subject]);
  const before = searchPage(
    await population.request('anonymous', 'POST', '/v1/subjects:search', {
      text,
      filter: words,
      sort: 'id',
      limit: 2,
    }),
    2,
  );
  expect(before).toEqual({ ids: [], next: null });
  const started = performance.now();
  const committed = await population.base.adopt(
    subject,
    discoveryStatement(population.base.meaning.words, { amount: '+1200001', unit: '1' }),
  );
  expect(committed.subject).toBe(subject.id);
  expect(committed.adoptionHead).toBeGreaterThan(0);
  await searchableWithin60Seconds(started, text, words, [subject.id]);
}, 120_000);

test('healthy public harem-tag edit becomes filterable within sixty seconds using the real released Concept', async () => {
  const { harem } = await population.base.classification();
  const text = marker('Tagfreshness');
  const subject = await population.base.createSubject('schema:Book', text);
  const filter: FilterDocument = {
    and: [{ type: { in: ['schema:Book'] } }, { statement: { property: 'schema:keywords', in: [harem.id] } }],
  };
  await population.base.catchUp([subject]);
  expect(
    searchPage(
      await population.request('anonymous', 'POST', '/v1/subjects:search', {
        text,
        filter,
        sort: 'id',
        limit: 2,
      }),
      2,
    ),
  ).toEqual({ ids: [], next: null });
  const started = performance.now();
  const committed = await population.base.adopt(subject, discoveryStatement('schema:keywords', harem.id));
  expect(committed.candidate.length).toBeGreaterThan(0);
  await searchableWithin60Seconds(started, text, filter, [subject.id]);
}, 120_000);

async function everything() {
  const response = status(
    await population.request(
      'alice',
      'GET',
      `/v1/collections?${new URLSearchParams({ curatorAccountId: population.base.personas.alice.accountId })}`,
    ),
    200,
  );
  assert(Array.isArray(response.body.collections));
  const collection = (response.body.collections as { id: string; builtin?: { kind: string } }[]).find(
    (value) => value.builtin?.kind === 'everything',
  );
  assert(collection, 'Native owner discovery must return the stable Everything identity');
  return collection.id;
}

function ownerPage(response: HttpResponse, expected: string[]) {
  if (response.status === 202) {
    expect(response.body).toEqual({ preparing: true });
    expect(response.headers.get('retry-after')).toBe('1');
    return false;
  }
  status(response, 200);
  noCounts(response.body);
  assert(Array.isArray(response.body.members));
  expect(response.body.members.map((row: { subjectId: string }) => row.subjectId)).toEqual([...expected].sort());
  expect(response.body.next).toBeNull();
  return true;
}

async function finishOwnerPage(id: string, expected: string[], first: HttpResponse) {
  const deadline = performance.now() + 60_000;
  let response = first;
  while (!ownerPage(response, expected)) {
    assert(performance.now() < deadline, 'Fixed committed owner input remained preparing');
    await Bun.sleep(25);
    response = await population.request('alice', 'GET', `/v1/collections/${id}/members?sort=id&limit=100`);
  }
}

test('Alice committed state is reflected on her next OWN read without waiting for public indexing', async () => {
  const id = await everything();
  const state = await population.state();
  const read = status(await population.request('alice', 'GET', `/v1/libraryEntries/${state.subject.id}`), 200);
  expect(read.body.libraryEntry).toMatchObject({
    subjectId: state.subject.id,
    state: state.entry.state,
    revision: state.entry.revision,
  });
  // This is the first owner list read after commit. A stale successful empty list fails immediately.
  await finishOwnerPage(
    id,
    [state.subject.id],
    await population.request('alice', 'GET', `/v1/collections/${id}/members?sort=id&limit=100`),
  );
  for (const persona of ['anonymous', 'bob', 'outsider'] as const)
    status(await population.request(persona, 'GET', `/v1/collections/${id}/members`), 404);
}, 120_000);

test('Alice label-only support and its removal affect the next OWN read without fabricated state or another owner authority', async () => {
  const id = await everything();
  const state = await population.state();
  const subject = await population.base.createSubject('schema:Book', marker('Supportfreshness'));
  const created = status(
    await population.request('alice', 'POST', '/v1/libraryLabels', { name: 'Fresh support' }, discoveryKey()),
    201,
  );
  const label = created.body.label as { id: string };
  assert(typeof label.id === 'string');
  const assigned = status(
    await population.request(
      'alice',
      'POST',
      `/v1/libraryLabels/${label.id}:assign`,
      { subjectId: subject.id },
      discoveryKey(),
    ),
    200,
  );
  const assignment = assigned.body.assignment as { id: string; revision: number };
  await finishOwnerPage(
    id,
    [state.subject.id, subject.id],
    await population.request('alice', 'GET', `/v1/collections/${id}/members?sort=id&limit=100`),
  );
  const removed = status(
    await population.request(
      'alice',
      'POST',
      `/v1/libraryLabels/${label.id}:unassign`,
      { subjectId: subject.id, assignmentId: assignment.id, revision: assignment.revision },
      discoveryKey(),
    ),
    200,
  );
  expect(removed.body).toEqual({ deleted: true });
  await finishOwnerPage(
    id,
    [state.subject.id],
    await population.request('alice', 'GET', `/v1/collections/${id}/members?sort=id&limit=100`),
  );
  const entry = await population.request('alice', 'GET', `/v1/libraryEntries/${subject.id}`);
  status(entry, 404);
  expect(entry.body).not.toHaveProperty('libraryEntry');
  status(await population.request('bob', 'GET', `/v1/collections/${id}/members`), 404);
}, 120_000);

test('finite sparse native catalogue input yields full deep pages and genuine exhaustion without duplicate IDs or cursor loops', async () => {
  const text = marker('Sparsefreshness');
  const subjects = [];
  const matches: string[] = [];
  for (let index = 0; index < 71; index++) {
    const subject = await population.base.createSubject('schema:Book', `${text} ${String(index).padStart(3, '0')}`);
    subjects.push(subject);
    if (index >= 64) {
      await population.base.adopt(
        subject,
        discoveryStatement(population.base.meaning.words, { amount: '+1200001', unit: '1' }),
      );
      matches.push(subject.id);
    }
  }
  await population.base.catchUp(subjects);
  const ids: string[] = [];
  const cursors = new Set<string>();
  const deadline = performance.now() + 60_000;
  let cursor: string | undefined;
  for (;;) {
    assert(performance.now() <= deadline, 'Fixed finite sparse native input remained preparing');
    const response = await population.request('anonymous', 'POST', '/v1/subjects:search', {
      text,
      filter: words,
      sort: 'name',
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    if (response.status !== 200) {
      readiness(response);
      await Bun.sleep(25);
      continue;
    }
    const page = searchPage(response, 2);
    ids.push(...page.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeLessThanOrEqual(matches.length);
    expect(ids).toEqual(matches.slice(0, ids.length));
    if (page.next === null) {
      expect(ids).toEqual(matches);
      expect(page.ids).toHaveLength(1);
      break;
    }
    expect(cursors.has(page.next)).toBe(false);
    cursors.add(page.next);
    expect(cursors.size).toBeLessThanOrEqual(3);
    cursor = page.next;
  }
}, 180_000);

test('privacy reduction has no ordinary freshness grace for positive negative ordered and continued native queries', async () => {
  const text = marker('Privacyfreshness');
  const { harem } = await population.base.classification();
  const subjects = [];
  for (let index = 0; index < 3; index++) {
    const subject = await population.base.createSubject('schema:Book', `${text} ${index}`);
    await population.base.adopt(subject, discoveryStatement('schema:keywords', harem.id));
    subjects.push(subject);
  }
  await population.base.catchUp(subjects);
  const positive: FilterDocument = { statement: { property: 'schema:keywords', in: [harem.id] } };
  const cursors = new Map<DiscoveryPersona, string>();
  for (const persona of ['anonymous', 'editor'] as const) {
    const first = searchPage(
      await population.request(persona, 'POST', '/v1/subjects:search', {
        text,
        filter: positive,
        sort: 'name',
        limit: 2,
      }),
      2,
    );
    expect(first.ids).toEqual(subjects.slice(0, 2).map(({ id }) => id));
    assert(first.next !== null);
    cursors.set(persona, first.next);
  }
  await population.base.grant('editor', ['moderation:hide'], GLOBAL_CONTEXT);
  await population.base.search!.indexing('paused');
  try {
    status(
      await population.request(
        'editor',
        'POST',
        `/v1/subjects/${subjects[2]!.id}:hide`,
        { reason: 'Current disclosure control' },
        discoveryKey(),
      ),
      200,
    );
    status(await population.base.read(subjects[2]!), 404);
    for (const persona of ['anonymous', 'editor'] as const) {
      for (const query of [
        { filter: positive, sort: 'id' },
        { filter: { not: positive }, sort: 'id' },
        { filter: positive, sort: 'name' },
        { filter: positive, sort: 'name', cursor: cursors.get(persona)! },
      ])
        readiness(await population.request(persona, 'POST', '/v1/subjects:search', { text, limit: 2, ...query }));
    }
  } finally {
    await population.base.search!.indexing('running');
  }
  await searchableWithin60Seconds(
    performance.now(),
    text,
    positive,
    subjects
      .slice(0, 2)
      .map(({ id }) => id)
      .sort(),
  );
}, 120_000);

test('native suspended old bearer remains invalid credentials with invalid-token challenge on freshness consumers', async () => {
  const own = await everything();
  for (const [method, path, body] of [
    ['POST', '/v1/subjects:search', { filter: words, sort: 'id', limit: 2 }],
    ['GET', '/v1/subjects:suggest?q=Book', undefined],
    ['GET', `/v1/collections/${own}/members`, undefined],
    ['POST', '/v1/pages:read', { target: { route: '/' } }],
  ] as const) {
    const response = await population.request('suspended' satisfies DiscoveryPersona, method, path, body);
    status(response, 401);
    expect(response.body.code).toBe('invalid_credentials');
    expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    for (const field of ['subjects', 'members', 'reads', 'next']) expect(response.body).not.toHaveProperty(field);
  }
});

test('correct-password native suspended sign-in returns ACCOUNT_SUSPENDED without a new session or bearer', async () => {
  const response = status(await population.base.signIn('suspended'), 403);
  expect(response.body).toEqual({ error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' });
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.has('authorization')).toBe(false);
  for (const field of ['session', 'session_token', 'access_token', 'refresh_token'])
    expect(response.body).not.toHaveProperty(field);
  const oldBearer = status(
    await population.request('suspended', 'POST', '/v1/subjects:search', { filter: words, limit: 2 }),
    401,
  );
  expect(oldBearer.body.code).toBe('invalid_credentials');
  expect(oldBearer.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
});

test('public curated membership reflects a healthy released word edit within sixty seconds without replacing occurrence identity', async () => {
  const subject = await population.base.createSubject('schema:Book', marker('Curatedfreshness'));
  const created = status(
    await population.request(
      'alice',
      'POST',
      '/v1/collections',
      {
        title: marker('Freshnesscollection'),
        visibility: 'public',
      },
      discoveryKey(),
    ),
    201,
  );
  const collection = created.body.collection as CollectionView;
  const added = status(
    await population.request(
      'alice',
      'POST',
      `/v1/collections/${collection.id}/members`,
      {
        subjectId: subject.id,
        note: 'Retain this occurrence across the public fact edit',
      },
      discoveryKey(),
    ),
    201,
  );
  await population.base.catchUp([subject]);
  const path = `/v1/collections/${collection.id}/members?${new URLSearchParams({
    filter: JSON.stringify(words),
    sort: 'id',
    limit: '2',
  })}`;
  expect(ownerPage(await population.request('anonymous', 'GET', path), [])).toBe(true);
  const started = performance.now();
  await population.base.adopt(
    subject,
    discoveryStatement(population.base.meaning.words, { amount: '+1200001', unit: '1' }),
  );
  for (;;) {
    const response = await population.request('anonymous', 'GET', path);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThanOrEqual(60_000);
    if (response.status === 200) {
      noCounts(response.body);
      assert(Array.isArray(response.body.members));
      expect(response.body.next).toBeNull();
      if (response.body.members.length !== 0) {
        expect(response.body.members.map((member: { subjectId: string }) => member.subjectId)).toEqual([subject.id]);
        break;
      }
    } else if (response.status === 202) ownerPage(response, [subject.id]);
    else readiness(response);
    assert(elapsed < 60_000, 'Public curated fact edit exceeded the healthy freshness deadline');
    await Bun.sleep(Math.min(25, 60_000 - elapsed));
  }
  const editor = status(
    await population.request('alice', 'GET', `/v1/collections/${collection.id}/members?limit=100`),
    200,
  );
  expect(editor.body.members).toEqual([added.body.member]);
}, 120_000);

test('accepted-state filtered owner views reflect the next committed state or truthful preparation and conceal both views from Bob', async () => {
  const subject = await population.base.createSubject('schema:Book', marker('Stateviewfreshness'));
  await population.base.adopt(
    subject,
    discoveryStatement(population.base.meaning.words, { amount: '+1200001', unit: '1' }),
  );
  await population.base.catchUp([subject]);
  const { profile } = population.profile('schema:Book');
  const set = profile.entryStateSet;
  assert(set);
  const active = set.states.find((state) => state.role === 'active');
  const completed = set.states.find((state) => state.role === 'completed');
  assert(active && completed);
  const put = status(
    await population.request('alice', 'PUT', `/v1/libraryEntries/${subject.id}`, { state: active.id }, discoveryKey()),
    201,
  );
  const builtins = status(
    await population.request(
      'alice',
      'GET',
      `/v1/collections?${new URLSearchParams({
        curatorAccountId: population.base.personas.alice.accountId,
        limit: '100',
      })}`,
    ),
    200,
  );
  expect(builtins.body.next).toBeNull();
  assert(Array.isArray(builtins.body.collections));
  const views = [active, completed].map((state) => {
    const matches = (builtins.body.collections as CollectionView[]).filter(
      (row): row is DynamicCollectionView =>
        row.membershipKind === 'dynamic' &&
        row.builtin?.kind === 'state' &&
        row.builtin.profileId === profile.id &&
        row.builtin.stateSetId === set.id &&
        row.builtin.stateId === state.id,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.visibility).toBe('private');
    return matches[0]!;
  });
  const filter: FilterDocument = {
    and: [words, { statement: { property: 'schema:wordCount', range: { lte: 1200001, unit: '1' } } }],
  };
  const path = (id: string) =>
    `/v1/collections/${id}/members?${new URLSearchParams({ filter: JSON.stringify(filter), sort: 'id', limit: '100' })}`;
  // The state population contains another Book, but it has no matching released
  // word count. Native filtering, rather than an invented owner inventory, selects this one.
  const settle = async (id: string, expected: string[]) => {
    const deadline = performance.now() + 60_000;
    let response = await population.request('alice', 'GET', path(id));
    while (!ownerPage(response, expected)) {
      assert(performance.now() < deadline, 'Accepted-state owner view remained preparing');
      await Bun.sleep(25);
      response = await population.request('alice', 'GET', path(id));
    }
  };
  await settle(views[0]!.id, [subject.id]);
  await settle(views[1]!.id, []);
  await population.base.search!.indexing('paused');
  try {
    status(
      await population.request(
        'alice',
        'PUT',
        `/v1/libraryEntries/${subject.id}`,
        {
          state: completed.id,
          revision: (put.body.libraryEntry as EntryHandle).revision,
        },
        discoveryKey(),
      ),
      200,
    );
    // Each first read is checked immediately: a stale 200 is never given lag grace.
    await settle(views[0]!.id, []);
    await settle(views[1]!.id, [subject.id]);
    for (const view of views) {
      const denied = status(await population.request('bob', 'GET', path(view.id)), 404);
      for (const field of ['members', 'next', 'count', 'total']) expect(denied.body).not.toHaveProperty(field);
    }
  } finally {
    await population.base.search!.indexing('running');
  }
}, 120_000);

test('configured TypeList uses the native search consumer and exposes a healthy released tag edit within sixty seconds', async () => {
  const { harem } = await population.base.classification();
  const subject = await population.base.createSubject('schema:Book', marker('TypeListfreshness'));
  // A separate actual Concept keeps this page population fixed without adding a
  // query-only field to the configured TypeList transport.
  const tag = await population.base.createSubject('skos:Concept', marker('Freshnesspagetag'));
  await population.base.adopt(subject, discoveryStatement('schema:keywords', tag.id));
  await population.base.catchUp([subject, tag]);
  const filter: FilterDocument = {
    and: [
      { statement: { property: 'schema:keywords', in: [tag.id] } },
      { statement: { property: 'schema:keywords', in: [harem.id] } },
    ],
  };
  const document: CompositionDocument = {
    root: { props: {} },
    content: [
      {
        type: 'TypeList',
        props: {
          id: 'freshness-books',
          title: { en: 'Freshness books' },
          types: ['schema:Book'],
          filter,
          sort: 'id',
          limit: 2,
        },
      },
    ],
  };
  await population.base.grant('steward', ['presentation:publish', 'presentation:activate'], GLOBAL_CONTEXT);
  const published = status(
    await population.request(
      'steward',
      'POST',
      '/v1/presentation/profiles',
      {
        profile: {
          format: PROFILE_FORMAT,
          generic: document,
          bases: [],
          types: [],
          routes: [],
        },
      },
      discoveryKey(),
    ),
    201,
  );
  const active = status(await population.request('anonymous', 'GET', '/v1/presentation/active'), 200);
  status(
    await population.request(
      'steward',
      'POST',
      `/v1/presentation/profiles/${published.body.digest}:activate`,
      {
        expected_head: active.body.head,
      },
      discoveryKey(),
    ),
    200,
  );
  const plan = planReads(platformRegistry, document, { subject: null });
  const readKey = plan.nodes['freshness-books'];
  assert(readKey);
  expect(Object.keys(plan.reads)).toEqual([readKey]);
  const read = async () => {
    const response = status(
      await population.request('anonymous', 'POST', '/v1/pages:read', {
        target: { route: '/freshness-books' },
      }),
      200,
    );
    expect(response.body.profile).toBe(published.body.digest);
    expect(response.body.document).toEqual(document);
    assert(response.body.reads !== null && typeof response.body.reads === 'object');
    expect(Object.keys(response.body.reads)).toEqual([readKey]);
    const reads = response.body.reads as Record<string, { status: number; body: Record<string, unknown> }>;
    const result = reads[readKey];
    assert(result);
    return result;
  };
  const before = await read();
  expect(before.status, JSON.stringify(before.body)).toBe(200);
  expect(before.body.subjects).toEqual([]);
  expect(before.body.next).toBeNull();
  const started = performance.now();
  await population.base.adopt(subject, discoveryStatement('schema:keywords', harem.id));
  for (;;) {
    const result = await read();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThanOrEqual(60_000);
    noCounts(result.body);
    if (result.status === 200) {
      assert(Array.isArray(result.body.subjects));
      expect(result.body.next).toBeNull();
      if (result.body.subjects.length !== 0) {
        expect(result.body.subjects.map((row: { id: string }) => row.id)).toEqual([subject.id]);
        break;
      }
    } else {
      expect(result.status).toBe(503);
      expect(['index_not_ready', 'semantic_not_ready']).toContain(String(result.body.code));
      for (const field of ['subjects', 'next', 'count', 'total']) expect(result.body).not.toHaveProperty(field);
    }
    assert(elapsed < 60_000, 'Configured TypeList exceeded the healthy freshness deadline');
    await Bun.sleep(Math.min(25, 60_000 - elapsed));
  }
}, 120_000);

test('a native privacy reduction after the actual engine response blocks final HTTP disclosure without freshness grace', async () => {
  const native = population.base.search!;
  const text = marker('Finalprivacyfreshness');
  const { harem } = await population.base.classification();
  const subject = await population.base.createSubject('schema:Book', text);
  await population.base.adopt(subject, discoveryStatement('schema:keywords', harem.id));
  await population.base.catchUp([subject]);
  await population.base.grant('editor', ['moderation:hide'], GLOBAL_CONTEXT);
  await native.indexing('paused');
  // This is the real PIT transport path used by the native consumer, including
  // prepared-result materialization. The barrier changes only delivery timing.
  const barrier = native.barrier({ phase: 'response', method: 'POST', path: '/_search' });
  const pending = population.request('anonymous', 'POST', '/v1/subjects:search', {
    text,
    filter: { statement: { property: 'schema:keywords', in: [harem.id] } },
    sort: 'name',
    limit: 2,
  });
  // Observe both rejection and completion while waiting, so a missing native
  // Source fails as its actual response instead of hanging at an unused barrier.
  const completed = pending.then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
  try {
    const reached = await Promise.race([
      barrier.reached.then(() => true),
      completed.then((result) => {
        assert.fail(`Native HTTP search completed before engine response: ${JSON.stringify(result)}`);
      }),
    ]);
    expect(reached).toBe(true);
    status(
      await population.request(
        'editor',
        'POST',
        `/v1/subjects/${subject.id}:hide`,
        { reason: 'Reduction between engine execution and final disclosure' },
        discoveryKey(),
      ),
      200,
    );
    status(await population.base.read(subject), 404);
    barrier.release();
    readiness(await pending);
  } finally {
    barrier.release();
    await completed;
    await native.indexing('running');
  }
  await searchableWithin60Seconds(
    performance.now(),
    text,
    { statement: { property: 'schema:keywords', in: [harem.id] } },
    [],
  );
}, 120_000);

function preparationCost(cost: PublicFilterCost) {
  for (const value of Object.values(cost)) {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  expect(cost.inputKeys).toBeLessThanOrEqual(1000);
  expect(cost.candidates).toBeLessThanOrEqual(1000);
  expect(cost.resultWrites).toBeLessThanOrEqual(1000);
  expect(cost.frontierWrites).toBeLessThanOrEqual(1);
  expect(cost.engineSearches).toBeLessThanOrEqual(4);
  expect(cost.accessPoints + cost.dependencyPoints).toBeLessThanOrEqual(8 * cost.inputKeys);
}

test('SIGKILL preserves the same retained native prepared results consumed frontier ACK and finite continuation', async () => {
  const native = population.base.search!;
  expect(native.workerKind).toBe('owned-child');
  const text = marker('Restartfreshness');
  const subjects = [];
  for (let index = 0; index < 5; index++)
    subjects.push(await population.base.createSubject('schema:Book', `${text} ${index}`));
  await population.base.catchUp(subjects);
  const expected = subjects.map(({ id }) => id);
  const prefix = native.indexPrefix;
  const originalWorker = await native.workerStats();
  const modules = KERNEL_WORK_MODULES.map(({ name }) => name);
  expect(originalWorker.defaultModules).toEqual(modules);
  expect(originalWorker.registeredModules).toEqual(modules);
  for (const name of modules) expect(originalWorker.registrationCounts[name]).toBe(1);
  expect(originalWorker.stopped).toBe(false);

  await native.indexing('paused');
  let resumed: PublicFilterConsumerOperations | undefined;
  let operations: PublicFilterConsumerOperations | undefined;
  const context = () => ({ deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS) });
  try {
    const bound = await native.bindRequest(
      {
        plan: { filterDocument: undefined, text: parseText(text), sort: 'name', size: 2, pageSize: 2 },
        snapshot: 'prepared',
      },
      context(),
    );
    operations = bound.operations;
    // A required positive needs actual retained native output. Unavailability
    // cannot pass this case, nor can a diagnostic settled job stand in for it.
    expect(bound.capture.status).toBe('captured');
    assert(bound.capture.status === 'captured');
    preparationCost(bound.capture.cost);
    const captured = bound.capture;
    expect(captured.queried.snapshot.kind).toBe('prepared');
    const first = await bound.operations.query(captured.queried, context());
    expect(first.status).toBe('queried');
    assert(first.status === 'queried');
    expect(first.queried).toEqual(captured.queried);
    expect(first.result.hits.map(({ id }) => id)).toEqual(expected.slice(0, 2));
    expect(first.window).toEqual({ positions: [0, 1], examined: 2, exhausted: false });
    const beforeStatus = await bound.operations.readStatus(
      { queried: first.queried, execution: first.execution },
      context(),
    );
    expect(beforeStatus.status).toBe('observed');
    assert(beforeStatus.status === 'observed');
    expect(beforeStatus.pending).toEqual([]);
    expect(beforeStatus.changed).toEqual([]);
    expect(beforeStatus.blocking).toEqual([]);

    const retainedAt = Date.now();
    const id = await native.preparePublic(captured.repair);
    const retainedThrough = Date.now();
    expect(await native.preparePublic(captured.repair)).toBe(id);
    const preparation = await native.readPreparation(id);
    assert(preparation);
    expect(preparation.locator).toEqual({
      kind: 'repair',
      key: JSON.stringify(captured.repair),
      job: captured.repair,
    });
    expect(Number(preparation.expires_at)).toBeGreaterThanOrEqual(retainedAt + 24 * 60 * 60 * 1000);
    expect(Number(preparation.expires_at)).toBeLessThanOrEqual(retainedThrough + 24 * 60 * 60 * 1000);

    // Read only Search-owned retained bytes. Do not decode owner state, derive
    // a frontier from row counts, write SQL, or manufacture a queried locator.
    const retained = await population.base.inspect<{ consumer_work: string; consumer_window: string }>(
      `SELECT o.consumer_work, e.consumer_window
       FROM search.public_filter_observation o
       JOIN search.public_filter_execution e USING (partition_no, observation)
       WHERE o.observation = $1 AND e.id = $2`,
      [first.queried.snapshot.observation, first.execution],
    );
    expect(retained.rows).toHaveLength(1);
    expect(retained.rows[0]!.consumer_work.length).toBeGreaterThan(0);
    expect(retained.rows[0]!.consumer_window.length).toBeGreaterThan(0);
    expect(await native.crash()).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await native.readPreparation(id)).toEqual(preparation);
    const afterCrash = await population.base.inspect<{ consumer_work: string; consumer_window: string }>(
      `SELECT o.consumer_work, e.consumer_window
       FROM search.public_filter_observation o
       JOIN search.public_filter_execution e USING (partition_no, observation)
       WHERE o.observation = $1 AND e.id = $2`,
      [first.queried.snapshot.observation, first.execution],
    );
    expect(afterCrash.rows).toEqual(retained.rows);

    const restarted = await native.restart();
    expect(native.indexPrefix).toBe(prefix);
    expect(restarted.defaultModules).toEqual(modules);
    expect(restarted.registeredModules).toEqual(modules);
    for (const name of modules) expect(restarted.registrationCounts[name]).toBe(1);
    expect(restarted.searchStarterInvocations).toBe(1);
    expect(restarted.stopped).toBe(false);
    // Reopen only the actual queried observation. No bind/capture/rebuild is
    // permitted after the crash, and the first consumed execution is retained.
    resumed = await native.resumeRequest(first.queried, context());
    const afterStatus = await resumed.readStatus({ queried: first.queried, execution: first.execution }, context());
    expect(afterStatus.status).toBe('observed');
    assert(afterStatus.status === 'observed');
    expect(afterStatus.covered).toEqual(beforeStatus.covered);
    expect(afterStatus.pending).toEqual([]);
    expect(afterStatus.changed).toEqual([]);
    expect(afterStatus.blocking).toEqual([]);

    let previous = first;
    const ids = first.result.hits.map(({ id }) => id);
    const executions = new Set([first.execution]);
    const deadline = performance.now() + 60_000;
    for (const length of [2, 1]) {
      assert(performance.now() < deadline, 'Same retained finite native preparation did not finish');
      const page = await resumed.query(first.queried, context(), {
        execution: previous.execution,
        consumed: previous.window.examined,
        size: 2,
      });
      expect(page.status).toBe('queried');
      assert(page.status === 'queried');
      expect(page.queried).toEqual(first.queried);
      expect(page.result.hits).toHaveLength(length);
      expect(page.window.examined).toBe(length);
      expect(page.window.exhausted).toBe(length === 1);
      expect(page.cost.candidates).toBeLessThanOrEqual(2);
      expect(page.cost.engineSearches).toBe(0);
      expect(page.cost.resultWrites).toBe(0);
      expect(executions.has(page.execution)).toBe(false);
      executions.add(page.execution);
      const observed = await resumed.readStatus({ queried: page.queried, execution: page.execution }, context());
      expect(observed.status).toBe('observed');
      assert(observed.status === 'observed');
      expect(observed.covered).toEqual(beforeStatus.covered);
      expect(observed.pending).toEqual([]);
      expect(observed.changed).toEqual([]);
      expect(observed.blocking).toEqual([]);
      ids.push(...page.result.hits.map(({ id }) => id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expected.slice(0, ids.length));
      previous = page;
    }
    expect(ids).toEqual(expected);
    expect(executions.size).toBe(3);
    // The retained maintenance intent must also finish in the restarted child;
    // successful request-local reads alone do not establish worker recovery.
    await native.indexing('running');
    while (await native.readPreparation(id)) {
      assert(performance.now() < deadline, 'Restarted child did not finish the same retained preparation');
      await Bun.sleep(25);
    }
    await resumed.closeObservation(first.queried, context());
  } finally {
    await resumed?.close();
    await operations?.close();
    await native.indexing('running');
  }
}, 180_000);

let fixture: ReleasedDiscoveryFixture;
let witness: CreatedSubject;
const timingMarker = `Wallclock${crypto.randomUUID().replaceAll('-', '')}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_LAG_THRESHOLD_MS = 300_000;
// Fixture precondition only: lets a genuinely committed envelope age beyond the existing threshold.
// Request, repair, lease and preparation budgets keep their production values.
const SOURCE_LAG_PRECONDITION_GUARD_MS = SOURCE_LAG_THRESHOLD_MS + 15_000;
const timingContext = () => ({ deadline: Date.now() + 10_000 });

async function databaseNow(): Promise<number> {
  const result = await fixture.inspect<{ now: Date }>('SELECT statement_timestamp() AS now');
  return result.rows[0]!.now.getTime();
}

async function caughtUp(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const observed = await fixture.search!.freshness();
    if (observed.behind === 0) {
      expect(observed.catchingUp).toBe(false);
      return;
    }
    if (Date.now() >= deadline) throw new Error(`Native consumer did not catch up: ${JSON.stringify(observed)}`);
    await Bun.sleep(25);
  }
}

test('a genuine explicit retain expiry releases native work without claiming the HTTP 24-hour default elapsed', async () => {
  const native = fixture.search!;
  const bound: ReleasedNativeBoundRequest[] = [];
  // Different admitted plans produce distinct native jobs; re-retaining one key must not rewrite its expiry.
  try {
    for (const size of [2, 3]) {
      bound.push(
        await native.bindRequest(
          {
            plan: { filterDocument: undefined, text: parseText(timingMarker), sort: 'id', size },
            snapshot: 'pit',
          },
          timingContext(),
        ),
      );
    }
    const [ordinary, short] = bound.map(({ capture }) => {
      if (capture.status !== 'captured' && capture.status !== 'preparing')
        throw new Error(`Original native producer did not admit repair work: ${JSON.stringify(capture)}`);
      return capture.repair;
    });
    if (!ordinary || !short) throw new Error('Expected two actual admitted native repair jobs');
    expect(short).not.toEqual(ordinary);
    await native.indexing('paused');
    try {
      const beforeDefault = Date.now();
      const ordinaryId = await native.preparePublic(ordinary);
      const afterDefault = Date.now();
      const ordinaryRecord = await native.readPreparation(ordinaryId);
      expect(ordinaryRecord).not.toBeNull();
      expect(ordinaryRecord!.locator).toEqual({ kind: 'repair', key: JSON.stringify(ordinary), job: ordinary });
      expect(Number(ordinaryRecord!.expires_at)).toBeGreaterThanOrEqual(beforeDefault + DAY_MS);
      expect(Number(ordinaryRecord!.expires_at)).toBeLessThanOrEqual(afterDefault + DAY_MS);

      for (const expiresAt of [
        NaN,
        Infinity,
        -Infinity,
        0,
        Date.now() - 1,
        Date.now() + 0.5,
        Number.MAX_SAFE_INTEGER + 1,
        Date.now() + DAY_MS + 60_000,
      ]) {
        await expect(native.preparePublic(short, { expiresAt })).rejects.toThrow('safe future instant within 24 hours');
      }

      const expiresAt = Date.now() + 1_000;
      const shortId = await native.preparePublic(short, { expiresAt });
      expect(shortId).not.toBe(ordinaryId);
      const shortRecord = await native.readPreparation(shortId);
      expect(shortRecord).not.toBeNull();
      expect(shortRecord!.locator).toEqual({ kind: 'repair', key: JSON.stringify(short), job: short });
      expect(Number(shortRecord!.expires_at)).toBe(expiresAt);
      expect(shortRecord!.revision).toBe('1');
      // Same-key retain keeps the actual frontier/revision/expiry rather than editing a stored row.
      expect(await native.preparePublic(short)).toBe(shortId);
      expect(await native.readPreparation(shortId)).toEqual(shortRecord);

      const expiryGuard = Date.now() + 5_000;
      while (Date.now() <= expiresAt) {
        if (Date.now() >= expiryGuard) throw new Error('Explicit native retain expiry did not elapse');
        await Bun.sleep(Math.max(1, Math.min(50, expiresAt - Date.now() + 1)));
      }
      // Merely reading an expired locator never deletes it or certifies successful repair.
      expect(await native.readPreparation(shortId)).toEqual(shortRecord);
      expect(await native.readPreparation(ordinaryId)).toEqual(ordinaryRecord);
      expect(Number(ordinaryRecord!.expires_at)).toBeGreaterThan(Date.now());

      await native.indexing('running');
      const cleanupDeadline = Date.now() + 15_000;
      while (await native.readPreparation(shortId)) {
        if (Date.now() >= cleanupDeadline) throw new Error('Native worker did not release the expired preparation');
        await Bun.sleep(25);
      }
      // Expiry of scheduling state is not Source publication, coverage or an expired success response.
      const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { text: timingMarker, limit: 1 });
      expect(response.status).toBe(200);
      expect((response.body.subjects as { id: string }[]).map(({ id }) => id)).toEqual([witness.id]);
    } finally {
      await native.indexing('running');
    }
  } finally {
    for (const request of bound) {
      try {
        if (request.capture.status === 'captured')
          await request.operations.closeObservation(request.capture.queried, timingContext());
      } finally {
        await request.operations.close();
      }
    }
  }
}, 60_000);

test(
  'actual PostgreSQL Source lag over five minutes gives readiness and recovers through the same native worker',
  async () => {
    const native = fixture.search!;
    const prefix = native.indexPrefix;
    await caughtUp();
    await native.indexing('paused');
    let committed: CreatedSubject;
    try {
      const beforeCommit = await databaseNow();
      committed = await fixture.createSubject('schema:Book', `${timingMarker} delayed`);
      const partition = partitionOf(routeOf(committed.id)!);
      const head = await fixture.inspect<{ position: string }>(
        'SELECT position::text FROM core.partition WHERE partition_no = $1',
        [partition],
      );
      const envelope = await fixture.inspect<{ recorded_at: Date }>(
        'SELECT recorded_at FROM core.outbox WHERE partition_no = $1 AND position = $2 AND event_seq = 0',
        [partition, head.rows[0]!.position],
      );
      const recordedAt = envelope.rows[0]!.recorded_at.getTime();
      expect(recordedAt).toBeGreaterThanOrEqual(beforeCommit);
      expect(recordedAt).toBeLessThanOrEqual(await databaseNow());
      const initial = await native.freshness();
      expect(initial.behind).toBeGreaterThan(0);
      expect(initial.asOf.getTime()).toBeLessThanOrEqual(recordedAt);

      const preconditionDeadline = Date.now() + SOURCE_LAG_PRECONDITION_GUARD_MS;
      for (;;) {
        const observed = await native.freshness();
        const now = await databaseNow();
        expect(observed.behind).toBeGreaterThan(0);
        expect(observed.asOf).toEqual(initial.asOf);
        if (now - recordedAt > SOURCE_LAG_THRESHOLD_MS && Date.now() - recordedAt > SOURCE_LAG_THRESHOLD_MS) {
          expect(now - observed.asOf.getTime()).toBeGreaterThan(SOURCE_LAG_THRESHOLD_MS);
          expect(observed.catchingUp).toBe(true);
          break;
        }
        if (Date.now() >= preconditionDeadline)
          throw new Error(`Real database Source lag did not age past its threshold: ${JSON.stringify(observed)}`);
        await Bun.sleep(Math.min(1_000, Math.max(1, recordedAt + SOURCE_LAG_THRESHOLD_MS + 1 - now)));
      }
      const stale = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { text: timingMarker, limit: 10 });
      expect(stale.status).toBe(503);
      expect(stale.body.code).toBe('index_not_ready');
      expect(stale.headers.get('retry-after')).toBeTruthy();
      expect(stale.body).not.toHaveProperty('subjects');
      expect(stale.body).not.toHaveProperty('as_of');
    } finally {
      await native.indexing('running');
    }
    await native.converge([witness, committed!]);
    await caughtUp();
    const beforeRead = await databaseNow();
    const recovered = await native.freshness();
    expect(recovered).toMatchObject({ behind: 0, catchingUp: false });
    expect(recovered.asOf.getTime()).toBeGreaterThanOrEqual(beforeRead);
    expect(recovered.asOf.getTime()).toBeLessThanOrEqual(await databaseNow());
    expect(native.indexPrefix).toBe(prefix);
    const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { text: timingMarker, limit: 10 });
    expect(response.status).toBe(200);
    expect((response.body.subjects as { id: string }[]).map(({ id }) => id).sort()).toEqual(
      [witness.id, committed!.id].sort(),
    );
  },
  SOURCE_LAG_PRECONDITION_GUARD_MS + 60_000,
);
