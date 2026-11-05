import { afterAll, beforeAll, expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { parseText } from '../../src/search/text.ts';
import { type CreatedSubject, type ReleasedDiscoveryFixture } from '../support/released-discovery.ts';
import type { ReleasedNativeBoundRequest } from './support/released-discovery-runtime.ts';

import assert from 'node:assert/strict';
import {
  PROFILE_FORMAT,
  planReads,
  platformRegistry,
  type CompositionDocument,
  type ZoneStarter,
} from '@rezics/composition';
import bookZone from '../../../../packages/definitions/presentation/book/zone.json';
import { fromPlainText } from '@rezics/document';
import { Compile } from 'typebox/compile';
import { ZonePageResponseSchema } from '../../src/zones/contract.ts';
import { ZonePageReadProgressSchema } from '../../src/zones/page-continuation.ts';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionView, DynamicCollectionView } from '../../../../specs/dynamic-collections-driver.ts';
import type { HttpResponse, Subject } from '../../../../specs/semantic-driver.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../../src/command/command.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import type { PublicFilterConsumerOperations } from '../../src/search/public-filter-consumer-contract.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
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
  const expiryText = marker('Retainexpiry');
  const expirySubject = await fixture.createSubject('schema:Book', expiryText);
  await fixture.catchUp([expirySubject]);
  await fixture.grant('editor', ['moderation:hide'], GLOBAL_CONTEXT);
  await native.indexing('paused');
  // Different admitted plans produce distinct native jobs; re-retaining one key must not rewrite its expiry.
  try {
    for (const size of [2, 3]) {
      bound.push(
        await native.bindRequest(
          {
            plan: { filterDocument: undefined, text: parseText(expiryText), sort: 'id', size },
            snapshot: 'pit',
          },
          timingContext(),
        ),
      );
    }
    status(
      await population.request(
        'editor',
        'POST',
        `/v1/subjects/${expirySubject.id}:hide`,
        { reason: 'Actual pending repair retained through its explicit expiry' },
        discoveryKey(),
      ),
      200,
    );
    for (const request of bound) {
      if (request.capture.status === 'captured') {
        const pending = await request.operations.readStatus({ queried: request.capture.queried }, timingContext());
        expect(pending.status).toBe('observed');
        assert(pending.status === 'observed');
        expect(pending.pending.length).toBeGreaterThan(0);
        expect(pending.blocking.length).toBeGreaterThan(0);
      }
    }
    const [ordinary, short] = bound.map(({ capture }) => {
      if (capture.status !== 'captured' && capture.status !== 'preparing')
        throw new Error(`Original native producer did not admit repair work: ${JSON.stringify(capture)}`);
      return capture.repair;
    });
    if (!ordinary || !short) throw new Error('Expected two actual admitted native repair jobs');
    expect(short).not.toEqual(ordinary);
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
      const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
        text: timingMarker,
        limit: 1,
      });
      expect(response.status).toBe(200);
      expect((response.body.subjects as { id: string }[]).map(({ id }) => id)).toEqual([witness.id]);
    } finally {
      await native.indexing('running');
    }
  } finally {
    await native.indexing('running');
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
      const stale = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
        text: timingMarker,
        limit: 10,
      });
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
    const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', {
      text: timingMarker,
      limit: 10,
    });
    expect(response.status).toBe(200);
    expect((response.body.subjects as { id: string }[]).map(({ id }) => id).sort()).toEqual(
      [witness.id, committed!.id].sort(),
    );
  },
  SOURCE_LAG_PRECONDITION_GUARD_MS + 60_000,
);

