import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';

interface Vocabulary { scheme: string; schemeHead: string; concept: string; conceptHead: string;
  path: string; expression: string; sense: string; definitionRevision: string; replayed: boolean }
const short = (id: string) => id.slice(-36);

test('Concept steward retires the exact current head without changing retained references', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('concept-retirement');
  try {
    const { author, reader, stack } = home;
    const call = (path: string, body?: object, token = author.token, key = randomUUID()) => home.app.handle(
      new Request(`http://main.local${path}`, { method: body ? 'POST' : 'GET', headers: {
        authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}),
      }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    for (const person of [author, reader]) await person.grant('classification:define:global', 'classification.proposition.define');
    const input = { profile: 'classification-proposition-v2', scheme: null,
      labels: [{ language: 'en', value: `Retain board ${randomUUID()}` }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: author.actor };
    const created = await home.json<Vocabulary>(await call('/v1/classification-vocabulary', input), 201);
    await author.grant('context:create:root', 'context.create');
    await author.grant(`statement:speak:${author.actor}`, 'statement.record');
    const work = await stack.publicWork(author.actor, ['en'], 'Retained Concept reference');
    const context = await home.json<{ context: string; semanticRevision: string }>(await call('/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target: created.concept, relation: CLASSIFIED_AS, state: 'defined',
        definition: created.definitionRevision, applicability: [] }], actingSubject: author.actor,
    }), 201);
    const statementInput = { profile: 'statement-v1', speaker: { kind: 'personal' },
      subject: work.mainVersion, predicate: CLASSIFIED_AS, relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
      value: { kind: 'resource', iri: created.concept }, applicability: [], evidence: [],
      interpretation: { kind: 'explicit', context: context.context, semanticRevision: context.semanticRevision },
      actingSubject: author.actor };
    const statementKey = randomUUID();
    const statement = await home.json<{ statement: string; revision: string; meaningKey: string }>(
      await call('/v1/statements', statementInput, author.token, statementKey), 201);
    const referencePath = `/v1/statements/${short(statement.statement)}`;
    const before = await home.json<object>(await call(referencePath), 200);
    const retire = { ...input, scheme: { id: created.scheme, expectedHead: created.schemeHead },
      concept: { id: created.concept, expectedHead: created.conceptHead }, state: 'retired',
      labels: [{ language: 'en', value: 'This retirement must not rename the Concept' }] };
    const foreign = await home.json<{ code: string }>(await call('/v1/classification-vocabulary', {
      ...retire, actingSubject: reader.actor }, reader.token), 403);
    expect(foreign.code).toBe('authority_denied');
    const stale = await home.json<{ code: string }>(await call('/v1/classification-vocabulary', {
      ...retire, concept: { id: created.concept, expectedHead: `https://rezics.com/id/${randomUUID()}` } }), 409);
    expect(stale.code).toBe('operation_cancelled');
    const key = randomUUID();
    const retired = await home.json<Vocabulary>(await call('/v1/classification-vocabulary', retire, author.token, key), 201);
    expect(retired).toMatchObject({ scheme: created.scheme, schemeHead: created.schemeHead,
      concept: created.concept, path: created.path, expression: created.expression,
      sense: created.sense, definitionRevision: created.definitionRevision });
    expect(retired.conceptHead).not.toBe(created.conceptHead);
    expect(await home.json<Vocabulary>(await call('/v1/classification-vocabulary', retire, author.token, key), 200))
      .toEqual({ ...retired, replayed: true });
    expect((await call('/v1/classification-vocabulary', { ...retire,
      labels: [{ language: 'en', value: 'Conflicting payload' }] }, author.token, key)).status).toBe(409);
    expect((await call('/v1/classification-vocabulary', retire)).status).toBe(409);
    expect(await home.json<object>(await call(referencePath), 200)).toEqual(before);
    expect(await home.json<object>(await call('/v1/statements', statementInput, author.token, statementKey), 200))
      .toMatchObject({ ...statement, replayed: true });
    expect((await call('/v1/statements', statementInput)).status).toBe(409);
    const tag = { work: work.work, mainVersion: work.mainVersion, actingSubject: author.actor,
      tag: { concept: created.concept }, acceptance: { kind: 'global' } };
    expect((await call('/v1/tag-proposals', tag)).status).toBe(409);
    expect((await call('/v1/classification-vocabulary', { ...input,
      scheme: { id: created.scheme, expectedHead: created.schemeHead }, broader: [created.concept] })).status).toBe(409);
    const pinned = await home.json<object>(await call(`/v1/contexts/${short(context.context)}`), 200);
    expect(JSON.stringify(pinned)).toContain(created.definitionRevision);
    // A new Concept created by the scheme maintainer remains that maintainer's
    // own identity; ownership of the scheme's original Concept is independent.
    const peer = await home.json<Vocabulary>(await call('/v1/classification-vocabulary', {
      ...input, scheme: { id: created.scheme, expectedHead: created.schemeHead }, actingSubject: reader.actor,
    }, reader.token), 201);
    expect((await call('/v1/classification-vocabulary', { profile: input.profile,
      concept: { id: peer.concept, expectedHead: peer.conceptHead }, state: 'retired', actingSubject: author.actor })).status).toBe(403);
    expect((await call('/v1/classification-vocabulary', { profile: input.profile,
      concept: { id: peer.concept, expectedHead: peer.conceptHead }, state: 'retired', actingSubject: reader.actor }, reader.token)).status).toBe(201);
    await home.projectRelay();
  } finally { await home.stop(); }
}, 120_000);
