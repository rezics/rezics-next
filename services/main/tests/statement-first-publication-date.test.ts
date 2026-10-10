import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DataFactory, Parser, Store } from 'n3';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { InvalidContextCommand } from '../src/modules/context/command.ts';
import { recordStatement, recordStatementRequest, type RecordStatementInput } from '../src/modules/statement/graph.ts';
import {
  DATE_PUBLISHED_DEFINITION_NOTATION, DATE_PUBLISHED_PREDICATE,
} from '../src/modules/statement/qualification.ts';
import { PROFILES, definitionKindIri, type DefinitionKind } from '../src/modules/semantic/schema.ts';
import {
  DATASET, GRAPHS, prepareComponent, RV, type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const directory = resolve('.temp', `statement-first-publication-${Bun.randomUUIDv7()}`);
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const named = DataFactory.namedNode;
const uri = (value: string) => ({ type: 'uri' as const, value });
const literal = (value: string) => ({ type: 'literal' as const, value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });

function admission(request: { action: string; scope: string; digest: string }): RegisteredAdmission {
  return {
    id: Bun.randomUUIDv7(), principalId: Bun.randomUUIDv7(), actingSubject: id(4),
    scope: request.scope, action: request.action, idempotencyKey: Bun.randomUUIDv7(),
    requestDigest: request.digest, authorityEpoch: '1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed', dispatchEligible: true, replayed: false,
  };
}

const dateValue = (lexical: string, datatype: string): RecordStatementInput['value'] => ({
  kind: 'literal', lexical, datatype, language: null,
});

function request(predicate: string, relationDefinition: string, value: RecordStatementInput['value'],
  subject = id(1)): RecordStatementInput {
  return {
    speaker: { kind: 'personal' }, subject, predicate, relationDefinition, value,
    applicability: [], interpretation: { kind: 'selected' }, evidence: [id(9)], actingSubject: id(4),
  };
}

/** Command transport stores the insert; definition manifests are the sealed revisions the binding reads. */
function fixture() {
  const objectDirectory = join(directory, Bun.randomUUIDv7());
  const store = new Store();
  let sequence = 0;
  const definitions = new Map<string, { definition: string; manifest: string; kind: DefinitionKind; lifecycle: string; head: string }>();
  const graph = new FusekiClient('http://unused.invalid');
  const env: WorkActivationEnvironment = {
    fuseki: graph, objectDirectory,
    lineage: { dataEpoch: '00000000-0000-4000-8000-000000000001', routingEpoch: '1' },
  };
  const one = (graphName: string, subject: string, predicate: string) =>
    store.getObjects(named(subject), named(predicate), named(graphName))[0];
  const binding = (value: { value: string }) => uri(value.value);
  graph.commandHealth = async () => ({
    moduleVersion: 'fixture', instanceId: 'fixture', publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    profiles: Object.fromEntries(Object.entries(profileRegistry).map(([name, profile]) => [name, profile.sha256])),
  });
  graph.query = async (text) => {
    if (text.includes('ASK')) return { boolean: !text.includes('rv:rejectionKind rv:InvalidProfile') };
    if (text.includes('SELECT ?outcome ?reason ?digest')) {
      const receipt = text.match(/GRAPH <urn:rezics:graph:receipts>\s*\{\s*<([^>]+)>/)?.[1];
      if (!receipt) throw new Error('Receipt query does not name its exact receipt');
      const fields: Record<string, string> = {
        outcome: `${RV}outcome`, digest: `${RV}requestDigest`, id: `${RV}admissionId`,
        epoch: `${RV}authorityEpoch`, scope: `${RV}admittedScope`, dataEpoch: `${RV}dataEpoch`,
        sequence: `${RV}sequence`, operation: `${RV}operation`, component: `${RV}component`,
        revision: `${RV}revision`,
      };
      const row: Row = {};
      for (const [key, predicate] of Object.entries(fields)) {
        const value = one(GRAPHS.receipts, receipt, predicate);
        if (value) row[key] = binding(value);
      }
      const sequenceValue = one(GRAPHS.receipts, receipt, `${RV}sequence`);
      if (sequenceValue) row.sequence = literal(sequenceValue.value);
      const digest = one(GRAPHS.receipts, receipt, `${RV}requestDigest`);
      if (digest) row.digest = literal(digest.value);
      const epoch = one(GRAPHS.receipts, receipt, `${RV}authorityEpoch`);
      if (epoch) row.epoch = literal(epoch.value);
      const scope = one(GRAPHS.receipts, receipt, `${RV}admittedScope`);
      if (scope) row.scope = literal(scope.value);
      const dataEpoch = one(GRAPHS.receipts, receipt, `${RV}dataEpoch`);
      if (dataEpoch) row.dataEpoch = literal(dataEpoch.value);
      return rows(row.outcome ? [row] : []);
    }
    if (text.includes('SELECT ?revision ?definition ?manifest')) {
      return rows([...definitions].filter(([revision]) => text.includes(`<${revision}>`)).map(([revision, value]) => ({
        revision: uri(revision), definition: uri(value.definition), manifest: uri(value.manifest),
        kind: uri(definitionKindIri(value.kind)), lifecycle: uri(value.lifecycle), head: uri(value.head),
      })));
    }
    if (text.includes('SELECT ?subject ?frame')) return rows([]);
    throw new Error(`Unmocked Statement query: ${text}`);
  };
  graph.commandWithReceipt = async (envelope: CommandEnvelope) => {
    const insert = envelope.update.match(/INSERT\s*\{([\s\S]*?)\}\s*WHERE\s*\{/)?.[1];
    if (!insert) throw new Error('Command has no bounded INSERT');
    sequence += 1;
    const prefix = `PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>`;
    store.addQuads(new Parser({ format: 'TriG' }).parse(
      `${prefix}\n${insert.replaceAll('?next', String(sequence)).replaceAll('?n', String(sequence - 1))}`,
    ));
    return { status: 'committed', position: { datasetId: DATASET, dataEpoch: env.lineage.dataEpoch, sequence: String(sequence) } };
  };
  function define(revision: string, definition: string, kind: DefinitionKind, notation?: string) {
    const manifest = prepareComponent(objectDirectory, definition, {
      component: 'definition', kind, lifecycle: 'active', successor: null, roles: [],
      ...(notation ? { notation } : {}),
    }, PROFILES.definition);
    definitions.set(revision, {
      definition, kind, manifest: `urn:rezics:sha256:${manifest}`, lifecycle: `${RV}Active`, head: revision,
    });
  }
  define(id(3), id(2), 'property', DATE_PUBLISHED_DEFINITION_NOTATION);
  define(id(13), id(12), 'property', 'episode-count');
  const predicateOf = (statement: string) => one(GRAPHS.current, statement, `${RDF}predicate`)?.value;
  const statementCount = () => store.getSubjects(named(`${RDF}type`), named(`${RDF}Statement`), named(GRAPHS.current)).length;
  const record = (input: RecordStatementInput) => {
    const plan = recordStatementRequest(input);
    return recordStatement(env, admission(plan), input, { kind: 'personal' });
  };
  return { predicateOf, record, statementCount };
}

test('the first-publication notation stores schema:datePublished and keeps the relation pin', async () => {
  const f = fixture();
  const dated = await f.record(request(id(2), id(3), dateValue('1980-01-01', `${XSD}date`)));
  const year = await f.record(request(id(2), id(3), dateValue('1980', `${XSD}gYear`), id(5)));
  expect(dated.outcome).toBe('succeeded');
  expect(year.outcome).toBe('succeeded');
  expect(f.predicateOf(dated.component!)).toBe(DATE_PUBLISHED_PREDICATE);
  expect(f.predicateOf(year.component!)).toBe(DATE_PUBLISHED_PREDICATE);
});

test('any other property stores the caller component', async () => {
  const f = fixture();
  const counted = await f.record(request(id(12), id(13), dateValue('12', `${XSD}integer`), id(6)));
  expect(counted.outcome).toBe('succeeded');
  expect(f.predicateOf(counted.component!)).toBe(id(12));
});

test('a non-date first-publication value is refused', async () => {
  const f = fixture();
  const input = request(id(2), id(3), dateValue('1980', `${XSD}string`));
  await expect(f.record(input)).rejects.toBeInstanceOf(InvalidContextCommand);
  expect(f.statementCount()).toBe(0);
});