// These are query/assertion helpers over population.base, never another fixture or authority.
// A real public keyword isolates the original catalogue population from the preceding edit controls.
let catalogueInput: Promise<Awaited<ReturnType<typeof originalCatalogueInput>>> | undefined;
async function originalCatalogueInput() {
  const sources = await population.sources();
  const curated = sources.sources.find(({ source }) => source.visibility === 'public');
  assert(curated, 'The current producer must supply its actual public curated Collection');
  const books = await fixture.books();
  const recipes = await fixture.recipes();
  const filters = fixture.filters(await fixture.classification(), await fixture.diet());
  const group = await fixture.createSubject('skos:Concept', marker('Originalfreshnesspopulation'));
  const subjects = [...Object.values(books.subjects), books.edition, ...Object.values(recipes.subjects)];
  for (const subject of subjects) await fixture.adopt(subject, discoveryStatement('schema:keywords', group.id));
  await fixture.catchUp([...subjects, group]);
  const within = (filter: FilterDocument): FilterDocument => ({
    and: [filter, { statement: { property: 'schema:keywords', in: [group.id] } }],
  });
  const jobs = [
    {
      name: 'word count over one million',
      type: 'schema:Book',
      filter: within(filters.words),
      ids: [books.subjects['B-long'].id],
    },
    {
      name: 'light-novel form and harem',
      type: 'schema:Book',
      filter: within(filters.formHarem),
      ids: ['B-long', 'B-edge', 'B-characters']
        .map((name) => books.subjects[name as keyof typeof books.subjects].id)
        .sort(),
    },
    {
      name: 'combined words form and harem',
      type: 'schema:Book',
      filter: within(filters.combined),
      ids: [books.subjects['B-long'].id],
    },
    {
      name: 'vegetarian cooking within thirty minutes',
      type: 'schema:Recipe',
      filter: within(filters.dietTime),
      ids: ['R-quick', 'R-edge', 'R-cooked', 'R-other-cooked']
        .map((name) => recipes.subjects[name as keyof typeof recipes.subjects].id)
        .sort(),
    },
  ];
  return { sources, curated, books, recipes, subjects, jobs };
}
const catalogueInputForRead = () => (catalogueInput ??= originalCatalogueInput());

function usefulMembers(response: HttpResponse, size: number) {
  status(response, 200);
  noCounts(response.body);
  assert(Array.isArray(response.body.members));
  assert(response.body.next === null || (typeof response.body.next === 'string' && response.body.next.length > 0));
  expect(response.body.members.length).toBeLessThanOrEqual(size);
  if (response.body.next !== null) expect(response.body.members).toHaveLength(size);
  return {
    ids: response.body.members.map((row: { subjectId: string }) => row.subjectId),
    next: response.body.next as string | null,
  };
}

async function exactCollectionPages(id: string, filter: FilterDocument, expected: string[], persona: DiscoveryPersona) {
  const ids: string[] = [];
  const cursors = new Set<string>();
  const deadline = performance.now() + 60_000;
  let cursor: string | undefined;
  for (;;) {
    assert(performance.now() < deadline, 'The fixed finite original Collection population did not complete');
    const query = new URLSearchParams({
      filter: JSON.stringify(filter),
      sort: 'id',
      limit: '2',
      ...(cursor ? { cursor } : {}),
    });
    const response = await population.request(persona, 'GET', `/v1/collections/${id}/members?${query}`);
    if (response.status === 202) {
      expect(response.body).toEqual({ preparing: true });
      expect(response.headers.get('retry-after')).toBe('1');
      await Bun.sleep(25);
      continue;
    }
    const page = usefulMembers(response, 2);
    ids.push(...page.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expected.slice(0, ids.length));
    expect(ids.length).toBeLessThanOrEqual(expected.length);
    if (page.next === null) {
      expect(ids).toEqual(expected);
      return;
    }
    expect(cursors.has(page.next)).toBe(false);
    cursors.add(page.next);
    expect(cursors.size).toBeLessThanOrEqual(Math.ceil(expected.length / 2));
    cursor = page.next;
  }
}

