import { expect, test } from 'bun:test';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, hash } from '../src/modules/work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { readRestoredGraphReleaseProof, type RestoredGraphReleaseExpectation }
  from '../src/modules/work/restore-lineage.ts';

type Term = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
type Row = Record<string, Term>;
const xsd = 'http://www.w3.org/2001/XMLSchema#';
const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const restored = '10000000-0000-4000-8000-000000000001';
const source = '20000000-0000-4000-8000-000000000002';
const uri = (value: string): Term => ({ type: 'uri', value });
const literal = (value: string, datatype = 'string'): Term => ({ type: 'literal', value, datatype: xsd + datatype });

function fixture(paired = true, advanced = true, options: { epoch?: string; priorEpoch?: string;
  routingEpoch?: string; graph?: string; graphAfter?: string; main?: string; mainAfter?: string } = {}) {
  const epoch = options.epoch ?? restored, priorEpoch = options.priorEpoch ?? source;
  const graph = options.graph ?? '900', graphAfter = advanced ? options.graphAfter ?? '1100' : graph;
  const main = options.main ?? '4', mainAfter = advanced ? options.mainAfter ?? '7' : main;
  const saved = { dataEpoch: priorEpoch, graphSequence: graph, ...(paired
    ? { main: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: priorEpoch, sequence: main } } : {}) };
  const effective = { dataEpoch: priorEpoch, graphSequence: graphAfter, ...(paired
    ? { main: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: priorEpoch, sequence: mainAfter } } : {}) };
  const expectation: RestoredGraphReleaseExpectation = {
    lineage: { dataEpoch: epoch, routingEpoch: options.routingEpoch ?? '2' },
    restoreCutover: `urn:rezics:restore:${epoch}`, saved, effective,
  };
  const id = `urn:rezics:receipt:restore-release:${hash(epoch)}`;
  const requestDigest = hash(JSON.stringify(paired
    ? { family: 'restore-release-v2', lineage: expectation.lineage, priorDataEpoch: priorEpoch,
      priorSequence: effective.graphSequence, priorMainSequence: effective.main!.sequence, streamScope: MAIN_RELAY_STREAM_SCOPE }
    : { family: 'restore-release-v1', lineage: expectation.lineage, priorDataEpoch: priorEpoch, priorSequence: effective.graphSequence }));
  const rows: Row[] = [];
  const add = (graph: string, subject: string, predicate: string, object: Term) => rows.push({
    graph: uri(graph), subject: uri(subject), predicate: uri(predicate), object,
  });
  const field = (subject: string, name: string, value: string, datatype = 'string') =>
    add(GRAPHS.control, subject, RV + name, literal(value, datatype));
  field(DATASET, 'dataEpoch', epoch); field(DATASET, 'routingEpoch', expectation.lineage.routingEpoch); field(DATASET, 'sequence', '0', 'integer');
  add(GRAPHS.control, DATASET, RV + 'restoreCutover', uri(expectation.restoreCutover));
  field(MAIN_RELAY_STREAM_SCOPE, 'dataEpoch', epoch);
  field(MAIN_RELAY_STREAM_SCOPE, 'streamSequence', '0', 'integer');
  field(MAIN_RELAY_STREAM_SCOPE, 'legacyThroughSequence', '0', 'integer');
  add(GRAPHS.control, expectation.restoreCutover, rdfType, uri(RV + 'RestoreCutover'));
  field(expectation.restoreCutover, 'dataEpoch', epoch);
  field(expectation.restoreCutover, 'priorDataEpoch', priorEpoch);
  field(expectation.restoreCutover, 'priorSequence', graph, 'integer');
  if (paired) field(expectation.restoreCutover, 'priorMainSequence', main, 'integer');
  if (advanced) {
    field(expectation.restoreCutover, 'reconciledPriorSequence', effective.graphSequence, 'integer');
    if (paired) field(expectation.restoreCutover, 'reconciledPriorMainSequence', effective.main!.sequence, 'integer');
  }
  add(GRAPHS.receipts, id, rdfType, uri(RV + 'OperationReceipt'));
  add(GRAPHS.receipts, id, RV + 'datasetId', uri(DATASET));
  for (const [name, value, datatype] of [['requestDigest', requestDigest, 'string'], ['dataEpoch', epoch, 'string'],
    ['sequence', '0', 'integer'], ...(paired ? [['priorMainSequence', effective.main!.sequence, 'integer'],
      ['streamScope', MAIN_RELAY_STREAM_SCOPE, 'string']] : [])]) {
    add(GRAPHS.receipts, id, RV + name!, literal(value!, datatype!));
  }
  let reads = 0;
  const queries: string[] = [];
  const fuseki = { query: async (query: string, maxBytes: number) => {
    reads++; queries.push(query);
    expect(query).toContain('LIMIT 22'); expect(query).not.toContain('ASK'); expect(query).not.toContain('DISTINCT');
    expect(query).toContain(RV + 'restoreHold'); expect(maxBytes).toBe(16_384);
    const selected = query.includes(`BIND(<${MAIN_RELAY_STREAM_SCOPE}> AS ?subject)`)
      ? rows : rows.filter(row => row.subject!.value !== MAIN_RELAY_STREAM_SCOPE);
    return { results: { bindings: structuredClone(selected).slice(0, 22) } };
  }, commandWithReceipt: () => { throw new Error('release proof must not mutate'); } } as unknown as FusekiClient;
  return { expectation, id, requestDigest, rows, fuseki, queries, reads: () => reads };
}

