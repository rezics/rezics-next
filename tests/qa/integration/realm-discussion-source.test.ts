import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realmDiscussionSource, realmSourcePopulation, type RealmSourceCandidate } from '../support/realm-discussion-source.ts';

let source: Awaited<ReturnType<typeof realmDiscussionSource>>;
const opened: { candidate: RealmSourceCandidate; dispose(): Promise<void> }[] = [];
beforeAll(async () => {
  source = await realmDiscussionSource();
  // Producer preparation is explicit and outside this file's operation clock.
  // A missing source refuses here; an ordinary consumer never builds another corpus.
  await source.sources.select(source.adapter);
}, 420_000);
afterAll(async () => { for (const copy of opened.reverse()) await copy.dispose(); });

async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  expect(response.status, raw).toBe(status); return JSON.parse(raw) as T;
}

test('complete keyed source retains all inventories, sequence starts, measured build and verified physical custody', async () => {
  const manifest = await source.sources.select(source.adapter), metadata = manifest.metadata;
  expect(metadata.population).toEqual(realmSourcePopulation);
  expect(metadata.ranking.public).toHaveLength(261);
  expect(metadata.ranking.retained).toHaveLength(21); expect(metadata.ranking.current).toHaveLength(21);
  expect(metadata.discussion.roots).toHaveLength(21); expect(metadata.discussion.siblings).toHaveLength(193);
  expect(metadata.discussion.nested).toHaveLength(34);
  expect(Object.keys(metadata.sequenceStarts.ranking)).toHaveLength(6);
  expect(Object.keys(metadata.sequenceStarts.discussion)).toHaveLength(6);
  expect(manifest.provenance.producerBuild?.deadlineMs).toBe(1_800_000);
  expect(manifest.provenance.producerBuild!.elapsedMs).toBeLessThan(1_800_000);
  expect(manifest.provenance.elapsedMs).toBeLessThan(600_000);
  expect(metadata.measurements.requests).toBeGreaterThanOrEqual(552 * 3);
  expect(metadata.measurements.classes['Main POST /v1/realm-replies']!.count).toBeGreaterThanOrEqual(552);
  expect(manifest.integrity.ownerState.physicalProject).toBeString();
  expect(manifest.integrity.files['rdf-cut.json']).toBeDefined();
  expect(manifest.integrity.files['producer-requests.jsonl']).toBeDefined();
}, 420_000);

test('a second complete restored copy retains author, admission and sequence states after the first copy changes', async () => {
  const original = await source.sources.select(source.adapter);
  const first = await source.sources.restore(source.adapter); opened.push(first);
  const expected = first.candidate.metadata.discussion.roots[0]!, person = first.candidate.sessions.discussionPublic.owner;
  const saved = await answer<{ revisionId: string; revisionDigest: string }>(person.main('POST', '/v1/member-reply-drafts', {
    profile: 'member-reply-draft-v1', reply: expected.reply, variantId: expected.variantId,
    rootTarget: expected.rootTarget, rootRevision: expected.rootRevision,
    originRealm: first.candidate.sessions.discussionPublic.realm,
    language: 'en', direction: 'ltr', expectedHead: expected.revisionId,
    body: 'Original authored change made only in the first restored copy.', actingSubject: person.actingSubject }, randomUUID()), 201);
  await answer(person.main('POST', '/v1/realm-reply-placements', {
    profile: 'realm-reply-placement-v1', realm: first.candidate.sessions.discussionPublic.realm,
    reply: expected.reply, revisionId: saved.revisionId, revisionDigest: saved.revisionDigest,
    reviewDecisionId: null, expectedHead: expected.placement, actingSubject: person.actingSubject }, randomUUID()), 201);
  expect(await answer(person.main('GET', `/v1/member-replies/${expected.reply.slice(-36)}?actingSubject=${encodeURIComponent(person.actingSubject!)}`)))
    .toMatchObject({ revisionId: saved.revisionId, author: expected.author });
  await first.dispose();
  const second = await source.sources.restore(source.adapter); opened.push(second);
  expect(second.candidate.runId).not.toBe(first.candidate.runId);
  const restoredOwner = second.candidate.sessions.discussionPublic.owner;
  expect(await answer(restoredOwner.main('GET', `/v1/member-replies/${expected.reply.slice(-36)}?actingSubject=${encodeURIComponent(restoredOwner.actingSubject!)}`)))
    .toMatchObject({ revisionId: expected.revisionId, revisionDigest: expected.revisionDigest,
      body: expected.body, author: expected.author, rootTarget: expected.rootTarget, rootRevision: expected.rootRevision });
  expect(second.candidate.metadata.sequenceStarts).toEqual(original.metadata.sequenceStarts);
  expect(second.candidate.metadata.ranking.admission).toEqual(original.metadata.ranking.admission);
  expect((await source.sources.select(source.adapter)).digest).toBe(original.digest);
  for (const copy of [first, second])
    expect(copy.candidate.preparation.totalMs - copy.candidate.preparation.admissionWaitMs).toBeLessThan(600_000);
  const directory = join('.temp', 'goal', 'realm-source-proof'); mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${Bun.env.REZICS_QA_RUN_ID}.json`), JSON.stringify({
    sourceKey: original.key, sourceDigest: original.digest, producerRun: original.provenance.qaIdentity,
    producerRevision: original.provenance.producerRevision, producerBuild: original.provenance.producerBuild,
    population: original.metadata.population, measurements: original.metadata.measurements,
    copies: [first, second].map(copy => ({ runId: copy.candidate.runId, preparation: copy.candidate.preparation,
      elapsedMs: copy.elapsedMs, admissionWaitMs: copy.admissionWaitMs })), sourceUnchanged: true,
  }, null, 2) + '\n', { mode: 0o600 });
}, 420_000);