// Each cell calls its actual owner HTTP consumer. Catalogue matching is never used as a substitute.
for (let jobIndex = 0; jobIndex < 4; jobIndex++) {
  const title = [
    'word count over one million',
    'light-novel form and harem',
    'combined words form and harem',
    'vegetarian cooking within thirty minutes',
  ][jobIndex]!;
  test(`original catalogue baseline: ${title} has full ordered pages and exact exhaustion`, async () => {
    const { jobs } = await catalogueInputForRead();
    const job = jobs[jobIndex]!;
    const ids: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = searchPage(
        await population.request('anonymous', 'POST', '/v1/subjects:search', {
          filter: job.filter,
          sort: 'id',
          limit: 2,
          ...(cursor ? { cursor } : {}),
        }),
        2,
      );
      ids.push(...page.ids);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(job.ids.slice(0, ids.length));
      expect(ids.length).toBeLessThanOrEqual(job.ids.length);
      cursor = page.next ?? undefined;
      if (cursor) {
        expect(cursors.has(cursor)).toBe(false);
        cursors.add(cursor);
        expect(cursors.size).toBeLessThanOrEqual(Math.ceil(job.ids.length / 2));
      }
    } while (cursor);
    expect(ids).toEqual(job.ids);
  }, 180_000);

  test(`public curated freshness consumer: ${title} preserves native occurrence identity and useful pages`, async () => {
    const { curated, jobs, books } = await catalogueInputForRead();
    const job = jobs[jobIndex]!;
    await exactCollectionPages(curated.source.id, job.filter, job.ids, 'anonymous');
    const duplicates = curated.occurrences.filter(({ member }) => member.subjectId === books.subjects['B-long'].id);
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map(({ member }) => member.id)).size).toBe(2);
    const edit = status(
      await population.request('alice', 'GET', `/v1/collections/${curated.source.id}/members?limit=100`),
      200,
    );
    expect(edit.body.next).toBeNull();
    expect(edit.body.members).toEqual(curated.occurrences.map(({ member }) => member));
  }, 120_000);
}

let supported: Promise<string> | undefined;
async function supportOriginalWithoutState() {
  const { subjects } = await catalogueInputForRead();
  const response = status(
    await population.request(
      'alice',
      'POST',
      '/v1/libraryLabels',
      { name: marker('Freshnesssupport') },
      discoveryKey(),
    ),
    201,
  );
  const label = response.body.label as { id: string };
  assert(typeof label.id === 'string');
  for (const subject of subjects) {
    status(
      await population.request(
        'alice',
        'POST',
        `/v1/libraryLabels/${label.id}:assign`,
        { subjectId: subject.id },
        discoveryKey(),
      ),
      200,
    );
    status(await population.request('alice', 'GET', `/v1/libraryEntries/${subject.id}`), 404);
  }
  return everything();
}
for (let jobIndex = 0; jobIndex < 4; jobIndex++) {
  const title = [
    'word count over one million',
    'light-novel form and harem',
    'combined words form and harem',
    'vegetarian cooking within thirty minutes',
  ][jobIndex]!;
  test(`OWN Everything freshness consumer without state: ${title} uses actual label support and hides it from Bob`, async () => {
    const id = await (supported ??= supportOriginalWithoutState());
    const { jobs, subjects } = await catalogueInputForRead();
    const job = jobs[jobIndex]!;
    for (const subject of subjects)
      status(await population.request('alice', 'GET', `/v1/libraryEntries/${subject.id}`), 404);
    await exactCollectionPages(id, job.filter, job.ids, 'alice');
    for (const persona of ['anonymous', 'bob', 'outsider'] as const) {
      const denied = status(
        await population.request(
          persona,
          'GET',
          `/v1/collections/${id}/members?filter=${encodeURIComponent(JSON.stringify(job.filter))}`,
        ),
        404,
      );
      for (const key of ['members', 'next', 'count', 'total']) expect(denied.body).not.toHaveProperty(key);
    }
  }, 120_000);
}