for (const paired of [false, true]) for (const advanced of [false, true]) {
  test(`exact ${paired ? 'paired' : 'legacy'} native release with ${advanced ? 'reconciled' : 'saved'} independent cuts`, async () => {
    const f = fixture(paired, advanced);
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toEqual({ expectation: f.expectation,
      receipt: { id: f.id, requestDigest: f.requestDigest, dataEpoch: restored, sequence: '0' } });
    expect(f.rows.filter(row => row.graph!.value === GRAPHS.receipts)).toHaveLength(paired ? 7 : 5);
    expect(f.reads()).toBe(1);
  });
}

// Every field is tested independently, so a subset or digest-only proof cannot pass.
for (const paired of [false, true]) {
  const baseline = fixture(paired);
  baseline.rows.forEach((row, index) => {
    if (!paired && row.subject!.value === MAIN_RELAY_STREAM_SCOPE) return;
    const label = `${paired ? 'paired' : 'legacy'} ${row.subject!.value.split(':').at(-1)} ${row.predicate!.value.split('/').at(-1)}`;
    for (const fault of ['missing', 'wrong', 'duplicate', 'competing', 'term-kind', 'datatype', 'language'] as const) {
      test(`${label} denies ${fault} evidence`, async () => {
        const f = fixture(paired), actual = f.rows[index]!;
        if (fault === 'missing') f.rows.splice(index, 1);
        else if (fault === 'duplicate') f.rows.push(structuredClone(actual));
        else if (fault === 'competing') f.rows.push({ ...actual, object: literal('other') });
        else if (fault === 'wrong') actual.object = { ...actual.object!, value: 'wrong' };
        else if (fault === 'term-kind') actual.object = { ...actual.object!, type: actual.object!.type === 'uri' ? 'literal' : 'uri' };
        else if (fault === 'datatype') actual.object = { ...actual.object!, datatype: xsd + 'decimal' };
        else actual.object = { ...actual.object!, 'xml:lang': 'en' };
        expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
      });
    }
  });
}

for (const subject of [MAIN_RELAY_STREAM_SCOPE, `urn:rezics:restore:${restored}`,
  `urn:rezics:receipt:restore-release:${hash(restored)}`]) {
  test(`bounded ${subject} growth or unknown inventory denies`, async () => {
    const f = fixture(subject === MAIN_RELAY_STREAM_SCOPE), row = f.rows.find(item => item.subject!.value === subject)!;
    f.rows.push({ ...row, predicate: uri('https://unknown.test/vocab/priorSequence'), object: literal('900', 'integer') });
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
    for (let i = 0; i < 1000; i++) f.rows.push({ ...row, predicate: uri(`https://unknown.test/p${i}`) });
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
  });
}

