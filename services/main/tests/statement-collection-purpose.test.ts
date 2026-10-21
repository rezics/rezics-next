import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DataFactory, Parser, Store, type Term } from 'n3';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { FusekiClient, type CommandEnvelope, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_INHERIT_POLICY } from '../src/modules/classification/context.ts';
import { commandReceiptIri, ContextCommandUnavailable, InvalidContextCommand,
  readCommandReceipt, StaleContextCommand } from '../src/modules/context/command.ts';
import { recordStatement, recordStatementRequest, setStatementDecision, statementDecisionRequest,
  STATEMENT_FAMILIES, type RecordStatementInput, type SetStatementDecisionInput } from '../src/modules/statement/graph.ts';
import { COLLECTION_PURPOSE_KINDS, COLLECTION_PURPOSE_NOTATION,
  validateStatementDefinitions } from '../src/modules/statement/qualification.ts';
import { decisionSlotIri, type StatementValue } from '../src/modules/statement/schema.ts';
import { PROFILES, definitionKindIri } from '../src/modules/semantic/schema.ts';
import { RevisionCorrupt } from '../src/modules/work/history.ts';
import type { DefinitionState } from '../src/modules/semantic/change.ts';
import { DATASET, GRAPHS, IdempotencyConflict, prepareComponent, RV,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const root = resolve('.temp', `statement-collection-purpose-${Bun.randomUUIDv7()}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const named = DataFactory.namedNode;
const uri = (value: string) => ({ type: 'uri', value });
const literal = (value: string) => ({ type: 'literal', value });
type Row = NonNullable<SparqlResult['results']>['bindings'][number];
const rows = (bindings: Row[]): SparqlResult => ({ results: { bindings } });
const value = (lexical: string): StatementValue => ({ kind: 'literal', lexical, datatype: `${XSD}string`, language: null });
const binding = (term: Term): Row[string] => term.termType === 'NamedNode' ? uri(term.value) : {
  ...literal(term.value), ...(term.termType === 'Literal' ? { datatype: term.datatype.value,
    ...(term.language ? { 'xml:lang': term.language } : {}) } : {}),
};
function admission(request: { action: string; scope: string; digest: string }): RegisteredAdmission {
  return { id: Bun.randomUUIDv7(), principalId: Bun.randomUUIDv7(), actingSubject: id(4),
    scope: request.scope, action: request.action, idempotencyKey: Bun.randomUUIDv7(), requestDigest: request.digest,
    authorityEpoch: '1', expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'claimed',
    dispatchEligible: true, replayed: false };
}

/** External transport stores the real command RDF and sealed objects. The
 * fixture enforces the emitted exact Definition/Statement/DecisionSlot guards;
 * application validation, native receipts and replay execute unchanged. */
function fixture() {
  const graph = new FusekiClient('http://graph.invalid');
  const env: WorkActivationEnvironment = { fuseki: graph, objectDirectory: mkdtempSync(`${root}/objects-`),
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  const store = new Store(), commands: CommandEnvelope[] = [];
  let sequence = 0, loseReply = false;
  let beforeCommand: (() => void) | undefined;
  let state: DefinitionState = { component: 'definition', kind: 'property', lifecycle: 'active',
    successor: null, roles: [], notation: COLLECTION_PURPOSE_NOTATION };
  let head = id(3), manifest = '';
  const one = (graph: string, subject: string, predicate: string) =>
    store.getObjects(named(subject), named(predicate), named(graph))[0];
  const replace = (graph: string, subject: string, predicate: string, object: string) => {
    store.removeQuads(store.getQuads(named(subject), named(predicate), null, named(graph)));
    store.addQuad(named(subject), named(predicate), named(object), named(graph));
  };
  const seal = () => {
    manifest = `urn:rezics:sha256:${prepareComponent(env.objectDirectory, id(2), state, PROFILES.definition)}`;
    replace(GRAPHS.current, id(2), `${RV}definitionHead`, head);
  };
  seal();
  store.addQuad(named(id(1)), named(`${RDF}type`), named(`${RV}Collection`), named(GRAPHS.current));
  const fields = (graph: string, subject: string, mapping: Record<string, string>): Row =>
    Object.fromEntries(Object.entries(mapping).flatMap(([key, predicate]) => {
      const term = one(graph, subject, predicate);
      return term ? [[key, binding(term)]] : [];
    }));
  graph.commandHealth = async () => ({ moduleVersion: 'fixture', instanceId: 'fixture',
    publicSearchWriteEpoch: '0', publicSearchWriteActive: false,
    profiles: Object.fromEntries(Object.entries(profileRegistry).map(([name, profile]) => [name, profile.sha256])) });
  graph.query = async query => {
    if (query.includes('ASK')) return { boolean: !query.includes('rv:rejectionKind rv:InvalidProfile') };
    if (query.includes('SELECT ?outcome ?reason ?digest')) {
      const receipt = /GRAPH <urn:rezics:graph:receipts>\s*\{\s*<([^>]+)>/u.exec(query)?.[1];
      if (!receipt) throw new Error('Receipt read must name its actual command receipt');
      const row = fields(GRAPHS.receipts, receipt, Object.fromEntries([
        'outcome', 'reason', 'requestDigest', 'admissionId', 'authorityEpoch', 'admittedScope', 'dataEpoch',
        'sequence', 'operation', 'component', 'revision', 'expectedHead',
      ].map((field, index) => [[ 'outcome', 'reason', 'digest', 'id', 'epoch', 'scope', 'dataEpoch',
        'sequence', 'operation', 'component', 'revision', 'expectedHead' ][index]!, `${RV}${field}`])));
      return rows(row.outcome ? [row] : []);
    }
    if (query.includes('SELECT ?revision ?definition ?manifest')) return rows(query.includes(`<${id(3)}>`)
      ? [{ revision: uri(id(3)), definition: uri(id(2)), manifest: uri(manifest), kind: uri(definitionKindIri(state.kind)),
        lifecycle: uri(`${RV}${state.lifecycle === 'active' ? 'Active' : 'Retired'}`), head: uri(head) }] : []);
    if (query.includes('SELECT ?subject ?frame')) return rows([]);
    if (query.includes('SELECT ?context ?revision ?policy')) return rows([{ context: uri(GLOBAL_CLASSIFICATION_CONTEXT),
      policy: uri(CLASSIFICATION_INHERIT_POLICY) }]);
    if (query.includes('SELECT ?statement ?head ?key ?prior')) {
      const statement = /VALUES \?statement \{ <([^>]+)>/u.exec(query)?.[1];
      const slot = /OPTIONAL \{ GRAPH <urn:rezics:graph:current> \{ <([^>]+)> rv:decisionHead/u.exec(query)?.[1];
      if (!statement || !slot) throw new Error('Decision read must bind its exact Statement and scope slot');
      const row = fields(GRAPHS.current, statement, { head: `${RV}head`, key: `${RV}meaningKey` });
      const prior = one(GRAPHS.current, slot, `${RV}decisionHead`);
      return rows(row.head && one(GRAPHS.current, statement, `${RV}statementState`)?.value === `${RV}Active`
        ? [{ statement: uri(statement), ...row, ...(prior ? { prior: binding(prior) } : {}) }] : []);
    }
    throw new Error(`Unexpected Collection purpose command read: ${query}`);
  };
  graph.commandWithReceipt = async envelope => {
    commands.push(envelope);
    const hook = beforeCommand; beforeCommand = undefined; hook?.();
    const insert = /INSERT\s*\{([\s\S]*?)\}\s*WHERE\s*\{/u.exec(envelope.update)?.[1];
    const remove = /DELETE\s*\{([\s\S]*?)\}\s*INSERT\s*\{/u.exec(envelope.update)?.[1];
    const where = envelope.update.slice(envelope.update.indexOf('WHERE {'));
    if (!insert || !remove) throw new Error('Native command must contain its atomic DELETE/INSERT/WHERE');
    let allowed = !one(GRAPHS.receipts, envelope.receipt, `${RV}outcome`);
    for (const match of where.matchAll(/<([^>]+)> a rv:SemanticDefinition ;\s*rv:definitionKind [^;]+; rv:definitionHead <([^>]+)>/gu)) {
      allowed &&= state.lifecycle === 'active' && one(GRAPHS.current, match[1]!, `${RV}definitionHead`)?.value === match[2];
    }
    for (const match of where.matchAll(/<([^>]+)> a rdf:Statement ;\s*rv:statementState rv:Active ; rv:head <([^>]+)> ; rv:meaningKey <([^>]+)>/gu)) {
      allowed &&= one(GRAPHS.current, match[1]!, `${RV}head`)?.value === match[2]
        && one(GRAPHS.current, match[1]!, `${RV}meaningKey`)?.value === match[3]
        && one(GRAPHS.current, match[1]!, `${RV}statementState`)?.value === `${RV}Active`;
    }
    const slotAbsent = /FILTER NOT EXISTS \{ GRAPH <urn:rezics:graph:current> \{ <([^>]+)> \?p \?o \} \}/u.exec(where);
    if (slotAbsent) allowed &&= !store.countQuads(named(slotAbsent[1]!), null, null, named(GRAPHS.current));
    const staleInitial = /FILTER EXISTS \{ GRAPH <urn:rezics:graph:current> \{ <([^>]+)> rv:decisionHead \?any \} \}/u.exec(where);
    if (staleInitial) allowed &&= !!one(GRAPHS.current, staleInitial[1]!, `${RV}decisionHead`);
    const staleHead = /FILTER NOT EXISTS \{ GRAPH <urn:rezics:graph:current> \{ <([^>]+)> rv:decisionHead <([^>]+)> \} \}/u.exec(where);
    if (staleHead) allowed &&= one(GRAPHS.current, staleHead[1]!, `${RV}decisionHead`)?.value !== staleHead[2];
    const expected = /GRAPH <urn:rezics:graph:current> \{ <([^>]+)> rv:decisionHead <([^>]+)> \}/u.exec(where);
    if (expected && !staleHead) allowed &&= one(GRAPHS.current, expected[1]!, `${RV}decisionHead`)?.value === expected[2];
    if (allowed) {
      const parse = (text: string, next: number) => new Parser({ format: 'TriG' }).parse(
        `PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>\n${text.replaceAll('?next', String(next)).replaceAll('?n', String(sequence))}`);
      store.removeQuads(parse(remove, sequence));
      store.addQuads(parse(insert, sequence + 1));
      sequence++;
      if (loseReply) { loseReply = false; throw new Error('Committed native command reply lost'); }
    }
    return { status: 'committed', position: { datasetId: DATASET, dataEpoch: env.lineage.dataEpoch, sequence: String(sequence) } };
  };
  const input = (kind: string): RecordStatementInput => ({ speaker: { kind: 'personal' }, subject: id(1),
    predicate: id(2), relationDefinition: id(3), value: value(kind), applicability: [],
    interpretation: { kind: 'selected' }, evidence: [], actingSubject: id(4) });
  const record = (kind: string, beforeCommit?: () => Promise<void>) => {
    const request = input(kind);
    return recordStatement(env, admission(recordStatementRequest(request)), request, { kind: 'personal' }, beforeCommit);
  };
  const decision = (statement: string, expectedDecisionHead: string | null, outcome: SetStatementDecisionInput['outcome']): SetStatementDecisionInput =>
    ({ target: { kind: 'statement', statement }, acceptance: { kind: 'global' }, expectedDecisionHead, outcome, actingSubject: id(4) });
  return { env, store, commands, one, replace, record, input, decision,
    reviseDefinition(patch: Partial<DefinitionState> = {}) { state = { ...state, ...patch }; head = id(5); seal(); },
    changeMeaning(patch: Partial<DefinitionState>) { state = { ...state, ...patch }; seal(); },
    loseNextReply() { loseReply = true; }, race(hook: () => void) { beforeCommand = hook; } };
}

test('each exact Collection purpose records an ordinary native Statement with no adoption or converter prerequisite', async () => {
  const run = fixture();
  for (const kind of COLLECTION_PURPOSE_KINDS) {
    const receipt = await run.record(kind);
    expect(receipt.outcome).toBe('succeeded');
    expect(receipt.receipt).not.toBe(receipt.component);
    expect(run.one(GRAPHS.current, receipt.component!, `${RDF}object`)?.value).toBe(kind);
    expect(run.one(GRAPHS.revisions, receipt.revision!, `${RV}evidence`)).toBeUndefined();
    expect(run.store.countQuads(null, named(`${RDF}type`), named(`${RV}DecisionSlot`), named(GRAPHS.current))).toBe(0);
  }
});

test('purpose admission refuses nonliteral, tagged, other-datatype and noncanonical values before native mutation', async () => {
  const run = fixture();
  const invalid: StatementValue[] = [value('Series'), value('series '), value('ordinary'), value(''),
    { kind: 'resource', iri: id(8) }, { kind: 'no-value' }, { kind: 'some-value' },
    { kind: 'literal', lexical: 'series', datatype: `${RDF}langString`, language: 'en' },
    { kind: 'literal', lexical: 'series', datatype: `${XSD}token`, language: null }];
  for (const typed of invalid) {
    const input = { ...run.input('series'), value: typed };
    await expect(recordStatement(run.env, admission(recordStatementRequest(input)), input, { kind: 'personal' }))
      .rejects.toBeInstanceOf(InvalidContextCommand);
  }
  expect(run.commands).toHaveLength(0);
});

test('the exact current property, roles and revision bind purpose admission and its final command guard', async () => {
  const run = fixture();
  await expect(validateStatementDefinitions(run.env, { ...run.input('series'), predicate: id(9) })).rejects.toBeInstanceOf(InvalidContextCommand);
  await expect(validateStatementDefinitions(run.env, run.input('series'), async () => false)).rejects.toBeInstanceOf(ContextCommandUnavailable);
  run.changeMeaning({ roles: [{ key: 'member', minParticipants: 1, maxParticipants: 1, ordered: false }] });
  await expect(run.record('series')).rejects.toBeInstanceOf(RevisionCorrupt);
  run.changeMeaning({ roles: [] });
  run.reviseDefinition();
  await expect(run.record('series')).rejects.toBeInstanceOf(ContextCommandUnavailable);
  expect(run.commands).toHaveLength(0);
  const raced = fixture();
  await expect(raced.record('series', async () => raced.reviseDefinition())).rejects.toBeInstanceOf(ContextCommandUnavailable);
  expect(raced.store.countQuads(null, named(`${RDF}type`), named(`${RDF}Statement`), named(GRAPHS.current))).toBe(0);
});

test('native adoption/rejection/withdrawal preserve actual DecisionSlot CAS and committed request replay', async () => {
  const run = fixture(), recorded = await run.record('reading-list');
  const first = run.decision(recorded.component!, null, 'accepted');
  const firstAdmission = admission(statementDecisionRequest(first));
  run.loseNextReply();
  const accepted = await setStatementDecision(run.env, firstAdmission, first);
  expect(accepted.receipt).toBe(commandReceiptIri(firstAdmission.id, STATEMENT_FAMILIES.decide));
  expect(accepted.component).toBe(decisionSlotIri(first.target, GLOBAL_CLASSIFICATION_CONTEXT));
  const rejectedInput = run.decision(recorded.component!, accepted.revision!, 'rejected');
  const rejected = await setStatementDecision(run.env, admission(statementDecisionRequest(rejectedInput)), rejectedInput);
  const committedCommands = run.commands.length;
  expect(await setStatementDecision(run.env, firstAdmission, first)).toEqual(accepted);
  expect(run.commands).toHaveLength(committedCommands);
  const staleInput = run.decision(recorded.component!, accepted.revision!, 'withdrawn');
  const staleAdmission = admission(statementDecisionRequest(staleInput));
  await expect(setStatementDecision(run.env, staleAdmission, staleInput)).rejects.toBeInstanceOf(StaleContextCommand);
  expect(await readCommandReceipt(run.env, staleAdmission.id, STATEMENT_FAMILIES.decide)).toMatchObject({
    outcome: 'cancelled', reason: 'stale-head', receipt: commandReceiptIri(staleAdmission.id, STATEMENT_FAMILIES.decide),
  });
  expect(run.one(GRAPHS.current, accepted.component!, `${RV}decisionHead`)?.value).toBe(rejected.revision!);
  const withdrawnInput = run.decision(recorded.component!, rejected.revision!, 'withdrawn');
  const withdrawn = await setStatementDecision(run.env, admission(statementDecisionRequest(withdrawnInput)), withdrawnInput);
  expect(run.one(GRAPHS.revisions, withdrawn.revision!, `${RV}predecessor`)?.value).toBe(rejected.revision!);
  expect(run.one(GRAPHS.revisions, withdrawn.revision!, `${RV}outcome`)?.value).toBe(`${RV}Withdrawn`);
  await expect(setStatementDecision(run.env, firstAdmission, { ...first, outcome: 'rejected' })).rejects.toBeInstanceOf(IdempotencyConflict);
});

test('atomic decision CAS rejects a raced head and a per-Statement slot cannot enforce Collection-wide uniqueness', async () => {
  const run = fixture(), first = await run.record('series'), second = await run.record('franchise');
  const adopt = async (statement: string) => {
    const input = run.decision(statement, null, 'accepted');
    return setStatementDecision(run.env, admission(statementDecisionRequest(input)), input);
  };
  const a = await adopt(first.component!), b = await adopt(second.component!);
  expect(a.component).not.toBe(b.component);
  const input = run.decision(first.component!, a.revision!, 'withdrawn');
  run.race(() => run.replace(GRAPHS.current, a.component!, `${RV}decisionHead`, id(88)));
  await expect(setStatementDecision(run.env, admission(statementDecisionRequest(input)), input)).rejects.toBeInstanceOf(StaleContextCommand);
  expect(run.one(GRAPHS.current, a.component!, `${RV}decisionHead`)?.value).toBe(id(88));
  expect(run.one(GRAPHS.current, b.component!, `${RV}decisionHead`)?.value).toBe(b.revision!);
  expect(run.store.countQuads(null, named(`${RDF}type`), named(`${RV}StatementDecision`), named(GRAPHS.revisions))).toBe(2);
});