for (let jobIndex = 0; jobIndex < 4; jobIndex++) {
  const title = [
    'word count over one million',
    'light-novel form and harem',
    'combined words form and harem',
    'vegetarian cooking within thirty minutes',
  ][jobIndex]!;
  test(`OWN accepted-state freshness consumer: ${title} reflects the commit or prepares on the very next read`, async () => {
    const { jobs, subjects } = await catalogueInputForRead();
    const job = jobs[jobIndex]!;
    const { profile } = population.profile(job.type);
    const set = profile.entryStateSet;
    assert(set);
    const active = set.states.find(({ role }) => role === 'active');
    const completed = set.states.find(({ role }) => role === 'completed');
    assert(active && completed);
    for (const subject of subjects.filter(({ id }) => job.ids.includes(id))) {
      const prior = await population.request('alice', 'GET', `/v1/libraryEntries/${subject.id}`);
      expect([200, 404]).toContain(prior.status);
      const revision = prior.status === 200 ? (prior.body.libraryEntry as EntryHandle).revision : undefined;
      status(
        await population.request(
          'alice',
          'PUT',
          `/v1/libraryEntries/${subject.id}`,
          { state: active.id, ...(revision ? { revision } : {}) },
          discoveryKey(),
        ),
        prior.status === 200 ? 200 : 201,
      );
    }
    const list = status(
      await population.request(
        'alice',
        'GET',
        `/v1/collections?${new URLSearchParams({ curatorAccountId: fixture.personas.alice.accountId, limit: '100' })}`,
      ),
      200,
    );
    expect(list.body.next).toBeNull();
    assert(Array.isArray(list.body.collections));
    const views = (list.body.collections as CollectionView[]).filter(
      (row): row is DynamicCollectionView =>
        row.membershipKind === 'dynamic' &&
        row.builtin?.kind === 'state' &&
        row.builtin.profileId === profile.id &&
        row.builtin.stateSetId === set.id &&
        row.builtin.stateId === active.id,
    );
    expect(views).toHaveLength(1);
    const id = views[0]!.id;
    await exactCollectionPages(id, job.filter, job.ids, 'alice');
    const changed = job.ids[0]!;
    const prior = status(await population.request('alice', 'GET', `/v1/libraryEntries/${changed}`), 200);
    await fixture.search!.indexing('paused');
    try {
      status(
        await population.request(
          'alice',
          'PUT',
          `/v1/libraryEntries/${changed}`,
          { state: completed.id, revision: (prior.body.libraryEntry as EntryHandle).revision },
          discoveryKey(),
        ),
        200,
      );
      await exactCollectionPages(
        id,
        job.filter,
        job.ids.filter((value) => value !== changed),
        'alice',
      );
      status(await population.request('bob', 'GET', `/v1/collections/${id}/members`), 404);
    } finally {
      await fixture.search!.indexing('running');
    }
  }, 120_000);
}

function originalListDocument(filter: FilterDocument, type: string): CompositionDocument {
  return {
    root: { props: {} },
    content: [
      {
        type: 'TypeList',
        props: {
          id: 'original-outcome',
          title: { en: 'Original discovery outcome' },
          types: [type],
          filter,
          sort: 'id',
          limit: 2,
        },
      },
    ],
  };
}

