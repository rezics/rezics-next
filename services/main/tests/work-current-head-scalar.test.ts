import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommandRejected } from '../src/infrastructure/fuseki.ts';
import { AdmissionConflict, AdmissionDenied } from '../src/modules/access/admission.ts';
import { reduceFixtureGrant } from '../src/modules/access/fixture-authority.ts';
import { createAdmittedMetadataWork } from '../src/modules/work/create-admitted.ts';
import { editAdmittedMetadataWork, setAdmittedWorkScalar, type AdmittedWorkScalarInput } from '../src/modules/work/edit-admitted.ts';
import { setWorkScalar, StaleWorkHead, workScalarEditDigest } from '../src/modules/work/edit.ts';
import { readExactWorkRevision } from '../src/modules/work/history.ts';
import { readTitleControl } from '../src/modules/work/title-control.ts';
import { stateWorkType } from '../src/modules/work/type-command.ts';
import { head, initializeReplayFixtures, request, stack } from './command-replay-authorization/fixtures.ts';

initializeReplayFixtures();
const evidence = resolve('.temp/goal/current-head-scalar', process.env.REZICS_QA_RUN_ID ?? randomUUID());
const account = () => stack.composition.dependencies.account;

async function setup() {
  const member = await stack.member(randomUUID());
  await member.grant('work:create:root', 'work.create');
  const originalTitle = `Editorial replay ${randomUUID()}`;
  const created = await createAdmittedMetadataWork(stack.env, account(), stack.access, request(member), {
    actingSubject: member.actor, title: originalTitle, language: 'en',
    idempotencyKey: randomUUID(),
  });
  await member.grant(`work:read:${created.work}`, 'work.read');
  const grant = await member.grant(`work:edit:${created.work}`, 'work.edit');
  const titleInput = { work: created.work, expectedHead: created.workRevision, title: 'Saved title', language: 'en',
    titleControl: (await readTitleControl(stack.env, created.work)).basis,
    actingSubject: member.actor, idempotencyKey: randomUUID() };
  const title = await editAdmittedMetadataWork(stack.env, account(), stack.access, request(member), titleInput);
  expect(await head(created.work)).toBe(title.revision);
  expect(title.revision).not.toBe(created.workRevision);
  return { member, created, grant, originalTitle, titleInput, title };
}

async function snapshot(work: string) {
  return (await stack.fuseki.query(`SELECT ?g ?s ?p ?o WHERE {
    { VALUES ?s { <${work}> } }
    UNION { GRAPH ?linkGraph { ?s ?link <${work}> } }
    GRAPH ?g { ?s ?p ?o }
  } ORDER BY ?g ?s ?p ?o`)).results?.bindings;
}

async function recorded<T>(name: string, input: unknown, command: () => Promise<T>): Promise<T> {
  mkdirSync(evidence, { recursive: true });
  try {
    const result = await command();
    writeFileSync(resolve(evidence, `${name}.json`), JSON.stringify({ input, result }, null, 2));
    return result;
  } catch (error) {
    writeFileSync(resolve(evidence, `${name}.json`), JSON.stringify({ input,
      error: error instanceof Error ? { name: error.name, message: error.message,
        ...(error instanceof CommandRejected ? { result: error.result } : {}) } : error }, null, 2));
    throw error;
  }
}

for (const loss of ['expired', 'revoked'] as const) {
  test(`represented agent edits scalar at admitted title head; stale head and ${loss} authority refuse`, async () => {
    const { member, created, grant, originalTitle, titleInput, title } = await setup();
    // This is the advance request retained by the title-control replay setup.
    const input = { work: created.work, expectedHead: await head(created.work),
      scalarValue: { kind: 'boolean' as const, lexical: 'false' as const },
      actingSubject: member.actor, idempotencyKey: randomUUID() };
    const command = (body: AdmittedWorkScalarInput = input) => setAdmittedWorkScalar(stack.env, account(), stack.access, request(member), body);
    const result = await recorded(`${loss}-authorized`, { titleInput, title, scalarInput: input }, () => command());
    expect(result).toMatchObject({ work: created.work, predecessor: title.revision, replayed: false });
    expect(result.revision).not.toBe(title.revision);
    expect(await head(created.work)).toBe(result.revision);
    const retained = await readExactWorkRevision(stack.env, result.revision, async owner => owner === created.work);
    expect(retained).toMatchObject({ title: 'Saved title', language: 'en', mainVersion: created.mainVersion,
      scalarValue: input.scalarValue });
    const oldTitle = await readExactWorkRevision(stack.env, title.revision, async owner => owner === created.work);
    expect(oldTitle.title).toBe('Saved title');
    expect(oldTitle.scalarValue).toBeUndefined();
    expect(await readExactWorkRevision(stack.env, created.workRevision, async owner => owner === created.work))
      .toMatchObject({ title: originalTitle });
    expect(await command()).toEqual({ ...result, replayed: true });
    await expect(command({ ...input, scalarValue: { kind: 'unknown' } }))
      .rejects.toBeInstanceOf(AdmissionConflict);
    const beforeStale = await snapshot(created.work);
    const stale = { ...input, idempotencyKey: randomUUID() };
    await expect(recorded(`${loss}-stale`, stale, () => command(stale))).rejects.toBeInstanceOf(StaleWorkHead);
    expect(await head(created.work)).toBe(result.revision);
    expect(await readExactWorkRevision(stack.env, result.revision, async owner => owner === created.work)).toEqual(retained);
    const beforeLoss = await snapshot(created.work);
    expect(beforeLoss).toEqual(beforeStale);
    await reduceFixtureGrant(stack.accessPool, grant, loss === 'expired' ? { validUntil: new Date(0) } : { active: false });
    const fresh = { ...input, expectedHead: await head(created.work), idempotencyKey: randomUUID() };
    await expect(recorded(`${loss}-denied`, fresh, () => command(fresh))).rejects.toBeInstanceOf(AdmissionDenied);
    expect(await snapshot(created.work)).toEqual(beforeLoss);
    expect(await readExactWorkRevision(stack.env, title.revision, async owner => owner === created.work)).toEqual(oldTitle);
  }, 60_000);
}