for (const hold of [literal('false', 'boolean'), literal('true', 'boolean'), literal('false'), uri('urn:false')]) {
  test(`every restoreHold term denies: ${JSON.stringify(hold)}`, async () => {
    const f = fixture(false);
    f.rows.push({ graph: uri(GRAPHS.control), subject: uri(DATASET), predicate: uri(RV + 'restoreHold'), object: hold });
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
    f.rows.push({ ...f.rows.at(-1)!, object: literal('true', 'boolean') });
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
  });
}

test('each retry reads fresh evidence and never touches analyzer facts', async () => {
  const f = fixture();
  expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).not.toBeNull();
  f.rows.find(row => row.subject!.value === MAIN_RELAY_STREAM_SCOPE && row.predicate!.value === RV + 'streamSequence')!.object = literal('1', 'integer');
  expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
  expect(f.reads()).toBe(2); expect(f.queries[0]).toBe(f.queries[1]);
  expect(f.queries[0]).not.toMatch(/DELETE|INSERT|textIndex/);
});

test('SPARQL JSON implicit strings preserve native term identity, implicit integers deny', async () => {
  const f = fixture();
  for (const row of f.rows) if (row.object!.datatype === xsd + 'string') delete row.object!.datatype;
  expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).not.toBeNull();
  delete f.rows.find(row => row.predicate!.value === RV + 'sequence')!.object!.datatype;
  expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
});

for (const column of ['graph', 'subject', 'predicate']) for (const kind of ['literal', 'bnode']) {
  test(`corrupt ${column} ${kind} denies`, async () => {
    const f = fixture(false); f.rows[0]![column] = { ...f.rows[0]![column]!, type: kind };
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
  });
}

for (const change of [
  (e: RestoredGraphReleaseExpectation) => { e.restoreCutover += '-other'; },
  (e: RestoredGraphReleaseExpectation) => { e.saved.dataEpoch = restored; },
  (e: RestoredGraphReleaseExpectation) => { e.effective.dataEpoch = restored; },
  (e: RestoredGraphReleaseExpectation) => { e.saved.graphSequence = '901'; },
  (e: RestoredGraphReleaseExpectation) => { e.effective.graphSequence = '899'; },
  (e: RestoredGraphReleaseExpectation) => { e.saved.graphSequence = '0900'; },
  (e: RestoredGraphReleaseExpectation) => { e.saved.graphSequence = '9'.repeat(16_385); },
  (e: RestoredGraphReleaseExpectation) => { delete e.saved.main; },
  (e: RestoredGraphReleaseExpectation) => { delete e.effective.main; },
  (e: RestoredGraphReleaseExpectation) => { e.effective.main!.sequence = '3'; },
  (e: RestoredGraphReleaseExpectation) => { e.effective.main!.dataEpoch = restored; },
  (e: RestoredGraphReleaseExpectation) => { e.effective.main!.streamScope = 'urn:other'; },
  (e: RestoredGraphReleaseExpectation) => { e.saved.main!.sequence = '900'; },
]) {
  test(`saved/effective expectation mismatch denies: ${change.toString()}`, async () => {
    const f = fixture(); change(f.expectation);
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
  });
}

test('query transport retains its byte bound on an oversized corrupt literal', async () => {
  let bytes = 0;
  const f = fixture();
  const fuseki = { query: async (_query: string, maxBytes: number): Promise<SparqlResult> => {
    bytes = maxBytes; throw new Error('Fuseki response exceeds byte budget');
  } } as unknown as FusekiClient;
  await expect(readRestoredGraphReleaseProof(fuseki, f.expectation)).rejects.toThrow('byte budget');
  expect(bytes).toBe(16_384);
});

for (const paired of [false, true]) for (const advanced of [false, true]) {
  for (const routingEpoch of ['opaque route / α "quoted"', '8'.repeat(200)]) {
    test(`${paired ? 'paired' : 'legacy'} accepts opaque epochs and long ${advanced ? 'reconciled' : 'saved'} canonical cuts with routing ${routingEpoch.slice(0, 24)}`, async () => {
      const f = fixture(paired, advanced, { epoch: 'restored/opaque:β', priorEpoch: 'original/opaque:α', routingEpoch,
        graph: '9'.repeat(120), graphAfter: '1' + '0'.repeat(120), main: '4'.repeat(110), mainAfter: '5'.repeat(110) });
      const proof = await readRestoredGraphReleaseProof(f.fuseki, f.expectation);
      expect(proof).toEqual({ expectation: f.expectation, receipt: { id: f.id, requestDigest: f.requestDigest,
        dataEpoch: f.expectation.lineage.dataEpoch, sequence: '0' } });
      expect(f.reads()).toBe(1);
    });
  }
}