for (let jobIndex = 0; jobIndex < 4; jobIndex++) {
  const title = [
    'word count over one million',
    'light-novel form and harem',
    'combined words form and harem',
    'vegetarian cooking within thirty minutes',
  ][jobIndex]!;
  test(`public mounted Zone freshness consumer: ${title} unions overlapping actual sources without duplicates`, async () => {
    const { curated, jobs } = await catalogueInputForRead();
    const job = jobs[jobIndex]!;
    const current = status(await population.request('alice', 'GET', `/v1/collections/${curated.source.id}`), 200);
    expect((current.body.collection as CollectionView).revision).toBeGreaterThan(curated.source.revision);
    const memberSource = { kind: 'collection', id: curated.source.id } as const;
    const document = originalListDocument(job.filter, job.type);
    const configuration = structuredClone(bookZone) as ZoneStarter;
    expect(configuration.scope).toContain('book/all');
    configuration.pages = [{ route: '', document }];
    await fixture.grant('editor', ['zone:create'], GLOBAL_CONTEXT);
    await fixture.setup.openFeatures(['zone_sources']);
    const created = status(
      await population.request(
        'editor',
        'POST',
        '/v1/zones',
        { configuration, mounts: [memberSource.id], visibility: 'private' },
        discoveryKey(),
      ),
      201,
    );
    const zone = created.body.zone as { id: string; revision: string };
    const published = status(
      await population.request(
        'editor',
        'POST',
        `/v1/zones/${zone.id}:publish`,
        { visibility: 'public' },
        { ...discoveryKey(), 'if-match': `"${zone.revision}"` },
      ),
      200,
    );
    const revision = (published.body.zone as { revision: string }).revision;
    const ids: string[] = [];
    const cursors = new Set<string>();
    const deadline = performance.now() + 60_000;
    let cursor: string | undefined;
    for (;;) {
      assert(performance.now() < deadline, 'Fixed finite original mounted Zone remained unfinished');
      const answer = await population.request(
        'anonymous',
        'POST',
        `/v1/zones/${zone.id}:readPage${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`,
        { target: { route: '' }, languages: ['en'] },
      );
      expect(answer.headers.get('cache-control')).toBe('private, no-store');
      if (answer.status === 202) {
        expect(Compile(ZonePageReadProgressSchema).Check(answer.body), JSON.stringify(answer.body)).toBe(true);
        const next = answer.body.next as string;
        expect(cursors.has(next)).toBe(false);
        cursors.add(next);
        cursor = next;
        continue;
      }
      status(answer, 200);
      expect(Compile(ZonePageResponseSchema).Check(answer.body), JSON.stringify(answer.body)).toBe(true);
      expect(answer.body.document).toEqual(document);
      expect(answer.body.zone).toMatchObject({ id: zone.id, revision });
      expect(JSON.stringify(answer.body)).not.toContain('Second occurrence with a distinct note');
      const key = planReads(platformRegistry, document, { subject: null }).nodes['original-outcome'];
      assert(key);
      const result = (answer.body.reads as Record<string, { status: number; body: Record<string, unknown> }>)[key];
      assert(result);
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      noCounts(result.body);
      assert(Array.isArray(result.body.subjects));
      ids.push(...result.body.subjects.map((row: { id: string }) => row.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(job.ids.slice(0, ids.length));
      expect(ids.length).toBeLessThanOrEqual(job.ids.length);
      assert(result.body.next === null || typeof result.body.next === 'string');
      if (result.body.next === null) {
        expect(ids).toEqual(job.ids);
        break;
      }
      expect(result.body.subjects).toHaveLength(2);
      const next = result.body.next;
      expect(cursors.has(next)).toBe(false);
      cursors.add(next);
      cursor = next;
    }
    // The Zone grants no new rights to its source; source owner discovery remains independent.
    status(await population.request('anonymous', 'GET', `/v1/collections/${memberSource.id}`), 200);
  }, 120_000);

  test(`configured TypeList freshness consumer: ${title} uses native aggregate continuation and exact released facts`, async () => {
    const { jobs, subjects, recipes } = await catalogueInputForRead();
    const job = jobs[jobIndex]!;
    const document = originalListDocument(job.filter, job.type);
    await fixture.grant('steward', ['presentation:publish', 'presentation:activate'], GLOBAL_CONTEXT);
    const published = status(
      await population.request(
        'steward',
        'POST',
        '/v1/presentation/profiles',
        { profile: { format: PROFILE_FORMAT, generic: document, bases: [], types: [], routes: [] } },
        discoveryKey(),
      ),
      201,
    );
    const current = status(await population.request('anonymous', 'GET', '/v1/presentation/active'), 200);
    status(
      await population.request(
        'steward',
        'POST',
        `/v1/presentation/profiles/${published.body.digest}:activate`,
        { expected_head: current.body.head },
        discoveryKey(),
      ),
      200,
    );
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const continuation = cursor ? { node: 'original-outcome', cursor } : undefined;
      const response = status(
        await population.request('anonymous', 'POST', '/v1/pages:read', {
          target: { route: '/original-outcome' },
          ...(continuation ? { continuation } : {}),
        }),
        200,
      );
      expect(response.body.profile).toBe(published.body.digest);
      expect(response.body.document).toEqual(document);
      const plan = planReads(platformRegistry, document, { subject: null, ...(continuation ? { continuation } : {}) });
      const key = plan.nodes['original-outcome'];
      assert(key);
      const reads = response.body.reads as Record<string, { status: number; body: Record<string, unknown> }>;
      expect(Object.keys(reads)).toEqual([key]);
      const result = reads[key]!;
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      noCounts(result.body);
      assert(Array.isArray(result.body.subjects));
      assert(result.body.next === null || typeof result.body.next === 'string');
      expect(result.body.subjects.length).toBeLessThanOrEqual(2);
      if (result.body.next !== null) expect(result.body.subjects).toHaveLength(2);
      ids.push(...result.body.subjects.map((row: { id: string }) => row.id));
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(job.ids.slice(0, ids.length));
      expect(ids.length).toBeLessThanOrEqual(job.ids.length);
      cursor = (result.body.next as string | null) ?? undefined;
      if (cursor) {
        expect(seen.has(cursor)).toBe(false);
        seen.add(cursor);
      }
    } while (cursor);
    expect(ids).toEqual(job.ids);
    for (const subject of subjects.filter(({ id }) => job.ids.includes(id))) {
      const disclosed = status(await fixture.read(subject), 200).body.subject as Subject;
      expect(disclosed).toMatchObject({ id: subject.id, type: job.type, release: subject.release });
      const values = (property: string) => disclosed.statements[property]?.map(({ value }) => value.content);
      if (job.type === 'schema:Book') {
        if (jobIndex === 0 || jobIndex === 2)
          expect(values(fixture.meaning.words)).toEqual([{ amount: '+1200001', unit: '1' }]);
        if (jobIndex === 1 || jobIndex === 2) {
          const classification = await fixture.classification();
          expect(values(fixture.meaning.form)).toContain(classification.lightNovel.id);
          expect(values('schema:keywords')).toContain(classification.harem.id);
        }
      } else {
        expect(values(fixture.meaning.diet)).toContain((await fixture.diet()).vegetarian.id);
        const minutes =
          subject.id === recipes.subjects['R-quick'].id ? 25 : subject.id === recipes.subjects['R-edge'].id ? 30 : 20;
        expect(values(fixture.meaning.time)).toEqual([{ amount: `+${minutes}`, unit: fixture.meaning.minuteStorage }]);
        expect(values('schema:recipeIngredient')).toEqual([
          { language: 'en', text: 'Controlled authored ingredients; no diet inference.' },
        ]);
        const instructions = values('schema:recipeInstructions');
        assert(instructions?.length === 1);
        const reference = instructions[0];
        assert(reference && typeof reference === 'object' && !Array.isArray(reference));
        assert(typeof reference.document === 'string');
        const document = status(
          await population.request('anonymous', 'GET', `/v1/documents/${reference.document}`),
          200,
        );
        expect(document.body.document).toMatchObject({
          subjectId: subject.id,
          availability: 'available',
          language: 'en',
          licence: 'CC-BY-4.0',
          body: fromPlainText('Simmer the controlled test ingredients, then serve.'),
        });
      }
    }
  }, 120_000);
}

for (const owner of ['imported Source tuple', 'native statement consent'] as const) {
  test(`${owner}: actual positive negative ordering and retained executions lose disclosure immediately and recover only after native FOREIGN repair`, async () => {
    const native = fixture.search!;
    const imported = owner === 'imported Source tuple' ? await fixture.importedHarem() : undefined;
    const consent = owner === 'native statement consent' ? await fixture.statementConsent() : undefined;
    if (consent) status(await consent.disclose(), 200);
    const subject = imported?.subject ?? consent!.subject;
    const positive: FilterDocument = imported
      ? { statement: { property: 'schema:keywords', in: [imported.sourceConcept] } }
      : { statement: { property: 'rezics:penNameOf', in: [consent!.target] } };
    const dependency = imported?.dependency ?? consent!.dependency;
    expect(dependency.kind).toBe(imported ? 'sourceTuple' : 'consent');
    if (imported) {
      expect(imported.bulk.length).toBeGreaterThan(0);
      expect(imported.current.next).toBeNull();
      expect(imported.current.adoption?.mode).toBe('replace');
      expect(imported.current.candidates.some((candidate) => candidate.id === imported.candidate)).toBe(true);
    }
    const deadline = performance.now() + 60_000;
    for (;;) {
      const response = await population.request('anonymous', 'POST', '/v1/subjects:search', {
        filter: positive,
        sort: 'id',
        limit: 2,
      });
      if (response.status === 200) {
        const page = searchPage(response, 2);
        if (page.ids.includes(subject)) {
          expect(page.next).toBeNull();
          break;
        }
      } else readiness(response);
      assert(performance.now() < deadline, `${owner} required native positive never became searchable`);
      await Bun.sleep(25);
    }
    const requests: ReleasedNativeBoundRequest[] = [];
    const executions: {
      request: ReleasedNativeBoundRequest;
      query: Extract<Awaited<ReturnType<PublicFilterConsumerOperations['query']>>, { status: 'queried' }>;
    }[] = [];
    const context = () => ({ deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS) });
    await native.indexing('paused');
    try {
      for (const [filter, sort] of [
        [positive, 'id'],
        [{ not: positive }, 'id'],
        [positive, 'name'],
      ] as const) {
        const bound = await native.bindRequest(
          { plan: { filterDocument: filter, text: undefined, sort, size: 2, pageSize: 2 }, snapshot: 'pit' },
          context(),
        );
        requests.push(bound);
        expect(bound.capture.status).toBe('captured');
        assert(bound.capture.status === 'captured');
        const query = await bound.operations.query(bound.capture.queried, context());
        expect(query.status).toBe('queried');
        assert(query.status === 'queried');
        if (filter === positive) expect(query.result.hits.map(({ id }) => id)).toEqual([subject]);
        else expect(query.result.hits.map(({ id }) => id)).not.toContain(subject);
        const start = await bound.operations.readStatus(
          { queried: query.queried, execution: query.execution },
          context(),
        );
        expect(start.status).toBe('observed');
        assert(start.status === 'observed');
        expect(start.pending).toEqual([]);
        expect(start.changed).toEqual([]);
        expect(start.blocking).toEqual([]);
        executions.push({ request: bound, query });
      }
      status(imported ? await imported.takedown() : await consent!.retract(), 200);
      const reductions = [];
      for (const { request, query } of executions) {
        const reduced = await request.operations.readStatus(
          { queried: query.queried, execution: query.execution },
          context(),
        );
        expect(reduced.status).toBe('observed');
        assert(reduced.status === 'observed');
        expect(reduced.pending.length).toBeGreaterThan(0);
        expect(reduced.blocking.length).toBeGreaterThan(0);
        reductions.push(reduced.pending);
      }
      for (const persona of ['anonymous', 'editor'] as const)
        for (const [filter, sort] of [
          [positive, 'id'],
          [{ not: positive }, 'id'],
          [positive, 'name'],
        ] as const)
          readiness(await population.request(persona, 'POST', '/v1/subjects:search', { filter, sort, limit: 2 }));
      // The real owner returns these repair locators. No caller ACK, Source tuple or safety cut is invented.
      for (const { request } of executions) {
        assert(request.capture.status === 'captured');
        for (;;) {
          assert(performance.now() < deadline, `${owner} finite native repair never settled`);
          const repaired = await request.operations.repairStep(request.capture.repair, context());
          expect(['progress', 'settled']).toContain(repaired.status);
          assert(repaired.status === 'progress' || repaired.status === 'settled');
          expect(repaired.job).toEqual(request.capture.repair);
          preparationCost(repaired.cost);
          if (repaired.status === 'settled') break;
        }
      }
      // Repair must not erase a retained execution's start-to-final privacy change.
      for (let index = 0; index < executions.length; index++) {
        const { request, query } = executions[index]!;
        const old = await request.operations.readStatus(
          { queried: query.queried, execution: query.execution },
          context(),
        );
        expect(old.status).toBe('observed');
        assert(old.status === 'observed');
        for (const head of reductions[index]!) expect(old.changed).toContainEqual(head);
        expect(old.blocking.length).toBeGreaterThan(0);
      }
    } finally {
      for (const request of requests) {
        try {
          if (request.capture.status === 'captured')
            await request.operations.closeObservation(request.capture.queried, context());
        } finally {
          await request.operations.close();
        }
      }
      await native.indexing('running');
    }
    const recovered = searchPage(
      await population.request('anonymous', 'POST', '/v1/subjects:search', { filter: positive, sort: 'id', limit: 2 }),
      2,
    );
    expect(recovered).toEqual({ ids: [], next: null });
    const fresh = await native.bindRequest(
      { plan: { filterDocument: positive, text: undefined, sort: 'id', size: 2, pageSize: 2 }, snapshot: 'pit' },
      context(),
    );
    try {
      expect(fresh.capture.status).toBe('captured');
      assert(fresh.capture.status === 'captured');
      const current = await fresh.operations.query(fresh.capture.queried, context());
      expect(current.status).toBe('queried');
      assert(current.status === 'queried');
      expect(current.result.hits).toEqual([]);
      expect(current.window.exhausted).toBe(true);
      const observed = await fresh.operations.readStatus(
        { queried: current.queried, execution: current.execution },
        context(),
      );
      expect(observed.status).toBe('observed');
      assert(observed.status === 'observed');
      expect(observed.pending).toEqual([]);
      expect(observed.changed).toEqual([]);
      expect(observed.blocking).toEqual([]);
      await fresh.operations.closeObservation(current.queried, context());
    } finally {
      await fresh.operations.close();
    }
  }, 180_000);
}
