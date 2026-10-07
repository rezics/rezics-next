import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FusekiClient,
  type MembershipPreparationInput,
  type MembershipPreparationResult,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  hasUnnormalizedMembership,
  normalizeStoredMembership,
} from '../../../services/main/src/modules/structure/membership-normalize.ts';
import { GRAPHS, RV, hash, iri } from '../../../services/main/src/modules/work/activate.ts';
import { itemListIri } from '../../../services/main/src/modules/structure/graph.ts';
import { readMainOutboxEnvelope } from '../../../services/main/src/modules/outbox/relay.ts';

type Turn = Extract<MembershipPreparationResult, { status: 'committed' }>;
const SCHEMA = 'https://schema.org/';

test('ordered membership preparation exhausts native seeks, resumes and replays over a populated HTTP store', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.FUSEKI_COMMAND_TOKEN) throw new Error('Run through isolated integration QA');
  const client = () => new FusekiClient(Bun.env.FUSEKI_URL!, undefined, Bun.env.FUSEKI_COMMAND_TOKEN!);
  let fuseki = client();
  const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
  const scope = `urn:rezics:membership-seek:${randomUUID()}`;
  const structure = `${scope}:structure`, generation = `${scope}:generation`;
  const revision = `${scope}:revision`, manifest = `${scope}:manifest`;
  const target = `${scope}:target`, list = itemListIri(generation, structure);
  const live = 3000, removed = 9, unrelated = 20_000;
  const started = Date.now();
  const update = (triples: string) => fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <${SCHEMA}>
    INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${triples} } }`);
  await update(`${iri(structure)} a rv:Structure ; rv:structureProfile rv:BookComposition ;
      rv:structureHead ${iri(revision)} ; rv:selectedGeneration ${iri(generation)} .
    ${iri(generation)} a rv:StructureGeneration ; rv:structure ${iri(structure)} .`);
  await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
    ${iri(revision)} a rv:StructureRevision ; rv:manifest ${iri(manifest)} . } }`);
  for (let begin = 0; begin < live; begin += 300) {
    const triples: string[] = [];
    for (let index = begin; index < Math.min(begin + 300, live); index++) {
      const segment = `${scope}:segment:${Math.floor(index / 500)}`;
      triples.push(`${iri(segment)} a rv:OrderSegment ; rv:generation ${iri(generation)} ;
        rv:parent ${iri(structure)} ; rv:segmentKey "${Math.floor(index / 500).toString(36)}" .
        <${scope}:occurrence:${index}> a schema:ListItem .
        <${scope}:placement:${index}> a rv:OccurrencePlacement ; rv:generation ${iri(generation)} ;
        rv:occurrence <${scope}:occurrence:${index}> ; rv:occurrenceRole rv:ChapterRole ;
        rv:orderSegment ${iri(segment)} ; rv:orderKey "${index.toString(36)}" ; rv:target ${iri(target)} .`);
    }
    await update(triples.join('\n'));
  }
  await update(Array.from({ length: removed }, (_, index) => `
    <${scope}:removed-occurrence:${index}> a schema:ListItem .
    <${scope}:removed:${index}> a rv:RemovedPlacement ; rv:generation ${iri(generation)} ;
      rv:occurrence <${scope}:removed-occurrence:${index}> ; rv:occurrenceRole rv:ChapterRole ;
      rv:lastParent ${iri(structure)} ; rv:removedBy ${iri(revision)} ; rv:target ${iri(target)} .`).join('\n'));
  for (let begin = 0; begin < unrelated; begin += 2000) {
    await update(Array.from({ length: 2000 }, (_, index) =>
      `<${scope}:unrelated:${begin + index}> <${scope}:unrelated-predicate> "unrelated" .`).join('\n'));
  }
  const seedMs = Date.now() - started;
  const pinned = () => fuseki.query(`PREFIX rv: <${RV}> SELECT ?s ?p ?o WHERE {
    { GRAPH ${iri(GRAPHS.current)} { VALUES ?s { ${iri(structure)} ${iri(generation)} } ?s ?p ?o } }
    UNION { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o BIND(${iri(revision)} AS ?s) } }
  } ORDER BY ?s ?p ?o`);
  const before = await pinned();
  const sequence = async () => (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
    GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:sequence ?n }
  }`)).results?.bindings;
  expect(await hasUnnormalizedMembership(fuseki)).toBe(true);
  const nativePost = (input: object, authorized = true) => fetch(`${Bun.env.FUSEKI_URL!.replace(/\/$/u, '')}/command`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      ...(authorized ? { authorization: `Bearer ${Bun.env.FUSEKI_COMMAND_TOKEN}` } : {}) },
    body: JSON.stringify({ templateIndex: input }),
  });
  const denied = await nativePost({ operation: 'membership-prepare', ...lineage,
    requestId: randomUUID(), deadline: Date.now() + 60_000 }, false);
  expect(denied.status).toBe(403);
  const prior = await sequence();
  const expired = await nativePost({ operation: 'membership-prepare', ...lineage,
    requestId: randomUUID(), deadline: Date.now() - 1 });
  expect(await expired.json()).toMatchObject({ status: 'deadline' });
  const wrongEpoch = await nativePost({ operation: 'membership-prepare', ...lineage,
    dataEpoch: randomUUID(), requestId: randomUUID(), deadline: Date.now() + 60_000 });
  expect(await wrongEpoch.json()).toMatchObject({ status: 'guard-unmatched' });
  expect(await sequence()).toEqual(prior);

  const deadline = Date.now() + 540_000;
  const firstRequest: MembershipPreparationInput = { ...lineage, requestId: randomUUID(), deadline };
  const acknowledged: Turn[] = [];
  const realFetch = globalThis.fetch;
  let loseAck = true;
  const dropped = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await realFetch(input, init);
    if (typeof init?.body === 'string' && init.body.includes(firstRequest.requestId)) {
      acknowledged.push(await response.clone().json() as Turn);
      if (loseAck) { loseAck = false; throw new Error('lost committed membership acknowledgement'); }
    }
    return response;
  });
  let first: MembershipPreparationResult;
  try { first = await fuseki.membershipPrepare(firstRequest); }
  finally { dropped.mockRestore(); }
  expect(acknowledged).toHaveLength(2);
  expect(acknowledged[1]).toEqual(acknowledged[0]);
  expect(first!).toEqual(acknowledged[0]);
  expect(first!.status).toBe('committed');
  expect(acknowledged[0]!.placements).toBe(24);
  expect(acknowledged[0]!.receipts).toHaveLength(1);
  const receipt = acknowledged[0]!.receipts[0]!;
  expect(receipt).toStartWith('urn:rezics:receipt:bootstrap:ordered-membership:');
  const proof = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?count ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:placementCount ?count ; rv:outcome rv:Succeeded ;
      rv:dataEpoch ?epoch ; rv:sequence ?sequence }
  }`);
  expect(proof.results?.bindings[0]?.count?.value).toBe('24');
  expect(await readMainOutboxEnvelope(fuseki, {
    batchId: `urn:rezics:outbox:${hash(receipt)}`,
    eventIds: [`urn:rezics:event:${hash(receipt)}`],
    dataEpoch: proof.results!.bindings[0]!.epoch!.value,
    sequence: proof.results!.bindings[0]!.sequence!.value,
    routingEpoch: lineage.routingEpoch,
  }, `urn:rezics:event:${hash(receipt)}`)).toMatchObject({
    data: { receipt: { systemProof: { kind: 'ordered-membership-normalization', placements: 24 } } },
  });
  const turns: Turn[] = [acknowledged[0]!];
  const observed = () => new Proxy(fuseki, {
    get(owner, property) {
      if (property === 'membershipPrepare') return async (input: MembershipPreparationInput, signal?: AbortSignal) => {
        const result = await owner.membershipPrepare(input, signal);
        if (result.status === 'committed') turns.push(result);
        return result;
      };
      const value = Reflect.get(owner, property, owner);
      return typeof value === 'function' ? value.bind(owner) : value;
    },
  });
  const env = () => ({ fuseki: observed(), lineage, objectDirectory: '.temp/membership-seek' });
  const partial = await normalizeStoredMembership(env(), 1, deadline);
  expect(partial.complete).toBe(false);
  expect(partial.placements).toBe(24);
  const afterSecond = await sequence();
  expect(await fuseki.membershipPrepare(firstRequest)).toEqual(first!);
  expect(await sequence()).toEqual(afterSecond);
  // Recreate the caller; checkpoint progress belongs to the store rather than
  // the client. Native process restart/compaction is qualified in MembershipSeekTest.
  fuseki = client();
  const resumed = await normalizeStoredMembership(env(), 256, deadline);
  expect(resumed.complete).toBe(true);
  expect(turns.reduce((sum, turn) => sum + turn.placements, 0)).toBe(live + removed);
  expect(turns.every(turn => turn.examined <= 256 && turn.placements <= 24)).toBe(true);
  expect(turns.some(turn => turn.phase >= 3)).toBe(true);
  const preparationMs = Date.now() - (deadline - 540_000);
  expect(preparationMs).toBeLessThan(540_000);
  expect(Date.now() - started).toBeLessThan(600_000);
  expect(await pinned()).toEqual(before);
  const rows = await fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <${SCHEMA}>
    SELECT (COUNT(?placement) AS ?count) WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?placement a rv:OccurrencePlacement, schema:ListItem ; rv:generation ${iri(generation)} ;
        schema:item ${iri(target)} ; schema:position ?position ; rv:orderKey ?orderKey ; rv:orderSegment ?segment .
      ?segment rv:segmentKey ?segmentKey .
      ${iri(list)} schema:itemListElement ?placement .
      FILTER(?position = CONCAT(?segmentKey, "-", ?orderKey))
      FILTER NOT EXISTS { ?placement rv:target ?legacy }
    } }`);
  expect(rows.results?.bindings[0]?.count?.value).toBe(String(live));
  const removedRows = await fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <${SCHEMA}>
    SELECT (COUNT(?placement) AS ?count) WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?placement a rv:RemovedPlacement ; rv:generation ${iri(generation)} ; schema:item ${iri(target)} .
      FILTER NOT EXISTS { ?placement rv:target ?legacy }
      FILTER NOT EXISTS { ?placement a schema:ListItem }
    } }`);
  expect(removedRows.results?.bindings[0]?.count?.value).toBe(String(removed));
  expect(await hasUnnormalizedMembership(fuseki)).toBe(false);
  const finishedSequence = await sequence();
  expect(await normalizeStoredMembership(env(), 1, deadline)).toEqual({ complete: true, placements: 0, receipts: [] });
  expect(await sequence()).toEqual(finishedSequence);
  expect(turns.at(-1)?.examined).toBe(0);
  for (let attempt = 0; attempt < 3; attempt++) expect(await hasUnnormalizedMembership(fuseki)).toBe(false);

  // Raw fixture mutation does not advance the command sequence. Its storage
  // version still invalidates the proof, preventing false completion.
  await update(`<${scope}:late-unrelated> <${scope}:unrelated-predicate> "late" .`);
  expect(await hasUnnormalizedMembership(fuseki)).toBe(true);
  const rescanned = await normalizeStoredMembership(env(), 256, deadline);
  expect(rescanned).toEqual({ complete: true, placements: 0, receipts: [] });
  expect(await hasUnnormalizedMembership(fuseki)).toBe(false);
  expect(await sequence()).toEqual(finishedSequence);
  const product = await Bun.file(new URL('../../../infra/jena/fuseki-text.ttl', import.meta.url)).text();
  expect(product).not.toContain('fuseki:serviceUpdate');
  expect(product).not.toContain('fuseki:serviceReadWriteGraphStore');
  const artifact = Bun.env.REZICS_QA_ARTIFACT_DIR;
  if (artifact) writeFileSync(join(artifact, 'membership-seek-cost.json'), JSON.stringify({
    live, removed, unrelated, seedMs, preparationMs, totalMs: Date.now() - started,
    turns: turns.map(({ placements, examined, phase, complete, restarted }) => ({ placements, examined, phase, complete, restarted })),
    qualification: 'Populated HTTP owner preparation; QA assembler permits fixture seeding. Full stack startup, restore and corpus capacity are not measured.',
  }, null, 2));
}, 600_000);