test('type edit shares the Work revision owner after admitted title control', async () => {
  const { member, created, title } = await setup();
  const input = { work: created.work, expectedHead: await head(created.work), types: ['https://schema.org/Book'],
    actingSubject: member.actor, idempotencyKey: randomUUID() };
  const result = await recorded('type-authorized', input, () =>
    stateWorkType(stack.env, account(), stack.access, request(member), input));
  expect(result.predecessor).toBe(title.revision);
  expect(await readExactWorkRevision(stack.env, result.revision, async owner => owner === created.work))
    .toMatchObject({ title: 'Saved title', semanticTypes: input.types });
}, 60_000);

test('revision owner accepts the claimed scalar request at the actual admitted title head', async () => {
  const { member, created, title } = await setup();
  const scalarValue = { kind: 'boolean' as const, lexical: 'false' as const };
  const expectedHead = await head(created.work);
  const digest = workScalarEditDigest(created.work, expectedHead, scalarValue);
  const principal = await account().verify(request(member), ['work:edit']);
  const registered = await stack.access.register({ principal, actingSubject: member.actor,
    scope: `work:edit:${created.work}`, action: 'work.edit', idempotencyKey: randomUUID(), requestDigest: digest });
  const admission = await stack.access.claim(registered.id, digest, principal);
  expect(admission.dispatchEligible).toBe(true);
  const input = { admission, work: created.work, expectedHead, scalarValue };
  const result = await recorded('revision-owner-authorized', { title, input }, () => setWorkScalar(stack.env, input));
  expect(result).toMatchObject({ work: created.work, predecessor: title.revision, replayed: false });
}, 60_000);

test('stale scalar head refuses after admitted title control and preserves historical title', async () => {
  const { member, created, title } = await setup();
  const before = await snapshot(created.work);
  const retained = await readExactWorkRevision(stack.env, title.revision, async owner => owner === created.work);
  const input = { work: created.work, expectedHead: created.workRevision,
    scalarValue: { kind: 'boolean' as const, lexical: 'false' as const },
    actingSubject: member.actor, idempotencyKey: randomUUID() };
  await expect(recorded('independent-stale', input, () =>
    setAdmittedWorkScalar(stack.env, account(), stack.access, request(member), input))).rejects.toBeInstanceOf(StaleWorkHead);
  expect(await head(created.work)).toBe(title.revision);
  expect(await snapshot(created.work)).toEqual(before);
  expect(await readExactWorkRevision(stack.env, title.revision, async owner => owner === created.work)).toEqual(retained);
}, 60_000);

for (const loss of ['expired', 'revoked'] as const) {
  test(`current title head scalar refuses ${loss} represented authority without changing the Work`, async () => {
    const { member, created, grant, title } = await setup();
    const before = await snapshot(created.work);
    const retained = await readExactWorkRevision(stack.env, title.revision, async owner => owner === created.work);
    await reduceFixtureGrant(stack.accessPool, grant, loss === 'expired' ? { validUntil: new Date(0) } : { active: false });
    const input = { work: created.work, expectedHead: await head(created.work),
      scalarValue: { kind: 'boolean' as const, lexical: 'false' as const },
      actingSubject: member.actor, idempotencyKey: randomUUID() };
    await expect(recorded(`independent-${loss}`, input, () =>
      setAdmittedWorkScalar(stack.env, account(), stack.access, request(member), input))).rejects.toBeInstanceOf(AdmissionDenied);
    expect(await head(created.work)).toBe(title.revision);
    expect(await snapshot(created.work)).toEqual(before);
    expect(await readExactWorkRevision(stack.env, title.revision, async owner => owner === created.work)).toEqual(retained);
  }, 60_000);
}
