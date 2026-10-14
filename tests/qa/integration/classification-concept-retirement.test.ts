import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startHomeStack } from './feed-read-support.ts';
import { CLASSIFIED_AS } from '../../../services/main/src/modules/statement/schema.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../../../services/main/src/modules/classification/proposition.ts';
import { VOCABULARY_COST } from '../../../services/main/src/modules/classification/vocabulary.ts';

interface Vocabulary { scheme: string; schemeHead: string; concept: string; conceptHead: string;
  path: string; expression: string; sense: string; definitionRevision: string; replayed: boolean }
type StatementRead = Record<string, unknown> & { sourcePosition: { dataEpoch: string; sequence: string } };
const short = (id: string) => id.slice(-36);

test('Concept steward retires the exact current head without changing retained references', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('concept-retirement');
  try {
    const { author, reader, stack } = home;
    const trace: unknown[] = [];
    const graph = stack.env.fuseki;
    const nativeQuery = graph.query.bind(graph), nativeCommand = graph.commandWithReceipt.bind(graph);
    graph.query = async (...args) => {
      const result = await nativeQuery(...args);
      if (args[0].includes('SELECT ?scheme ?schemeHead ?path ?expression ?sense ?revision ?manifest'))
        trace.push({ selection: result });
      return result;
    };
    graph.commandWithReceipt = async envelope => {
      const result = await nativeCommand(envelope);
      if (envelope.update.includes('rv:conceptState rv:Retired')) trace.push({ command: result });
      return result;
    };
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
    const before = await home.json<StatementRead>(await call(referencePath), 200);
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
    const queriesBefore = stack.fuseki.queries;
    const retirementResponse = await call('/v1/classification-vocabulary', retire, author.token, key);
    if (retirementResponse.status !== 201) throw new Error(JSON.stringify({
      request: { method: 'POST', path: '/v1/classification-vocabulary', body: retire },
      answer: { status: retirementResponse.status, body: await retirementResponse.json() }, trace,
    }));
    const retired = await home.json<Vocabulary>(retirementResponse, 201);
    expect(stack.fuseki.queries - queriesBefore).toBeLessThanOrEqual(VOCABULARY_COST.graphReads);
    expect(retired).toMatchObject({ scheme: created.scheme, schemeHead: created.schemeHead,
      concept: created.concept, path: created.path, expression: created.expression,
      sense: created.sense, definitionRevision: created.definitionRevision });
    expect(retired.conceptHead).not.toBe(created.conceptHead);
    const lifecycle = await stack.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#> ASK {
        GRAPH <urn:rezics:graph:current> { <${created.concept}> rv:conceptState rv:Retired ;
          rv:head <${retired.conceptHead}> ; skos:prefLabel ${JSON.stringify(input.labels[0]!.value)}@en .
          FILTER NOT EXISTS { <${created.concept}> rv:conceptState rv:Active }
          <${created.sense}> rv:head <${created.definitionRevision}> . }
        GRAPH <urn:rezics:graph:revisions> { <${created.conceptHead}> rv:component <${created.concept}> .
          <${retired.conceptHead}> rv:predecessor <${created.conceptHead}> . }
      }`);
    expect(lifecycle.boolean).toBe(true);
    expect(await home.json<Vocabulary>(await call('/v1/classification-vocabulary', retire, author.token, key), 200))
      .toEqual({ ...retired, replayed: true });
    expect((await call('/v1/classification-vocabulary', { ...retire,
      labels: [{ language: 'en', value: 'Conflicting payload' }] }, author.token, key)).status).toBe(409);
    expect((await call('/v1/classification-vocabulary', retire)).status).toBe(409);
    const after = await home.json<StatementRead>(await call(referencePath), 200);
    // The read observation advances; the pinned Statement and its meaning do not.
    expect(after).toEqual({ ...before, sourcePosition: after.sourcePosition });
    expect(after.sourcePosition.dataEpoch).toBe(before.sourcePosition.dataEpoch);
    expect(BigInt(after.sourcePosition.sequence)).toBeGreaterThan(BigInt(before.sourcePosition.sequence));
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