for (const advanced of [false, true]) for (const shape of ['absent', 'old-no-prefix', 'corrupt-unrelated']) {
  test(`legacy ${advanced ? 'reconciled' : 'saved'} proof has no current Main requirement: ${shape}`, async () => {
    const f = fixture(false, advanced);
    if (shape === 'absent') f.rows.splice(0, f.rows.length, ...f.rows.filter(row => row.subject!.value !== MAIN_RELAY_STREAM_SCOPE));
    else {
      f.rows.splice(0, f.rows.length, ...f.rows.filter(row => row.subject!.value !== MAIN_RELAY_STREAM_SCOPE
        || row.predicate!.value !== RV + 'legacyThroughSequence'));
      f.rows.find(row => row.subject!.value === MAIN_RELAY_STREAM_SCOPE && row.predicate!.value === RV + 'dataEpoch')!.object = literal(source);
      if (shape === 'corrupt-unrelated') for (let index = 0; index < 1000; index++) f.rows.push({
        graph: uri(GRAPHS.control), subject: uri(MAIN_RELAY_STREAM_SCOPE), predicate: uri(`https://unknown.test/p${index}`), object: literal('irrelevant') });
    }
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).not.toBeNull();
    expect(f.queries[0]).not.toContain(MAIN_RELAY_STREAM_SCOPE);
  });
}

test('plain expectation projection excludes caller extras and toJSON from digest and returned proof', async () => {
  const f = fixture();
  const projected = structuredClone(f.expectation);
  Object.assign(f.expectation, { extra: 'x'.repeat(100_000), toJSON: () => { throw new Error('caller serialization'); } });
  Object.assign(f.expectation.lineage, { toJSON: () => { throw new Error('lineage serialization'); } });
  const proof = await readRestoredGraphReleaseProof(f.fuseki, f.expectation);
  expect(proof?.expectation).toEqual(projected);
  expect(proof?.receipt.requestDigest).toBe(f.requestDigest);
});

for (const fault of ['one-field', 'aggregate', 'utf8', 'json-escape', 'non-string'] as const) {
  test(`expectation 16KiB bound refuses ${fault} before querying`, async () => {
    const f = fixture();
    if (fault === 'one-field') f.expectation.saved.graphSequence = '1'.repeat(16_385);
    else if (fault === 'aggregate') {
      f.expectation.saved.graphSequence = '1'.repeat(8500);
      f.expectation.effective.graphSequence = '2'.repeat(8500);
    } else if (fault === 'utf8') f.expectation.lineage.routingEpoch = 'α'.repeat(8500);
    else if (fault === 'json-escape') f.expectation.lineage.routingEpoch = '\n'.repeat(8500);
    else f.expectation.lineage.routingEpoch = { toJSON: () => { throw new Error('unsafe serialization'); } } as unknown as string;
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
    expect(f.reads()).toBe(0);
  });
}

for (const bad of ['-1', '01', '1.0', '1e3', '+1', ' 1', '']) {
  test(`canonical nonnegative graph and Main counters refuse ${JSON.stringify(bad)}`, async () => {
    for (const field of ['graph', 'main']) {
      const f = fixture();
      if (field === 'graph') f.expectation.effective.graphSequence = bad;
      else f.expectation.effective.main!.sequence = bad;
      expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).toBeNull();
      expect(f.reads()).toBe(0);
    }
  });
}


test('opaque marker is bound through a quoted string without becoming query syntax', async () => {
  for (const epoch of ['opaque> } UNION { ?s ?p ?o } #', 'opaque"{}|^`\\\n\tβ']) {
    const f = fixture(true, true, { epoch });
    expect(await readRestoredGraphReleaseProof(f.fuseki, f.expectation)).not.toBeNull();
    expect(f.queries[0]).toContain(`BIND(IRI(${JSON.stringify(f.expectation.restoreCutover)}) AS ?subject)`);
    expect(f.queries[0]).not.toContain(`<${f.expectation.restoreCutover}>`);
  }
});
