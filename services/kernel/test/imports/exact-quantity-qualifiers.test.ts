import { expect, test } from 'bun:test';
import { valueSchema } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import type { WikidataConversion } from '../../../../packages/conversion/src/wikidata.ts';
import { createSourceRegistration } from '../../../importer/src/source-registry.ts';
import type { Dump, Run } from '../../../../specs/imports-api-driver.ts';
import { openApiRuntime, type ApiRuntime } from './api-runtime.ts';
import { openApiObserver } from './api-observer.ts';

type Snak = {
  snaktype: string;
  property: string;
  datatype: string;
  datavalue?: { type: string; value: unknown };
};
type Claim = {
  type: string;
  rank: string;
  mainsnak: Snak;
  qualifiers?: Record<string, Snak[]>;
  references?: unknown[];
};
type Entity = {
  id: string;
  lastrevid: number;
  labels: Record<string, { language: string; value: string }>;
  claims: Record<string, Claim[]>;
};
const property = 'schema:wordCount';
const registration = createSourceRegistration('wikidata');
const fixture = new URL('../../../../specs/fixtures/imports/wikidata/entity.json', import.meta.url);
const baseline = (): Promise<Entity> => Bun.file(fixture).json();
const commands = (run: Run): BatchCommand[] =>
  run.exchanges.flatMap((exchange) => (exchange.request.body as { commands: BatchCommand[] }).commands);
const measurements = (run: Run) =>
  commands(run).filter((command) => command.op === 'propose' && command.statement.property.id === property);
