import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Account, CommunityDriver, Fixture, Subject } from '../../../../specs/community-driver.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { preparePublicationPage } from '../../src/community/publication.ts';
import type { RealmHomePublicationPage } from '../../src/community/realm-home-publications.ts';
import { readSubjectSummaryObservation } from '../../src/semantic/summaries.ts';
import readSummaries from '../../src/semantic/summaries-read.sql';
import { observeSql } from '../content/support/sql-observer.ts';
import { closeCommunityDrivers, communityFixtureRuntime, createCommunityDriver } from './community-driver.ts';

let driver: CommunityDriver;
let people: Fixture;
let runtime: ReturnType<typeof communityFixtureRuntime>;
const key = () => JSON.stringify(crypto.randomUUID());
const context = () => ({ actor: { kind: 'anonymous' as const }, deadline: Date.now() + 60_000 });
const deps = () => ({
  pool: runtime.system.database.pool,
  access: runtime.system.access,
  routeKey: runtime.system.routeKey,
});

beforeAll(async () => {
  driver = await createCommunityDriver();
  people = await driver.provision();
  runtime = communityFixtureRuntime();
});
afterAll(closeCommunityDrivers);

async function post<T>(actor: Account, path: string, body: unknown) {
  const response = await driver.request({ actor, method: 'POST', path, body, key: key() });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(201);
  return value as T;
}
async function realm(visibility: 'public' | 'protected' = 'public') {
  const { space } = await post<{ space: { spaceId: string } }>(people.owner, '/v1/spaces', {
    title: 'Publication shelf host',
  });
  const created = await post<{ realm: { realmId: string } }>(people.owner, '/v1/realms', {
    spaceId: space.spaceId,
    contextId: people.contextId,
    title: 'Publication shelf',
    visibility,
  });
  return created.realm.realmId;
}
async function publish(realmId: string, subjectId: string) {
  return post<{ publication: { publicationId: string } }>(people.owner, `/v1/realms/${realmId}/publications`, {
    subjectId,
  });
}
async function shelf(realmId: string, cursor?: string, actor: Account | null = null) {
  return driver.request({
    actor,
    method: 'GET',
    path: `/v1/realms/${realmId}/publicationShelf${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  });
}
async function page(realmId: string, cursor?: string) {
  const response = await shelf(realmId, cursor);
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return value as RealmHomePublicationPage;
}

test('mounted shelves hydrate twelve native summaries in home batches and retain the ordinary raw continuation', async () => {
  const realmId = await realm();
  expect(await page(realmId)).toEqual({ items: [], next: null });
  const publications = new Map<string, string>();
  for (let index = 0; index < 13; index++) {
    const { subject } = await post<{ subject: Subject }>(people.subjectOwner, '/v1/subjects', {
      type: 'schema:Book', labels: { en: `Shelf book ${index}` },
    });
    publications.set(subject.id, (await publish(realmId, subject.id)).publication.publicationId);
  }
  await driver.settle();
  const observer = observeSql(runtime.system.database.pool);
  let first: RealmHomePublicationPage;
  try {
    first = await page(realmId);
    const batches = observer.records.filter((entry) => entry.statement === readSummaries.sql);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.length).toBeLessThanOrEqual(12);
    const keys = batches.flatMap((entry) => {
      const input = entry.parameters[readSummaries.params.indexOf('subjects')];
      return (typeof input === 'string' ? JSON.parse(input) : input) as { id: string }[];
    });
    expect(keys.map((item) => item.id).sort()).toEqual(first.items.map((item) => item.summary.id).sort());
  } finally {
    await observer.close();
  }
  expect(first!.items).toHaveLength(12);
  for (const item of first!.items) {
    expect(item.summary.label?.value).toStartWith('Shelf book ');
    expect(item.summary.id).toBe(item.publication.subjectId);
    expect(item.publication.publicationId).toBe(publications.get(item.summary.id)!);
    expect(item.summary.cover).toBeNull();
  }
  expect(first!.next).toBeString();
  const second = await page(realmId, first!.next!);
  expect(second.items).toHaveLength(1);
  expect(second.next).toBeNull();
  expect(new Set([...first!.items, ...second.items].map((item) => item.summary.id))).toEqual(new Set(publications.keys()));
  const ordinary = await driver.request({ actor: null, method: 'GET', path: `/v1/realms/${realmId}/publications?limit=12` });
  expect(ordinary.status).toBe(200);
  const raw = await ordinary.json() as { items: { publicationId: string }[]; next: string };
  expect(raw.items.map((item) => item.publicationId)).toEqual(first!.items.map((item) => item.publication.publicationId));
  const nativeContinuation = await page(realmId, raw.next);
  expect(nativeContinuation.items).toEqual(second.items);
  expect((await shelf(realmId, first!.next!, people.member)).status).toBe(400);
  const fault = observeSql(runtime.system.database.pool);
  try {
    fault.armFault({ match: { statement: readSummaries.sql }, boundary: 'before', error: new AccessUnavailableError('overloaded') });
    const failed = await shelf(realmId, first!.next!);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('Shelf book');
  } finally {
    await fault.close();
  }
  expect(await page(realmId, first!.next!)).toEqual(second);
});

test('current head association and native summary witnesses retire after publication replacement or source edits', async () => {
  const realmId = await realm();
  const subjectId = people.subject.id;
  const original = await publish(realmId, subjectId);
  await driver.settle();
  const selected = await preparePublicationPage(deps(), realmId, context(), { limit: 12 });
  expect(await selected!.current()).toBe(true);
  const observation = await readSubjectSummaryObservation({ ...deps(), ...context() }, [subjectId, subjectId]);
  expect(observation.summaries.size).toBe(1);
  expect(await observation.current()).toBe(true);
  const changed = await driver.subjectCommand('edit', people.subjectOwner, subjectId, key());
  expect(changed.status).toBe(201);
  expect(await observation.current()).toBe(false);
  const withdrawn = await driver.request({
    actor: people.owner, method: 'POST', path: `/v1/realms/${realmId}/publications/${subjectId}:withdraw`,
    key: key(), ifMatch: JSON.stringify(original.publication.publicationId), body: {},
  });
  expect(withdrawn.status).toBe(200);
  const replacement = await publish(realmId, subjectId);
  expect(replacement.publication.publicationId).not.toBe(original.publication.publicationId);
  expect(await selected!.current()).toBe(false);
  await driver.settle();
  expect((await page(realmId)).items[0]!.publication.publicationId).toBe(replacement.publication.publicationId);
  expect((await shelf(await realm('protected'))).status).toBe(404);
});

test('concealed Subjects yield safe sparse pages and required source failure cannot become an empty shelf', async () => {
  const realmId = await realm();
  await publish(realmId, people.subject.id);
  await driver.settle();
  const observation = await readSubjectSummaryObservation({ ...deps(), ...context() }, [people.subject.id]);
  expect(observation.summaries.get(people.subject.id)?.label).not.toBeNull();
  const concealed = await driver.subjectCommand('takeDown', people.subjectOwner, people.subject.id, key());
  expect(concealed.status).toBe(200);
  expect(await observation.current()).toBe(false);
  await driver.settle();
  expect(await page(realmId)).toEqual({ items: [], next: null });
  const response = await driver.request({ actor: null, method: 'GET', path: `/v1/realms/${realmId}/publicationShelf?limit=100` });
  expect(response.status).toBe(400);
});
