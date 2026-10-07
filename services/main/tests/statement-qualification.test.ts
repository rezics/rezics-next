import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DataFactory, Parser, Store, type Term } from 'n3';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import {
  FusekiClient,
  type CommandEnvelope,
  type SparqlResult,
} from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import {
  commandReceiptIri,
  ContextCommandUnavailable,
  InvalidContextCommand,
  runAdmittedCommand,
  type ContextCommandReceipt,
} from '../src/modules/context/command.ts';
import {
  objectTerm,
  recordStatement,
  recordStatementRequest,
  STATEMENT_FAMILIES,
  withdrawStatement,
  withdrawStatementRequest,
  type RecordStatementInput,
} from '../src/modules/statement/graph.ts';
import {
  readPublicStatementsAt,
  readStatement,
  StatementBatchUnavailable,
} from '../src/modules/statement/read.ts';
import {
  normalizeStatementQualification,
  QUALIFICATION_DEFINITION_NOTATION,
  validateStatementDefinitions,
  validateStatementInterpretationDefinition,
  statementQualificationFromBindings,
  type StatementQualification,
} from '../src/modules/statement/qualification.ts';
import {
  statementMeaningKey,
  type StatementMeaning,
  type StatementValue,
} from '../src/modules/statement/schema.ts';
import {
  PROFILES,
  definitionKindIri,
  type DefinitionKind,
} from '../src/modules/semantic/schema.ts';
import {
  DATASET,
  GRAPHS,
  hash,
  IdempotencyConflict,
  prepareComponent,
  RV,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const directory = resolve('.temp', `statement-qualification-${Bun.randomUUIDv7()}`);
mkdirSync(directory, { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const named = DataFactory.namedNode;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
function binding(value: Term): Row[string] {
  if (value.termType === 'NamedNode') return uri(value.value);
  if (value.termType !== 'Literal')
    throw new Error('Fixture only admits RDF resources and literals');
  return {
    type: 'literal',
    value: value.value,
    datatype: value.datatype.value,
    ...(value.language ? { 'xml:lang': value.language } : {}),
  };
}
const meaning = (): StatementMeaning => ({
  subject: id(1),
  predicate: id(2),
  relationDefinition: id(3),
  interpretationDefinitions: [],
  value: { kind: 'literal', lexical: '001', datatype: `${XSD}integer`, language: null },
  applicability: [],
});
const input = (): RecordStatementInput => ({
  speaker: { kind: 'personal' },
  subject: id(1),
  predicate: id(2),
  relationDefinition: id(3),
  value: meaning().value,
  applicability: [],
  interpretation: { kind: 'selected' },
  evidence: [id(9)],
  actingSubject: id(4),
});
const qualification = (): StatementQualification => ({
  definition: id(7),
  interpretationContext: 'urn:example:interpretation:edition-annotation',
  valuePrecision: 'approximate',
  valueQualifiers: ['disputed-attribution', 'inferred'],
  validFrom: '2026-01-01T00:00:00.000Z',
  validUntil: '2027-01-01T00:00:00.000Z',
  editionScope: 'https://example.test/edition/first',
});

function admission(
  request: { action: string; scope: string; digest: string },
  actor = id(4),
): RegisteredAdmission {
  return {
    id: Bun.randomUUIDv7(),
    principalId: Bun.randomUUIDv7(),
    actingSubject: actor,
    scope: request.scope,
    action: request.action,
    idempotencyKey: Bun.randomUUIDv7(),
    requestDigest: request.digest,
    authorityEpoch: '1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'claimed',
    dispatchEligible: true,
    replayed: false,
  };
}

/** The transport mock stores command RDF and exact objects; application validation and receipts run unchanged. */
function fixture() {
  const objectDirectory = join(directory, Bun.randomUUIDv7());
  const store = new Store();
  const commands: CommandEnvelope[] = [];
  const queries: string[] = [];
  const definitions = new Map<
    string,
    { definition: string; manifest: string; kind: DefinitionKind; lifecycle: string; head: string }
  >();
  let sequence = 0;
  let loseAcknowledgement = false;
  const graph = new FusekiClient('http://unused.invalid');
  const env: WorkActivationEnvironment = {
    fuseki: graph,
    objectDirectory,
    lineage: { dataEpoch: '00000000-0000-4000-8000-000000000001', routingEpoch: '1' },
  };
  const objects = (graphName: string, subject: string, predicate: string) =>
    store.getObjects(named(subject), named(predicate), named(graphName));
  const one = (graphName: string, subject: string, predicate: string) =>
    objects(graphName, subject, predicate)[0];
  // Snapshot before synchronous deletion; streaming removals can consume a later replacement.
  const remove = (graphName: string, subject: string, predicate: string) =>
    store.removeQuads(store.getQuads(named(subject), named(predicate), null, named(graphName)));
  const fields = (graphName: string, subject: string, mapping: Record<string, string>): Row =>
    Object.fromEntries(
      Object.entries(mapping).flatMap(([key, predicate]) => {
        const value = one(graphName, subject, predicate);
        return value ? [[key, binding(value)]] : [];
      }),
    );
  const receiptRow = (receipt: string) =>
    fields(GRAPHS.receipts, receipt, {
      outcome: `${RV}outcome`,
      reason: `${RV}reason`,
      digest: `${RV}requestDigest`,
      id: `${RV}admissionId`,
      epoch: `${RV}authorityEpoch`,
      scope: `${RV}admittedScope`,
      dataEpoch: `${RV}dataEpoch`,
      sequence: `${RV}sequence`,
      operation: `${RV}operation`,
      component: `${RV}component`,
      revision: `${RV}revision`,
      expectedHead: `${RV}expectedHead`,
    });
  const currentRow = (statement: string): Row => {
    const row = fields(GRAPHS.current, statement, {
      subject: `${RDF}subject`,
      predicate: `${RDF}predicate`,
      object: `${RDF}object`,
      relation: `${RV}relationDefinition`,
      speaker: `${RV}speaker`,
      key: `${RV}meaningKey`,
      state: `${RV}statementState`,
      head: `${RV}head`,
      pin: `${RV}semanticContextRevision`,
      definition: `${RV}interpretationDefinition`,
      qualificationDefinition: `${RV}qualificationDefinition`,
      qualificationContext: `${RV}interpretationContext`,
      precision: `${RV}valuePrecision`,
      qualifier: `${RV}valueQualifier`,
      validFrom: `${RV}validFrom`,
      validUntil: `${RV}validUntil`,
      edition: `${RV}editionScope`,
    });
    if (row.head)
      Object.assign(
        row,
        fields(GRAPHS.revisions, row.head.value, {
          operation: `${RV}operation`,
          recordedBy: `${RV}recordedBy`,
          manifest: `${RV}manifest`,
        }),
        { headRevision: row.head },
      );
    return { ...row, epoch: literal(env.lineage.dataEpoch), sequence: literal(String(sequence)) };
  };
  graph.commandHealth = async () => ({
    moduleVersion: 'fixture',
    instanceId: 'fixture',
    publicSearchWriteEpoch: '0',
    publicSearchWriteActive: false,
    profiles: Object.fromEntries(
      Object.entries(profileRegistry).map(([name, profile]) => [name, profile.sha256]),
    ),
  });
  graph.query = async (text) => {
    queries.push(text);
    if (text.includes('ASK'))
      return { boolean: !text.includes('rv:rejectionKind rv:InvalidProfile') };
    if (text.includes('SELECT ?outcome ?reason ?digest')) {
      const receipt = text.match(/GRAPH <urn:rezics:graph:receipts>\s*\{\s*<([^>]+)>/)?.[1];
      if (!receipt) throw new Error('Receipt query does not name its exact receipt');
      const row = receiptRow(receipt);
      return rows(row.outcome ? [row] : []);
    }
    if (text.includes('SELECT ?revision ?definition ?manifest')) {
      return rows(
        [...definitions]
          .filter(([revision]) => text.includes(`<${revision}>`))
          .map(([revision, value]) => ({
            revision: uri(revision),
            definition: uri(value.definition),
            manifest: uri(value.manifest),
            kind: uri(definitionKindIri(value.kind)),
            lifecycle: uri(value.lifecycle),
            head: uri(value.head),
          })),
      );
    }
    if (text.includes('SELECT ?definition ?manifest')) {
      return rows(
        [...definitions]
          .filter(([revision]) => text.includes(`<${revision}>`))
          .map(([, value]) => ({
            definition: uri(value.definition),
            manifest: uri(value.manifest),
          })),
      );
    }
    if (text.includes('SELECT ?subject ?frame')) return rows([]);
    if (text.includes('SELECT ?head ?state')) {
      const statement = text.match(/GRAPH <urn:rezics:graph:current>\s*\{\s*<([^>]+)>/)?.[1];
      if (!statement) throw new Error('Withdrawal query does not name its Statement');
      return rows([
        fields(GRAPHS.current, statement, { head: `${RV}head`, state: `${RV}statementState` }),
      ]);
    }
    if (text.includes('SELECT ?manifest ?state ?operation ?recordedBy ?epoch ?sequence')) {
      const revision = text.match(/GRAPH <urn:rezics:graph:revisions>\s*\{\s*<([^>]+)>/)?.[1];
      if (!revision) throw new Error('Historical read does not name its exact revision');
      const component = one(GRAPHS.revisions, revision, `${RV}component`);
      if (!component || !text.includes(`rv:component <${component.value}>`)) return rows([]);
      const row = fields(GRAPHS.revisions, revision, {
        manifest: `${RV}manifest`,
        state: `${RV}statementState`,
        operation: `${RV}operation`,
        recordedBy: `${RV}recordedBy`,
        epoch: `${RV}dataEpoch`,
        sequence: `${RV}sequence`,
      });
      return rows(row.manifest ? [row] : []);
    }
    if (text.includes('SELECT ?epoch ?sequence ?subject ?predicate ?object')) {
      const statement = text.match(
        /GRAPH <urn:rezics:graph:current>\s*\{\s*<([^>]+)> a rdf:Statement/,
      )?.[1];
      if (!statement) throw new Error('Read query does not name its Statement');
      const current = currentRow(statement);
      const qualifiers = objects(GRAPHS.current, statement, `${RV}valueQualifier`);
      const manifests = current.head
        ? objects(GRAPHS.revisions, current.head.value, `${RV}manifest`)
        : [];
      const variants = manifests.length
        ? manifests.map((manifest) => ({ ...current, manifest: binding(manifest) }))
        : [current];
      return rows(
        variants.flatMap((row) =>
          qualifiers.length
            ? qualifiers.map((value) => ({ ...row, qualifier: binding(value) }))
            : [row],
        ),
      );
    }
    if (text.includes('SELECT ?epoch ?sequence ?statement ?subject ?predicate ?object')) {
      const statements = store.getSubjects(
        named(`${RDF}type`),
        named(`${RDF}Statement`),
        named(GRAPHS.current),
      );
      return rows(
        statements
          .filter((statement) => text.includes(`<${statement.value}>`))
          .map((statement) => {
            const {
              qualifier: _qualifier,
              definition: _definition,
              ...row
            } = currentRow(statement.value);
            return {
              ...row,
              statement: uri(statement.value),
              definitions: literal(
                objects(GRAPHS.current, statement.value, `${RV}interpretationDefinition`)
                  .map((value) => value.value)
                  .join('|'),
              ),
              applicability: literal(
                objects(GRAPHS.current, statement.value, `${RV}applicability`)
                  .map((value) => value.value)
                  .join('|'),
              ),
              valueQualifiers: literal(
                objects(GRAPHS.current, statement.value, `${RV}valueQualifier`)
                  .map((value) => value.value)
                  .join('|'),
              ),
            };
          }),
      );
    }
    throw new Error(`Unmocked Statement query: ${text}`);
  };
  graph.commandWithReceipt = async (envelope) => {
    commands.push(envelope);
    const insert = envelope.update.match(/INSERT\s*\{([\s\S]*?)\}\s*WHERE\s*\{/)?.[1];
    if (!insert) throw new Error('Command has no bounded INSERT');
    const remove = envelope.update.match(/DELETE\s*\{([\s\S]*?)\}\s*INSERT\s*\{/)?.[1];
    const prefix = `PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>`;
    const parse = (value: string, position: number) =>
      new Parser({ format: 'TriG' }).parse(
        `${prefix}\n${value.replaceAll('?next', String(position)).replaceAll('?n', String(sequence))}`,
      );
    if (remove) store.removeQuads(parse(remove, sequence));
    sequence++;
    store.addQuads(parse(insert, sequence));
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error('Lost command acknowledgement');
    }
    return {
      status: 'committed',
      position: {
        datasetId: DATASET,
        dataEpoch: env.lineage.dataEpoch,
        sequence: String(sequence),
      },
    };
  };
  function define(revision: string, definition: string, kind: DefinitionKind, notation?: string) {
    const manifest = prepareComponent(
      objectDirectory,
      definition,
      {
        component: 'definition',
        kind,
        lifecycle: 'active',
        successor: null,
        roles:
          kind === 'relation'
            ? [
                { key: 'subject', minParticipants: 1, maxParticipants: 1, ordered: false },
                { key: 'object', minParticipants: 1, maxParticipants: 1, ordered: false },
              ]
            : [],
        ...(notation ? { notation } : {}),
      },
      PROFILES.definition,
    );
    definitions.set(revision, {
      definition,
      kind,
      manifest: `urn:rezics:sha256:${manifest}`,
      lifecycle: `${RV}Active`,
      head: revision,
    });
  }
  define(id(3), id(2), 'property');
  define(id(7), id(6), 'interpretation', QUALIFICATION_DEFINITION_NOTATION);
  return {
    env,
    graph,
    commands,
    queries,
    store,
    definitions,
    define,
    one,
    remove,
    currentRow,
    loseNextAcknowledgement: () => {
      loseAcknowledgement = true;
    },
    payload(revision: string) {
      const manifest = one(GRAPHS.revisions, revision, `${RV}manifest`);
      if (!manifest) throw new Error('Retained Statement manifest is missing');
      const metadata = JSON.parse(
        readFileSync(
          join(objectDirectory, manifest.value.slice('urn:rezics:sha256:'.length)),
          'utf8',
        ),
      );
      return JSON.parse(
        readFileSync(join(objectDirectory, metadata.payload.slice('sha256:'.length)), 'utf8'),
      ).state;
    },
  };
}

test('unqualified Statement meaning retains the exact v1 byte transcript', () => {
  const legacy =
    '["statement-meaning-v1","https://rezics.com/id/00000000-0000-4000-8000-000000000001","https://rezics.com/id/00000000-0000-4000-8000-000000000002","https://rezics.com/id/00000000-0000-4000-8000-000000000003",[],["literal","001","http://www.w3.org/2001/XMLSchema#integer",null],[]]';
  expect(statementMeaningKey(meaning())).toBe(`urn:rezics:meaning:${hash(legacy)}`);
});

test('RDF lexical spelling, datatype and language remain distinct Statement meanings', () => {
  const values: StatementValue[] = [
    { kind: 'literal', lexical: '001', datatype: `${XSD}integer`, language: null },
    { kind: 'literal', lexical: '1', datatype: `${XSD}integer`, language: null },
    { kind: 'literal', lexical: '001', datatype: `${XSD}string`, language: null },
    { kind: 'literal', lexical: '001', datatype: `${RDF}langString`, language: 'en' },
    { kind: 'literal', lexical: '001', datatype: `${RDF}langString`, language: 'fr' },
  ];
  expect(new Set(values.map((value) => statementMeaningKey({ ...meaning(), value }))).size).toBe(
    values.length,
  );
  expect(objectTerm(values[0]!)).toBe('"001"^^<http://www.w3.org/2001/XMLSchema#integer>');
  expect(objectTerm(values[3]!)).toBe('"001"@en');
  const legacyLanguage =
    '["statement-meaning-v1","https://rezics.com/id/00000000-0000-4000-8000-000000000001","https://rezics.com/id/00000000-0000-4000-8000-000000000002","https://rezics.com/id/00000000-0000-4000-8000-000000000003",[],["literal","001","http://www.w3.org/2001/XMLSchema#string","en"],[]]';
  expect(
    statementMeaningKey({
      ...meaning(),
      value: { kind: 'literal', lexical: '001', datatype: `${XSD}string`, language: 'en' },
    }),
  ).toBe(`urn:rezics:meaning:${hash(legacyLanguage)}`);
  const incoherent: StatementValue = {
    kind: 'literal',
    lexical: 'x',
    datatype: `${XSD}integer`,
    language: 'en',
  };
  expect(() =>
    recordStatementRequest({ ...input(), value: incoherent, qualification: qualification() }),
  ).toThrow();
  expect(() =>
    recordStatementRequest({
      ...input(),
      value: incoherent,
      interpretation: { kind: 'definition', definition: id(12) },
    }),
  ).toThrow();
});

test('every authored qualification field and its exact reviewed definition changes meaning', () => {
  const qualified = { ...meaning(), qualification: qualification() };
  const original = statementMeaningKey(qualified);
  expect(original).not.toBe(statementMeaningKey(meaning()));
  const changes: Partial<StatementQualification>[] = [
    { definition: id(8) },
    { interpretationContext: 'urn:example:interpretation:other' },
    { valuePrecision: 'exact' },
    { valueQualifiers: ['inferred'] },
    { validFrom: null },
    { validUntil: null },
    { editionScope: null },
  ];
  const keys = changes.map((change) =>
    statementMeaningKey({ ...qualified, qualification: { ...qualified.qualification, ...change } }),
  );
  expect(new Set([original, ...keys]).size).toBe(changes.length + 1);
  expect(
    statementMeaningKey({
      ...qualified,
      qualification: {
        ...qualified.qualification,
        valueQualifiers: ['inferred', 'disputed-attribution'],
      },
    }),
  ).toBe(original);
  expect(
    statementMeaningKey({
      ...qualified,
      qualification: { ...qualified.qualification, validFrom: '2026-01-01T00:00:00Z' },
    }),
  ).toBe(original);
  expect(statementMeaningKey({ ...meaning(), qualification: undefined })).toBe(
    statementMeaningKey(meaning()),
  );
  const authored: RecordStatementInput = { ...input(), qualification: qualification() };
  expect(
    recordStatementRequest({
      ...authored,
      qualification: {
        ...qualification(),
        valueQualifiers: ['inferred', 'disputed-attribution'],
        validFrom: '2026-01-01T00:00:00Z',
      },
    }).digest,
  ).toBe(recordStatementRequest(authored).digest);
});

test('qualification is a complete finite bundle with a nonempty half-open UTC interval', () => {
  expect(
    normalizeStatementQualification({
      ...qualification(),
      validFrom: null,
      validUntil: null,
      editionScope: null,
    }),
  ).toMatchObject({ validFrom: null, validUntil: null, editionScope: null });
  const { validUntil: _until, ...missing } = qualification();
  for (const invalid of [
    null,
    {},
    missing,
    { ...qualification(), unsupported: true },
    { ...qualification(), valuePrecision: 'rounded' },
    { ...qualification(), valueQualifiers: ['inferred', 'inferred'] },
    { ...qualification(), valueQualifiers: ['unverified'] },
    { ...qualification(), validFrom: '2026-02-30T00:00:00Z' },
    { ...qualification(), validFrom: '2026-01-01T08:00:00+08:00' },
    { ...qualification(), validUntil: qualification().validFrom },
    { ...qualification(), validUntil: '2025-01-01T00:00:00.000Z' },
  ]) {
    expect(() => normalizeStatementQualification(invalid)).toThrow(InvalidContextCommand);
  }
});

test('partial or ambiguous qualification bindings never become an unqualified read', () => {
  const complete: Row = {
    qualificationDefinition: uri(id(7)),
    qualificationContext: uri(qualification().interpretationContext),
    precision: uri(`${RV}ApproximateValue`),
    qualifier: uri(`${RV}InferredValue`),
    validFrom: { ...literal(qualification().validFrom!), datatype: `${XSD}dateTime` },
    validUntil: { ...literal(qualification().validUntil!), datatype: `${XSD}dateTime` },
    edition: uri(qualification().editionScope!),
  };
  expect(statementQualificationFromBindings([complete])).toEqual({
    ...qualification(),
    valueQualifiers: ['inferred'],
  });
  expect(statementQualificationFromBindings([{}])).toBeUndefined();
  for (const field of ['qualificationDefinition', 'qualificationContext', 'precision']) {
    const partial = { ...complete };
    delete partial[field];
    expect(() => statementQualificationFromBindings([partial])).toThrow(ContextCommandUnavailable);
  }
  for (const change of [
    { precision: uri(`${RV}RoundedValue`) },
    { qualifier: uri(`${RV}Unverified`) },
    { validFrom: { ...literal(qualification().validFrom!), datatype: `${XSD}string` } },
  ]) {
    expect(() => statementQualificationFromBindings([{ ...complete, ...change }])).toThrow(
      ContextCommandUnavailable,
    );
  }
  expect(() =>
    statementQualificationFromBindings([
      complete,
      { ...complete, qualificationContext: uri('urn:example:different-context') },
    ]),
  ).toThrow(ContextCommandUnavailable);
});

test('an exact predicate and the qualification notation bind their retained semantic definitions', async () => {
  const f = fixture();
  const request = { predicate: id(2), relationDefinition: id(3), qualification: qualification() };
  const accepted = await validateStatementDefinitions(f.env, request);
  expect(accepted.guard).toContain(`<${id(2)}> a rv:SemanticDefinition`);
  expect(accepted.guard).toContain(`rv:definitionHead <${id(3)}>`);
  expect(accepted.guard).toContain(`rv:definitionHead <${id(7)}>`);
  expect(accepted.guard).toContain('rv:lifecycle rv:Active');
  await expect(
    validateStatementDefinitions(f.env, { ...request, predicate: id(10) }),
  ).rejects.toBeInstanceOf(InvalidContextCommand);
  f.define(id(7), id(6), 'interpretation', 'other-qualification-v1');
  await expect(validateStatementDefinitions(f.env, request)).rejects.toBeInstanceOf(
    InvalidContextCommand,
  );
  f.define(id(7), id(6), 'property', QUALIFICATION_DEFINITION_NOTATION);
  await expect(validateStatementDefinitions(f.env, request)).rejects.toBeInstanceOf(
    InvalidContextCommand,
  );
  f.define(id(7), id(6), 'interpretation', QUALIFICATION_DEFINITION_NOTATION);
  f.definitions.get(id(7))!.head = id(8);
  await expect(validateStatementDefinitions(f.env, request)).rejects.toBeInstanceOf(
    ContextCommandUnavailable,
  );
  f.definitions.get(id(7))!.head = id(7);
  f.definitions.get(id(7))!.lifecycle = `${RV}Retired`;
  await expect(validateStatementDefinitions(f.env, request)).rejects.toBeInstanceOf(
    ContextCommandUnavailable,
  );
  f.definitions.get(id(7))!.lifecycle = `${RV}Active`;
  await expect(
    validateStatementDefinitions(f.env, request, async () => false),
  ).rejects.toBeInstanceOf(ContextCommandUnavailable);
  f.definitions.delete(id(7));
  await expect(validateStatementDefinitions(f.env, request)).rejects.toBeInstanceOf(
    ContextCommandUnavailable,
  );
  expect(f.commands).toEqual([]);
});

test('relation and literal interpretation pins cannot substitute another definition kind', async () => {
  const f = fixture();
  f.define(id(3), id(2), 'relation');
  expect(
    (await validateStatementDefinitions(f.env, { predicate: id(2), relationDefinition: id(3) }))
      .guard,
  ).toContain('RelationDefinition');
  f.define(id(3), id(2), 'interpretation');
  await expect(
    validateStatementDefinitions(f.env, { predicate: id(2), relationDefinition: id(3) }),
  ).rejects.toBeInstanceOf(InvalidContextCommand);
  f.define(id(3), id(2), 'property');
  await expect(validateStatementInterpretationDefinition(f.env, id(3))).rejects.toBeInstanceOf(
    InvalidContextCommand,
  );
  f.define(id(12), id(11), 'interpretation');
  expect((await validateStatementInterpretationDefinition(f.env, id(12))).guard).toContain(
    `rv:definitionHead <${id(12)}>`,
  );
  const classified = {
    predicate: `${RV}classifiedAs`,
    relationDefinition: 'https://rezics.com/definition/classification-proposition-v1',
  };
  expect((await validateStatementDefinitions(f.env, classified)).guard).toContain(
    classified.relationDefinition,
  );
  await expect(
    validateStatementDefinitions(f.env, { ...classified, predicate: id(2) }),
  ).rejects.toBeInstanceOf(InvalidContextCommand);
  await expect(
    validateStatementDefinitions(f.env, { ...classified, qualification: qualification() }),
  ).rejects.toBeInstanceOf(InvalidContextCommand);
});

test('the authored command refuses a mismatched predicate or unreviewed qualification before graph writes', async () => {
  const f = fixture();
  const badPredicate: RecordStatementInput = {
    ...input(),
    predicate: id(10),
    qualification: qualification(),
  };
  await expect(
    recordStatement(f.env, admission(recordStatementRequest(badPredicate)), badPredicate, {
      kind: 'personal',
    }),
  ).rejects.toBeInstanceOf(InvalidContextCommand);
  f.define(id(7), id(6), 'interpretation', 'unsupported-bundle-v1');
  const badQualification: RecordStatementInput = { ...input(), qualification: qualification() };
  await expect(
    recordStatement(f.env, admission(recordStatementRequest(badQualification)), badQualification, {
      kind: 'personal',
    }),
  ).rejects.toBeInstanceOf(InvalidContextCommand);
  expect(f.commands).toEqual([]);
});

test('an interpreted typed literal records both exact pins and qualification in RDF and immutable custody', async () => {
  const f = fixture();
  f.define(id(12), id(11), 'interpretation');
  const authored: RecordStatementInput = {
    ...input(),
    qualification: qualification(),
    interpretation: { kind: 'definition', definition: id(12) },
  };
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const read = await readStatement(f.env, receipt.component!, async () => false);
  expect(read.value).toEqual(authored.value);
  expect(read.qualification).toEqual(authored.qualification);
  expect(read.meaningBasis).toEqual({ state: 'defined', interpretationDefinitions: [id(12)] });
  expect(read.export[`${RDF}object`]).toEqual([{ '@value': '001', '@type': `${XSD}integer` }]);
  expect(read.export[`${RV}interpretationDefinition`]).toEqual([{ '@id': id(12) }]);
  expect(read.export[`${RV}qualificationDefinition`]).toEqual([{ '@id': id(7) }]);
  expect(f.payload(receipt.revision!)).toMatchObject({
    meaning: {
      qualification: qualification(),
      interpretationDefinitions: [id(12)],
      value: authored.value,
    },
    evidence: authored.evidence,
  });
  expect(f.commands[0]!.update).toContain(`rv:definitionHead <${id(3)}>`);
  expect(f.commands[0]!.update).toContain(`rv:definitionHead <${id(7)}>`);
  expect(f.commands[0]!.update).toContain(`rv:definitionHead <${id(12)}>`);
  expect(
    f.store.getQuads(
      named(authored.subject),
      named(authored.predicate),
      null,
      named(GRAPHS.current),
    ),
  ).toEqual([]);
});

test('an interpreted language literal keeps exact RDF language and exports its pinned definition', async () => {
  const f = fixture();
  f.define(id(12), id(11), 'interpretation');
  const authored: RecordStatementInput = {
    ...input(),
    value: { kind: 'literal', lexical: '赤い', datatype: `${RDF}langString`, language: 'ja' },
    interpretation: { kind: 'definition', definition: id(12) },
  };
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const read = await readStatement(f.env, receipt.component!, async () => false);
  expect(read.value).toEqual(authored.value);
  expect(read.export[`${RDF}object`]).toEqual([{ '@value': '赤い', '@language': 'ja' }]);
  expect(read.meaningBasis).toEqual({ state: 'defined', interpretationDefinitions: [id(12)] });
  expect(f.payload(receipt.revision!).meaning.value).toEqual(authored.value);
});

test('exact manifest custody preserves numeric lexical spelling when the graph engine canonicalizes a typed value', async () => {
  for (const qualified of [false, true]) {
    const f = fixture();
    const authored: RecordStatementInput = {
      ...input(),
      ...(qualified ? { qualification: qualification() } : {}),
    };
    const receipt = await recordStatement(
      f.env,
      admission(recordStatementRequest(authored)),
      authored,
      { kind: 'personal' },
    );
    f.remove(GRAPHS.current, receipt.component!, `${RDF}object`);
    f.store.addQuad(
      named(receipt.component!),
      named(`${RDF}object`),
      DataFactory.literal('1', named(`${XSD}integer`)),
      named(GRAPHS.current),
    );
    expect(
      f.store
        .getObjects(named(receipt.component!), named(`${RDF}object`), named(GRAPHS.current))
        .map((value) => value.value),
    ).toEqual(['1']);
    const current = await readStatement(f.env, receipt.component!, async () => false);
    const exact = await readStatement(
      f.env,
      receipt.component!,
      async () => false,
      receipt.revision!,
    );
    expect(current.value).toEqual(authored.value);
    expect(exact.value).toEqual(authored.value);
    expect(current.meaningKey).toBe(exact.meaningKey);
    expect(current.export[`${RDF}object`]).toEqual([{ '@value': '001', '@type': `${XSD}integer` }]);
  }
});

test('bounded public support hydration preserves qualifications and an explicit literal interpretation', async () => {
  const f = fixture();
  f.define(id(12), id(11), 'interpretation');
  const authored: RecordStatementInput = {
    ...input(),
    qualification: qualification(),
    interpretation: { kind: 'definition', definition: id(12) },
  };
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const batch = await readPublicStatementsAt(f.env, [receipt.component!], {
    dataEpoch: receipt.dataEpoch,
    sequence: receipt.sequence,
  });
  expect(batch.get(receipt.component!)).toMatchObject({
    value: authored.value,
    qualification: qualification(),
    meaningBasis: { state: 'defined', interpretationDefinitions: [id(12)] },
  });
});

test('public qualification scopes require authorization for every native context and edition', async () => {
  for (const scope of [
    { interpretationContext: id(20), editionScope: qualification().editionScope },
    { interpretationContext: qualification().interpretationContext, editionScope: id(21) },
    { interpretationContext: id(20), editionScope: id(21) },
  ]) {
    const f = fixture();
    const bundle = { ...qualification(), ...scope };
    const authored: RecordStatementInput = { ...input(), qualification: bundle };
    const receipt = await recordStatement(
      f.env,
      admission(recordStatementRequest(authored)),
      authored,
      { kind: 'personal' },
    );
    const position = { dataEpoch: receipt.dataEpoch, sequence: receipt.sequence };
    const wanted = [scope.interpretationContext, scope.editionScope!].filter((reference) =>
      reference.startsWith('https://rezics.com/id/'),
    );
    await expect(
      readPublicStatementsAt(f.env, [receipt.component!], position),
    ).rejects.toBeInstanceOf(StatementBatchUnavailable);
    await expect(
      readPublicStatementsAt(f.env, [receipt.component!], position, async () => new Set()),
    ).rejects.toBeInstanceOf(StatementBatchUnavailable);
    if (wanted.length === 2) {
      await expect(
        readPublicStatementsAt(
          f.env,
          [receipt.component!],
          position,
          async () => new Set([id(20)]),
        ),
      ).rejects.toBeInstanceOf(StatementBatchUnavailable);
    }
    const checked: string[][] = [];
    const batch = await readPublicStatementsAt(
      f.env,
      [receipt.component!],
      position,
      async (references) => {
        checked.push([...references]);
        return new Set(references);
      },
    );
    expect(checked).toEqual([wanted]);
    expect(batch.get(receipt.component!)).toMatchObject({
      qualification: bundle,
      value: authored.value,
    });
  }
});

test('public support hydration refuses qualification and RDF term drift from its sealed meaning', async () => {
  const f = fixture();
  const authored: RecordStatementInput = { ...input(), qualification: qualification() };
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const position = { dataEpoch: receipt.dataEpoch, sequence: receipt.sequence };
  const read = () => readPublicStatementsAt(f.env, [receipt.component!], position);
  const replace = (
    predicate: string,
    value: ReturnType<typeof named> | ReturnType<typeof DataFactory.literal>,
  ) => {
    f.remove(GRAPHS.current, receipt.component!, predicate);
    f.store.addQuad(named(receipt.component!), named(predicate), value, named(GRAPHS.current));
    expect(
      f.store.countQuads(named(receipt.component!), named(predicate), null, named(GRAPHS.current)),
    ).toBe(1);
  };
  const originalKey = f.one(GRAPHS.current, receipt.component!, `${RV}meaningKey`)!.value;
  replace(`${RDF}object`, DataFactory.literal('1', named(`${XSD}integer`)));
  expect((await read()).get(receipt.component!)?.value).toEqual(authored.value);
  for (const mutation of [
    { predicate: `${RV}qualificationDefinition`, value: named(id(8)) },
    { predicate: `${RDF}object`, value: DataFactory.literal('001', named(`${XSD}string`)) },
    { predicate: `${RDF}object`, value: named(id(10)) },
  ]) {
    replace(mutation.predicate, mutation.value);
    expect(f.one(GRAPHS.current, receipt.component!, `${RV}meaningKey`)!.value).toBe(originalKey);
    await expect(read()).rejects.toBeInstanceOf(ContextCommandUnavailable);
    replace(`${RV}qualificationDefinition`, named(qualification().definition));
    replace(`${RDF}object`, DataFactory.literal('1', named(`${XSD}integer`)));
  }
  f.remove(GRAPHS.revisions, receipt.revision!, `${RV}manifest`);
  expect(f.one(GRAPHS.revisions, receipt.revision!, `${RV}manifest`)).toBeUndefined();
  await expect(read()).rejects.toBeInstanceOf(ContextCommandUnavailable);
});

test('legacy unqualified public supports remain readable without a sealed meaning manifest', async () => {
  const f = fixture();
  const authored = input();
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  f.remove(GRAPHS.revisions, receipt.revision!, `${RV}manifest`);
  expect(f.one(GRAPHS.revisions, receipt.revision!, `${RV}manifest`)).toBeUndefined();
  const batch = await readPublicStatementsAt(f.env, [receipt.component!], {
    dataEpoch: receipt.dataEpoch,
    sequence: receipt.sequence,
  });
  expect(batch.get(receipt.component!)).toMatchObject({ value: authored.value });
  expect(batch.get(receipt.component!)?.qualification).toBeUndefined();
});

test('a graph qualification cannot change under its unchanged sealed meaning key', async () => {
  const f = fixture();
  const authored: RecordStatementInput = { ...input(), qualification: qualification() };
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const retained = f.payload(receipt.revision!);
  const key = f.one(GRAPHS.current, receipt.component!, `${RV}meaningKey`)!.value;
  f.remove(GRAPHS.current, receipt.component!, `${RV}interpretationContext`);
  f.store.addQuad(
    named(receipt.component!),
    named(`${RV}interpretationContext`),
    named(id(22)),
    named(GRAPHS.current),
  );
  expect(f.one(GRAPHS.current, receipt.component!, `${RV}interpretationContext`)?.value).toBe(
    id(22),
  );
  expect(f.one(GRAPHS.current, receipt.component!, `${RV}meaningKey`)!.value).toBe(key);
  await expect(readStatement(f.env, receipt.component!, async () => false)).rejects.toBeInstanceOf(
    ContextCommandUnavailable,
  );
  await expect(
    readStatement(f.env, receipt.component!, async () => false, receipt.revision!),
  ).rejects.toBeInstanceOf(ContextCommandUnavailable);
  expect(f.payload(receipt.revision!)).toEqual(retained);
});

test('a current head with multiple immutable manifests is unavailable even when all other fields agree', async () => {
  const f = fixture();
  const authored = input();
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const alternate = prepareComponent(
    f.env.objectDirectory,
    receipt.component!,
    { ...f.payload(receipt.revision!), evidence: [id(10)] },
    'https://rezics.com/definition/statement-v1',
  );
  f.store.addQuad(
    named(receipt.revision!),
    named(`${RV}manifest`),
    named(`urn:rezics:sha256:${alternate}`),
    named(GRAPHS.revisions),
  );
  await expect(readStatement(f.env, receipt.component!, async () => false)).rejects.toBeInstanceOf(
    ContextCommandUnavailable,
  );
});

test('sealed RDF value custody permits numeric spelling changes but refuses another datatype or term kind', async () => {
  const f = fixture();
  const authored: RecordStatementInput = { ...input(), qualification: qualification() };
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const replaceObject = (value: Term) => {
    f.remove(GRAPHS.current, receipt.component!, `${RDF}object`);
    if (value.termType !== 'NamedNode' && value.termType !== 'Literal')
      throw new Error('Invalid fixture RDF object');
    f.store.addQuad(named(receipt.component!), named(`${RDF}object`), value, named(GRAPHS.current));
    expect(
      f.store.countQuads(
        named(receipt.component!),
        named(`${RDF}object`),
        null,
        named(GRAPHS.current),
      ),
    ).toBe(1);
  };
  replaceObject(DataFactory.literal('1', named(`${XSD}integer`)));
  expect((await readStatement(f.env, receipt.component!, async () => false)).value).toEqual(
    authored.value,
  );
  for (const different of [DataFactory.literal('001', named(`${XSD}string`)), named(id(10))]) {
    replaceObject(different);
    await expect(
      readStatement(f.env, receipt.component!, async () => false),
    ).rejects.toBeInstanceOf(ContextCommandUnavailable);
    await expect(
      readStatement(f.env, receipt.component!, async () => false, receipt.revision!),
    ).rejects.toBeInstanceOf(ContextCommandUnavailable);
  }
});

test('read ambiguity compares complete RDF terms rather than only equal lexical text', async () => {
  const f = fixture();
  const authored = input();
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const query = f.graph.query;
  for (const alternatives of [
    [
      { ...literal('001'), datatype: `${XSD}integer` },
      { ...literal('001'), datatype: `${XSD}string` },
    ],
    [
      { ...literal('001'), datatype: `${RDF}langString`, 'xml:lang': 'en' },
      { ...literal('001'), datatype: `${RDF}langString`, 'xml:lang': 'fr' },
    ],
  ]) {
    f.graph.query = async (text, maximumBytes) =>
      text.includes('SELECT ?epoch ?sequence ?subject ?predicate ?object')
        ? rows(alternatives.map((object) => ({ ...f.currentRow(receipt.component!), object })))
        : query(text, maximumBytes);
    await expect(
      readStatement(f.env, receipt.component!, async () => false),
    ).rejects.toBeInstanceOf(ContextCommandUnavailable);
  }
});

test('partial mandatory Statement bindings report unavailable before RDF value hydration', async () => {
  const f = fixture();
  const authored = input();
  const receipt = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const query = f.graph.query;
  for (const field of ['object', 'predicate', 'relation', 'key']) {
    const partial = { ...f.currentRow(receipt.component!) };
    delete partial[field];
    f.graph.query = async (text, maximumBytes) =>
      text.includes('SELECT ?epoch ?sequence ?subject ?predicate ?object')
        ? rows([partial])
        : query(text, maximumBytes);
    await expect(
      readStatement(f.env, receipt.component!, async () => false),
    ).rejects.toBeInstanceOf(ContextCommandUnavailable);
  }
});

test('admitted qualified recording binds the same complete request and replay returns the original identity', async () => {
  const f = fixture();
  const authored: RecordStatementInput = { ...input(), qualification: qualification() };
  const plan = recordStatementRequest(authored);
  const scopes: string[][] = [];
  const intents: { action: string; scope: string; actingSubject: string; requestDigest: string }[] =
    [];
  const outcomes: ContextCommandReceipt[] = [];
  let registered: RegisteredAdmission | undefined;
  const account = {
    verify: async (_request: Request, requested: readonly string[]) => {
      scopes.push([...requested]);
      return { issuer: 'https://account.test', subject: 'qualified-author' };
    },
  };
  const access: Parameters<typeof runAdmittedCommand>[2] = {
    register: async (intent) => {
      intents.push(intent);
      if (registered) {
        if (registered.requestDigest !== intent.requestDigest)
          throw new IdempotencyConflict('Another request under the same key');
        return { ...registered, replayed: true };
      }
      registered = {
        ...admission(plan),
        state: 'registered',
        idempotencyKey: 'qualified-statement',
      };
      return registered;
    },
    claim: async () => {
      if (!registered) throw new Error('Missing admission');
      registered = { ...registered, state: 'claimed' };
      return { ...registered, claimedAt: new Date().toISOString() };
    },
    recordGraphOutcome: async (_id, receipt) => {
      outcomes.push(receipt);
      if (registered) registered = { ...registered, state: 'sealed' };
    },
  };
  const record = (value: RecordStatementInput) => {
    const request = recordStatementRequest(value);
    return runAdmittedCommand(
      f.env,
      account,
      access,
      new Request('https://main.test/v1/statements'),
      {
        family: STATEMENT_FAMILIES.record,
        oauthScope: 'statement:write',
        ...request,
        actingSubject: value.actingSubject,
        input: value,
        idempotencyKey: 'qualified-statement',
        execute: (admitted) => recordStatement(f.env, admitted, value, { kind: 'personal' }),
      },
    );
  };
  const first = await record(authored);
  const replay = await record(authored);
  expect(first.replayed).toBe(false);
  expect(replay).toEqual({ ...first, replayed: true });
  expect(f.commands).toHaveLength(1);
  expect(scopes).toEqual([['statement:write'], ['statement:write']]);
  expect(
    intents.map((intent) => [
      intent.action,
      intent.scope,
      intent.actingSubject,
      intent.requestDigest,
    ]),
  ).toEqual(
    Array.from({ length: 2 }, () => [
      'statement.record',
      `statement:speak:${id(4)}`,
      id(4),
      plan.digest,
    ]),
  );
  expect(outcomes).toHaveLength(2);
  expect(first.receipt).toBe(commandReceiptIri(registered!.id, STATEMENT_FAMILIES.record));
  await expect(
    record({ ...authored, qualification: { ...qualification(), valuePrecision: 'uncertain' } }),
  ).rejects.toBeInstanceOf(IdempotencyConflict);
  expect(f.commands).toHaveLength(1);
});

test('exact active and withdrawn revisions retain qualification, interpretation and independent evidence', async () => {
  const f = fixture();
  f.define(id(12), id(11), 'interpretation');
  const authored: RecordStatementInput = {
    ...input(),
    qualification: qualification(),
    interpretation: { kind: 'definition', definition: id(12) },
  };
  const recorded = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const retained = f.payload(recorded.revision!);
  const withdrawal = {
    statement: recorded.component!,
    speaker: authored.speaker,
    expectedHead: recorded.revision!,
    actingSubject: authored.actingSubject,
  };
  const withdrawn = await withdrawStatement(
    f.env,
    admission(withdrawStatementRequest(withdrawal)),
    withdrawal,
  );
  const activeRead = await readStatement(
    f.env,
    recorded.component!,
    async () => false,
    recorded.revision!,
  );
  const withdrawnRead = await readStatement(
    f.env,
    recorded.component!,
    async () => false,
    withdrawn.revision!,
  );
  expect(activeRead).toMatchObject({
    revision: recorded.revision,
    state: 'active',
    qualification: qualification(),
    value: authored.value,
  });
  expect(withdrawnRead).toMatchObject({
    revision: withdrawn.revision,
    state: 'withdrawn',
    qualification: qualification(),
    value: authored.value,
  });
  expect(activeRead.meaningKey).toBe(withdrawnRead.meaningKey);
  expect(activeRead.meaningBasis).toEqual({
    state: 'defined',
    interpretationDefinitions: [id(12)],
  });
  expect(withdrawnRead.meaningBasis).toEqual(activeRead.meaningBasis);
  expect(f.payload(recorded.revision!)).toEqual(retained);
  expect(retained.evidence).toEqual([id(9)]);
  expect(f.one(GRAPHS.revisions, recorded.revision!, `${RV}evidence`)?.value).toBe(id(9));
});

test('an exact legacy lifecycle manifest can read immutable current meaning but cannot retarget another Statement', async () => {
  const f = fixture();
  const authored = input();
  const recorded = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  const legacy = prepareComponent(
    f.env.objectDirectory,
    recorded.component!,
    {
      revision: recorded.revision!,
      state: 'active',
      evidence: [id(9)],
      recordedBy: authored.actingSubject,
    },
    'https://rezics.com/definition/statement-v1',
  );
  f.remove(GRAPHS.revisions, recorded.revision!, `${RV}manifest`);
  f.store.addQuad(
    named(recorded.revision!),
    named(`${RV}manifest`),
    named(`urn:rezics:sha256:${legacy}`),
    named(GRAPHS.revisions),
  );
  expect(
    f.store
      .getObjects(named(recorded.revision!), named(`${RV}manifest`), named(GRAPHS.revisions))
      .map((value) => value.value),
  ).toEqual([`urn:rezics:sha256:${legacy}`]);
  const read = await readStatement(
    f.env,
    recorded.component!,
    async () => false,
    recorded.revision!,
  );
  expect(read).toMatchObject({
    revision: recorded.revision,
    state: 'active',
    value: authored.value,
  });
  const other = await recordStatement(
    f.env,
    admission(recordStatementRequest(authored)),
    authored,
    { kind: 'personal' },
  );
  await expect(
    readStatement(f.env, recorded.component!, async () => false, other.revision!),
  ).rejects.toThrow();
  await expect(
    readStatement(f.env, recorded.component!, async () => false, id(99)),
  ).rejects.toThrow();
});

test('independent speakers and repeated authored Statements keep their own IDs while sharing meaning', async () => {
  const f = fixture();
  const authored = input();
  const a = await recordStatement(f.env, admission(recordStatementRequest(authored)), authored, {
    kind: 'personal',
  });
  const b = await recordStatement(f.env, admission(recordStatementRequest(authored)), authored, {
    kind: 'personal',
  });
  const other = { ...authored, actingSubject: id(5) };
  const c = await recordStatement(f.env, admission(recordStatementRequest(other), id(5)), other, {
    kind: 'personal',
  });
  expect(new Set([a.component, b.component, c.component]).size).toBe(3);
  const reads = await Promise.all(
    [a, b, c].map((receipt) => readStatement(f.env, receipt.component!, async () => false)),
  );
  expect(new Set(reads.map((read) => read.meaningKey)).size).toBe(1);
  expect(reads.map((read) => read.speaker)).toEqual([id(4), id(4), id(5)]);
  expect(reads.every((read) => JSON.stringify(read.export).includes('"@value":"001"'))).toBe(true);
});

test('lost acknowledgement replays its receipt and withdrawal preserves exact active evidence and meaning', async () => {
  const f = fixture();
  const authored = input();
  const admitted = admission(recordStatementRequest(authored));
  f.loseNextAcknowledgement();
  const original = await recordStatement(f.env, admitted, authored, { kind: 'personal' });
  expect(await recordStatement(f.env, admitted, authored, { kind: 'personal' })).toEqual(original);
  expect(f.commands).toHaveLength(1);
  const activePayload = f.payload(original.revision!);
  expect(activePayload.evidence).toEqual(authored.evidence);
  const withdrawal = {
    statement: original.component!,
    speaker: authored.speaker,
    expectedHead: original.revision!,
    actingSubject: authored.actingSubject,
  };
  const withdrawn = await withdrawStatement(
    f.env,
    admission(withdrawStatementRequest(withdrawal)),
    withdrawal,
  );
  expect(f.payload(original.revision!)).toEqual(activePayload);
  expect(f.payload(withdrawn.revision!)).toMatchObject({
    predecessor: original.revision,
    state: 'withdrawn',
  });
  expect((await readStatement(f.env, original.component!, async () => false)).value).toEqual(
    authored.value,
  );
  expect(f.one(GRAPHS.revisions, original.revision!, `${RV}evidence`)?.value).toBe(id(9));
  expect(f.one(GRAPHS.current, original.component!, `${RV}statementState`)?.value).toBe(
    `${RV}Withdrawn`,
  );
  await expect(
    recordStatement(
      f.env,
      admitted,
      { ...authored, value: { ...authored.value, lexical: '2' } as StatementValue },
      { kind: 'personal' },
    ),
  ).rejects.toBeInstanceOf(IdempotencyConflict);
});
