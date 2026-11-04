import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { HttpResponse } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';
import { routeOf } from '../../src/route/route.ts';

let fixture: ReleasedDiscoveryFixture;
let person: CreatedSubject;
let character: CreatedSubject;
let importedWork: string;
let handle: string;
const marker = `mixed${randomUUID().replaceAll('-', '')}`;
const personTerm = `${marker} Person`;
const characterTerm = `${marker} Character`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hits(response: HttpResponse) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const values = response.body.hits;
  if (!Array.isArray(values)) throw new Error('Expected the actual discovery hits wire');
  return values.map((value: unknown) => {
    if (
      !record(value) ||
      !record(value.key) ||
      typeof value.key.id !== 'string' ||
      !record(value.summary) ||
      !record(value.summary.value)
    )
      throw new Error('A discovery hit must have a native key and a current, nonnull summary');
    expect(value.summary.value.id).toBe(value.key.id);
    expect(value.summary.kind).toBe(value.key.owner === 'accounts' ? 'account' : 'subject');
    return { id: value.key.id, key: value.key, summary: value.summary.value };
  });
}

const request = () => ({
  representation: 'discovery-v1',
  text: `${personTerm} | ${characterTerm} | BASTARD | ${handle}`,
  filter: { kind: { in: ['schema:Person', 'schema:Character', 'schema:Book', 'account'] } },
  sort: 'id',
  limit: 2,
  languages: ['en'],
});

async function restartDuringCommittedPopulation() {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const result = await fixture.inspect<{ completed: number; total: number }>(
      `SELECT count(*) FILTER (WHERE complete)::int AS completed,count(*)::int AS total
       FROM search.discovery_population`,
    );
    const progress = result.rows[0];
    if (progress && progress.completed > 0 && progress.completed < progress.total) break;
    if (Date.now() >= deadline) throw new Error('Default discovery did not commit partial population before restart');
    await Bun.sleep(50);
  }
  await fixture.search!.crash();
  await fixture.search!.restart();
}

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({ version: 1, search: 'native' });
  const identity = await fixture.request('anonymous', 'GET', `/v1/accounts?ids=${fixture.personas.alice.accountId}`);
  expect(identity.status).toBe(200);
  const accounts = identity.body.accounts;
  if (!Array.isArray(accounts) || !record(accounts[0]) || typeof accounts[0].handle !== 'string')
    throw new Error('Expected the current native Account handle');
  handle = accounts[0].handle;
  importedWork = (await fixture.importedHarem()).subject;
  person = await fixture.createSubject('schema:Person', personTerm);
  character = await fixture.createSubject('schema:Character', characterTerm);
  await fixture.catchUp([person, character]);
  await restartDuringCommittedPopulation();
}, 180_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

test('one real mixed request returns an imported Book and matching Character/Person hits across a bound cursor', async () => {
  const expected = [person.id, character.id, importedWork, fixture.personas.alice.accountId].sort();
  // Await ordinary producer convergence through the public operation, without injecting ready/source state.
  const deadline = Date.now() + 600_000;
  for (;;) {
    const result = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { ...request(), limit: 100 });
    if (result.status === 200 && JSON.stringify(hits(result).map(({ id }) => id)) === JSON.stringify(expected)) break;
    if (result.status !== 200) {
      expect(result.status, JSON.stringify(result.body)).toBe(503);
      expect(result.body.code).toBe('index_not_ready');
    }
    if (Date.now() >= deadline) throw new Error(`Mixed discovery did not converge: ${JSON.stringify(result.body)}`);
    await Bun.sleep(50);
  }
  const first = await fixture.request('anonymous', 'POST', '/v1/subjects:search', request());
  expect(hits(first).map(({ id }) => id)).toEqual(expected.slice(0, 2));
  expect(first.body).not.toHaveProperty('subjects');
  expect(first.body).not.toHaveProperty('total');
  expect(record(first.body.kinds) && Array.isArray(first.body.kinds.values)).toBe(true);
  expect(typeof first.body.as_of).toBe('string');
  const cursor = first.body.next;
  if (typeof cursor !== 'string' || !cursor) throw new Error('Expected one actual mixed continuation');
  const second = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { ...request(), cursor });
  expect(hits(second).map(({ id }) => id)).toEqual(expected.slice(2));
  expect(second.body.next).toBeNull();
  const mixed = [...hits(first), ...hits(second)];
  const account = mixed.find(({ id }) => id === fixture.personas.alice.accountId);
  expect(account?.summary.handle).toBe(handle);
  for (const [subject, label] of [
    [person, personTerm],
    [character, characterTerm],
  ] as const) {
    const hit = mixed.find(({ id }) => id === subject.id);
    expect(hit?.key.route).toBe(routeOf(subject.id));
    expect(hit?.summary.label).toEqual({ value: label, language: 'en' });
  }
  const imported = mixed.find(({ id }) => id === importedWork);
  expect(imported?.key).toMatchObject({ owner: 'semantic', kind: 'schema:Book', route: routeOf(importedWork) });
  const importedLabel = imported?.summary.label;
  expect(record(importedLabel) && typeof importedLabel.value === 'string' && importedLabel.value.includes('BASTARD')).toBe(
    true,
  );
  for (const changed of [
    { ...request(), languages: ['ja'] },
    { ...request(), text: marker },
  ]) {
    const mismatch = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { ...changed, cursor });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('invalid_request');
  }
  const principal = await fixture.request('alice', 'POST', '/v1/subjects:search', { ...request(), cursor });
  expect(principal.status).toBe(400);
  const views = [cursor, ...cursor.split('.').map((part) => Buffer.from(part, 'base64url').toString('utf8'))];
  expect(views.some((view) => expected.some((id) => view.includes(id)) || view.includes(handle))).toBe(false);
  const legacy = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { text: marker });
  expect(legacy.status).toBe(200);
  expect(legacy.body).toHaveProperty('subjects');
  expect(legacy.body).not.toHaveProperty('hits');
}, 600_000);

test('a committed fence with stale native membership cannot disclose a Person or mint a stale cursor', async () => {
  const before = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { ...request(), limit: 100 });
  expect(hits(before).map(({ id }) => id)).toContain(person.id);
  await fixture.grant('editor', ['moderation:hide'], person.id);
  await fixture.search!.indexing('paused');
  try {
    const hidden = await fixture.request(
      'editor',
      'POST',
      `/v1/subjects/${person.id}:hide`,
      { reason: 'Current mixed disclosure while the native projection is stale' },
      discoveryKey(),
    );
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    const current = await fixture.request('anonymous', 'POST', '/v1/subjects:search', { ...request(), limit: 100 });
    if (current.status === 503) {
      expect(current.body.code).toBe('index_not_ready');
      expect(current.body).not.toHaveProperty('hits');
      expect(current.body).not.toHaveProperty('next');
    } else {
      expect(hits(current).map(({ id }) => id)).toEqual(
        [character.id, importedWork, fixture.personas.alice.accountId].sort(),
      );
      expect(current.body.next).toBeNull();
    }
    expect(JSON.stringify(current.body)).not.toContain(person.id);
  } finally {
    await fixture.search!.indexing('running');
  }
}, 90_000);