function dump(entity: Entity): Dump {
  return {
    source: 'wikidata',
    snapshot: 'controlled-qualification-edge',
    converterRevision: registration.converter_revision,
    bytes: new TextEncoder().encode(`${JSON.stringify(entity)}\n`),
  };
}
function measurement(qualifiers: Record<string, Snak[]>): Claim {
  return {
    type: 'statement',
    rank: 'normal',
    mainsnak: {
      snaktype: 'value',
      property: 'P6570',
      datatype: 'quantity',
      datavalue: { type: 'quantity', value: { amount: '+1450', unit: '1' } },
    },
    qualifiers,
    // The reviewed count has no statement references. The shell's other references survive.
  };
}
const item = (property: string, id: string): Snak => ({
  snaktype: 'value',
  property,
  datatype: 'wikibase-item',
  datavalue: {
    type: 'wikibase-entityid',
    value: { 'entity-type': 'item', 'numeric-id': Number(id.slice(1)), id },
  },
});
function admission() {
  // Inspect the actual shipped producer before any native test. Never patch a release.
  const definition = bundledRelease.properties[property];
  expect(definition).toBeDefined();
  expect(bundledRelease.types['schema:Book']!.properties).toContain(property);
  expect(definition!.mappings).toContain('wd:P6570');
  expect(definition!.datatype).toBe('quantity');
  expect(definition!.value).toEqual(valueSchema('quantity', { exact: true, integer: true, units: ['1'] }));
  expect(definition).not.toHaveProperty('exact');
  expect(definition!.value).not.toHaveProperty('properties.lowerBound');
  expect(definition!.value).not.toHaveProperty('properties.upperBound');
  expect(definition!.qualifiers).toEqual([]);
  expect(definition!.minimum).toBe(0);
  expect(bundledRelease.properties['schema:position']!.mappings).toContain('wd:P1545');
  expect(bundledRelease.properties['wdt:P518']!.targets).toEqual(['wd:Q2620972']);
  expect(Object.values(bundledRelease.properties).some((p) => p.mappings.includes('wd:P459'))).toBe(false);
}
function completed(run: Run) {
  expect(run.outcome).toBe('complete');
  for (const exchange of run.exchanges) {
    expect(exchange.response.status).toBe(200);
    for (const result of (exchange.response.body as BatchWriteResult).results) expect(result.status).toBeLessThan(400);
  }
}
async function candidates(editor: Awaited<ReturnType<typeof openApiObserver>>, id: string) {
  const response = await editor.http(
    `/v1/subjects/${id}/candidates?${new URLSearchParams({ property, limit: '100' })}`,
  );
  expect(response.status).toBe(200);
  expect(response.body.next).toBeNull();
  return response.body.candidates;
}
function diagnosed(run: Run) {
  const conversions = run.conversions as readonly WikidataConversion[];
  expect(conversions.some((output) => output.diagnostics.some((d) => d.pointer.startsWith('/claims/P6570')))).toBe(
    true,
  );
}
async function established(editor: Awaited<ReturnType<typeof openApiObserver>>, entity: Entity) {
  const view = await editor.read('wikidata', entity.id);
  expect(view.subject?.type).toBe('schema:Book');
  for (const id of ['schema:name', 'schema:datePublished', 'schema:url']) {
    const rows = view.proposals.filter((candidate) => candidate.statement?.property.id === id);
    expect(rows.length, id).toBeGreaterThan(0);
    expect(rows.every((candidate) => candidate.references.length > 0)).toBe(true);
  }
  const authors: { statement: BatchStatement }[] = [];
  for (const claim of entity.claims.P50!) {
    const target = (claim.mainsnak.datavalue!.value as { id: string }).id;
    const sameAs = `http://www.wikidata.org/entity/${target}`;
    const response = await editor.http(
      `/v1/subjects/${view.subject!.id}/candidates?${new URLSearchParams({
        property: 'schema:author',
        sameAs,
        limit: '100',
      })}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.next).toBeNull();
    const rows = response.body.candidates as { statement: BatchStatement }[];
    expect(rows.length, sameAs).toBeGreaterThan(0);
    for (const candidate of rows) {
      expect(candidate.statement.property.id).toBe('schema:author');
      expect(candidate.statement.value).toEqual({ type: 'somevalue' });
      expect(
        candidate.statement.qualifiers?.some(
          (part) =>
            part.property.id === 'schema:sameAs' && part.value.type === 'value' && part.value.content === sameAs,
        ),
      ).toBe(true);
      expect((candidate.statement.references?.length ?? 0) > 0).toBe(true);
    }
    authors.push(...rows);
  }
  expect(authors.length).toBeGreaterThan(0);
  expect(JSON.stringify([...view.proposals, ...authors])).toContain('https://catalogue.example.org/books/example');
  return view;
}

test('exact P6570 with mapped but unadmitted P1545 withholds the entire native measurement', async () => {
  admission();
  const entity = await baseline();
  // Existing fixture string qualifier, deliberately on a property that does not admit it.
  entity.claims.P6570 = [measurement(structuredClone(entity.claims.P50![0]!.qualifiers!))];
  const input = dump(entity);
  const before = input.bytes.slice();
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const editor = await openApiObserver(runtime);
    const run = await runtime.run(input);
    completed(run);
    const view = await established(editor, entity);
    const native = await candidates(editor, view.subject!.id);
    expect(input.bytes).toEqual(before);
    diagnosed(run);
    expect(measurements(run)).toEqual([]);
    expect(native).toEqual([]);
  } finally {
    await runtime.close();
  }
}, 600_000);

test('reviewed letter P6570 transplanted into a controlled Book cannot lose P459 method or narrow P518 text scope', async () => {
  admission();
  const entity = await baseline();
  // Explicit transplant of Q55867126 rev1717031358's assertion shape, NOT observed Book data.
  // External QIDs are evidence only: no target UUID, binding or StoryArc surrogate.
  entity.claims.P6570 = [measurement({ P459: [item('P459', 'Q718390')], P518: [item('P518', 'Q63246861')] })];
  const input = dump(entity);
  const original = input.bytes.slice();
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const editor = await openApiObserver(runtime);
    const run = await runtime.run(input);
    completed(run);
    const view = await established(editor, entity);
    const native = await candidates(editor, view.subject!.id);
    expect(input.bytes).toEqual(original);
    expect(entity.claims.P6570[0]).not.toHaveProperty('references');
    diagnosed(run);
    expect(measurements(run)).toEqual([]);
    expect(native).toEqual([]);
  } finally {
    await runtime.close();
  }
}, 600_000);

async function receiptRow(runtime: ApiRuntime, key: string) {
  const identity = await runtime.receipt(key);
  expect(identity).not.toBeNull();
  const locator = JSON.parse(identity!) as {
    partition_no: number;
    principal_kind: string;
    principal_id: string;
    command_kind: string;
    idempotency_key: string;
  };
  // Immutable receipt observation by the actual returned command's complete native PK only.
  const result = await runtime.database.admin.query<{ receipt: unknown }>(
    `SELECT to_jsonb(r) AS receipt FROM core.receipt r
     WHERE partition_no=$1 AND principal_kind=$2 AND principal_id=$3 AND command_kind=$4 AND idempotency_key=$5`,
    [locator.partition_no, locator.principal_kind, locator.principal_id, locator.command_kind, locator.idempotency_key],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!.receipt;
}

test('native Book refresh rejects unsupported qualified exact count while preserving bootstrap receipt and changed established facts', async () => {
  admission();
  const entity = await baseline();
  const input = dump(entity);
  const original = input.bytes.slice();
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65536 });
  try {
    const editor = await openApiObserver(runtime);
    const first = await runtime.run(input);
    completed(first);
    const old = await established(editor, entity);
    expect(await candidates(editor, old.subject!.id)).toEqual([]);
    const bootstrap = commands(first).find((command) => command.op === 'create')!;
    const exchange = first.exchanges.find((entry) => entry.request.keys.includes(bootstrap.key))!;
    const bytes = exchange.request.serializedBody;
    const ack = (exchange.response.body as BatchWriteResult).results.find((entry) => entry.key === bootstrap.key)!;
    const oldAck = structuredClone(ack);
    const oldReceipt = await receiptRow(runtime, bootstrap.key);
    const oldClaim = runtime.importer.session.bindings.claim({ source: 'wikidata', external_id: entity.id });
    expect(oldClaim).toEqual({ state: 'bound', subject: old.subject!.id });

    const changed = structuredClone(entity);
    changed.lastrevid += 1; // Native source change; registration and source identity stay real and stable.
    changed.labels.en!.value = 'Controlled revised qualification-edge Book';
    changed.claims.P577![0]!.mainsnak.datavalue!.value = {
      ...(changed.claims.P577![0]!.mainsnak.datavalue!.value as Record<string, unknown>),
      time: '+2002-03-04T00:00:00Z',
    };
    changed.claims.P856![0]!.mainsnak.datavalue!.value = 'https://books.example.org/revised';
    // Real source method key, explicitly unknown. It cannot silently disappear at projection.
    changed.claims.P6570 = [
      measurement({ P459: [{ snaktype: 'somevalue', property: 'P459', datatype: 'wikibase-item' }] }),
    ];
    const changedInput = dump(changed);
    const changedBytes = changedInput.bytes.slice();
    const refresh = await runtime.run(changedInput);
    completed(refresh);
    const view = await established(editor, changed);
    expect(view.subject!.id).toBe(old.subject!.id);
    const fresh = view.proposals.filter((candidate) => candidate.recordRevision === String(changed.lastrevid));
    expect(
      fresh.some(
        (candidate) =>
          candidate.statement?.property.id === 'schema:name' &&
          (candidate.statement.value.content as { text: string }).text === changed.labels.en!.value,
      ),
    ).toBe(true);
    expect(
      fresh.some(
        (candidate) =>
          candidate.statement?.property.id === 'schema:url' &&
          candidate.statement.value.content === 'https://books.example.org/revised',
      ),
    ).toBe(true);
    expect(
      fresh.some(
        (candidate) =>
          candidate.statement?.property.id === 'schema:datePublished' &&
          (candidate.statement.value.content as { time: string }).time === '+2002-03-04T00:00:00Z',
      ),
    ).toBe(true);
    expect(fresh.every((candidate) => candidate.converterRevision === registration.converter_revision)).toBe(true);
    const native = await candidates(editor, view.subject!.id);
    const effects = await editor.effects();
    await runtime.restart();
    completed(await runtime.run(changedInput));
    expect(await editor.effects()).toEqual(effects);
    expect(await candidates(editor, view.subject!.id)).toEqual(native);
    expect(runtime.importer.session.bindings.claim({ source: 'wikidata', external_id: entity.id })).toEqual(oldClaim);
    const replay = await runtime.replay(
      new Request(exchange.request.url, {
        method: exchange.request.method,
        headers: exchange.request.headers,
        body: bytes,
      }),
    );
    expect(replay.status).toBe(200);
    const replayed = (await replay.json()) as BatchWriteResult;
    expect(replayed.results.find((entry) => entry.key === bootstrap.key)).toEqual(oldAck);
    expect(await editor.effects()).toEqual(effects);
    expect(await receiptRow(runtime, bootstrap.key)).toEqual(oldReceipt);
    expect(exchange.request.serializedBody).toBe(bytes);
    expect(JSON.parse(bytes).commands.find((command: BatchCommand) => command.key === bootstrap.key)).toEqual(
      bootstrap,
    );
    expect(ack).toEqual(oldAck);
    expect(input.bytes).toEqual(original);
    expect(changedInput.bytes).toEqual(changedBytes);
    // Rejection checks last: refresh/reopen/receipt evidence is collected even on the unsafe base.
    expect(measurements(refresh)).toEqual([]);
    expect(native).toEqual([]);
    diagnosed(refresh);
  } finally {
    await runtime.close();
  }
}, 600_000);
