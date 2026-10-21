import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { queryRoutes } from '../src/routes/query.ts';
import { workReadRoutes } from '../src/routes/work-reads.ts';
import { nativeCreditDigest } from '../src/modules/profiles/credits.ts';
import { familyReceiptIri } from '../src/modules/semantic/command.ts';
import { hash, prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';
import { WorkReadSession, WorkReadUnavailable, withWorkReadSession } from '../src/modules/work/read-session.ts';
import { RETAINED_CREDIT_ASSOCIATIONS, RETAINED_CREDIT_ASSOCIATIONS_PROFILE,
  retainedCreditAssociationDigest,
  type RetainedCreditAssociationState } from '../src/modules/work/credit-association-state.ts';
import { readRetainedCreditAssociationPage, type AssociationReadOwners } from '../src/modules/query/association-credit.ts';
import { associationConflict, associationCreditsQuery, associationQueryResult, associationResult,
  ASSOCIATION_QUERY, type AssociationCreditProjection, type AssociationSelection,
  type AssociationWitness } from '../src/modules/query/association-contract.ts';
import { associationReadFailure, creditAssociationRequest } from '../src/modules/query/association-read.ts';
import { AssociationCursorInvalid, AssociationStaleQuery, associationMatchSelection } from '../src/modules/query/association-cursor.ts';
import { selectAssociations } from '../src/modules/query/association-selection.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const id = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const receipt = (n: number) => `urn:rezics:receipt:${hash(String(n))}`;
const principal = { issuer: 'https://account.example', subject: 'reader' };
const rows = (...values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
  Object.fromEntries(Object.entries(value).map(([key, text]) => [key, {
    type: text.startsWith('https:') || text.startsWith('urn:') ? 'uri' as const : 'literal' as const, value: text,
  }]))) } });
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Real immutable component encoding, model/credit/receipt readers, query
 * adapter, WorkReadSession dependency fence and continuation owner. Graph,
 * disclosure, Relation/Statement and Source transports are controlled inputs;
 * this establishes no installed adoption, native runtime or persona proof. */
function fixture(count = 6) {
  const directory = join(import.meta.dir, '../../../.temp/query-credit-composition', randomUUID());
  mkdirSync(directory, { recursive: true }); directories.push(directory);
  const live = { epoch: 'credit-epoch', sequence: '100', generation: 'b'.repeat(64),
    activation: true, activationRevision: id(70), projection: true, token: 'initial', withdrawn: false, manifest: true,
    hidden: new Set<string>(), calls: [] as string[], projected: [] as string[], afterProjection: undefined as (() => void) | undefined };
  const entries = Array.from({ length: count }, (_, n) => {
    const native = n === 0;
    const state: RetainedCreditAssociationState = {
      profile: RETAINED_CREDIT_ASSOCIATIONS, credit: id(100 + n), creditRevision: id(1000 + n),
      retainedProfile: native ? 'native-agent-credit-v1' : 'source-reported-credit-v1', work: id(1), workRevision: id(3), role: 'artist',
      origin: native ? { kind: 'stored-credit', revision: id(1000) }
        : { kind: 'selected-publication', decision: id(100 + n), source: id(40), record: id(41), observation: id(42) },
      mapping: { revision: id(21), definition: id(20), workRole: `${id(22)}/role/work`, subjectRole: `${id(22)}/role/artist`,
        originProfile: native ? 'native-agent-credit-v1' : 'source-reported-credit-v1', originRole: 'artist',
        externalNamespace: native ? null : { provider: 'retained', namespace: 'person' } },
      workParticipation: id(3000 + n * 2), subjectParticipation: id(3001 + n * 2),
      participations: [
        { id: id(3000 + n * 2), role: `${id(22)}/role/work`, participant: { kind: 'resource', ref: id(1) }, attributionSupports: [] },
        { id: id(3001 + n * 2), role: `${id(22)}/role/artist`,
          participant: native ? { kind: 'resource', ref: id(50) } : { kind: 'external', provider: 'retained', namespace: 'person', key: 'same-key' },
          ...(native ? {} : { position: n }), creditedName: { lexical: 'Credited alias', language: 'ja' },
          sourceIdentity: { provider: 'retained', namespace: 'person', key: 'same-key', alias: 'Alias', eid: '0042', note: 'line one\nline two' },
          attributionSupports: [{ basis: { kind: 'source-credit', support: id(6000 + n) },
            fields: ['creditedName', 'provider', 'namespace', 'key', 'alias', 'eid', 'note'], evidence: [id(7000 + n)] }] },
      ], context: 'global', applicability: [], qualification: 'asserted',
    };
    const head = id(2000 + n), admission = uuid(2000 + n);
    const manifest = `urn:rezics:sha256:${prepareComponent(directory, state.credit, state, RETAINED_CREDIT_ASSOCIATIONS_PROFILE)}`;
    // The compatibility command owns these immutable values independently of
    // its credit, revision, admission and the currently active generation.
    return { state, head, admission, manifest, n, operation: id(12000 + n),
      modelGeneration: `urn:rezics:model-generation:${live.generation}` };
  });
  const generation = () => `urn:rezics:model-generation:${live.generation}`;
  const query = async (sparql: string): Promise<SparqlResult> => {
    live.calls.push(sparql);
    if (sparql.includes('SELECT ?epoch ?routing ?sequence') || sparql.includes('SELECT ?epoch ?sequence')) {
      return rows({ epoch: live.epoch, routing: 'routing-1', sequence: live.sequence });
    }
    if (sparql.includes('SELECT ?generation')) return rows({ generation: generation() });
    if (sparql.includes('SELECT ?manifest ?number')) return rows({ manifest: `urn:rezics:sha256:${live.generation}`,
      number: '1', entailment: `${RV}NoEntailment`, digest: hash(JSON.stringify({ family: 'model-generation-v1', manifest: live.generation })) });
    if (sparql.includes('SELECT ?work ?credit ?associationHead')) {
      const after = sparql.match(/STR\(\?credit\) > "([^"]+)"/)?.[1];
      const lastWork = sparql.match(/STR\(\?work\) > "([^"]+)"/)?.[1];
      const limit = Number(sparql.match(/LIMIT (\d+)$/)?.[1]);
      const works = sparql.match(/VALUES \?work \{([^}]+)\}/)?.[1];
      return rows(...entries.filter(entry => (!works || works.includes(`<${entry.state.work}>`))
        && (!after || entry.state.work > lastWork! || entry.state.work === lastWork && entry.state.credit > after))
        .slice(0, limit).map(entry => ({ work: entry.state.work, credit: entry.state.credit, associationHead: entry.head })));
    }
    const entry = entries.find(item => sparql.includes(`<${item.state.credit}>`) || sparql.includes(`<${item.head}>`)
      || sparql.includes(`<${workEditReceiptIri(uuid(1000 + item.n))}>`));
    if (!entry) throw new Error(`Unexpected controlled graph query: ${sparql}`);
    const { state, head, n } = entry;
    if (sparql.includes('SELECT ?associationHead')) return rows({ associationHead: head });
    if (sparql.includes('SELECT ?manifest ?predecessor ?receipt')) return live.manifest ? rows({
      manifest: entry.manifest, receipt: familyReceiptIri(entry.admission, RETAINED_CREDIT_ASSOCIATIONS),
      admission: entry.admission, digest: retainedCreditAssociationDigest(state, null), work: state.work,
      creditRevision: state.creditRevision, epoch: live.epoch, sequence: '90', scope: `work:edit:${state.work}`,
      operation: entry.operation, receiptOperation: entry.operation, modelGeneration: entry.modelGeneration,
    }) : rows();
    if (sparql.includes('SELECT ?revision ?kind')) return rows({ revision: state.creditRevision, kind: `${RV}NativeAgentCredit` });
    if (sparql.includes('SELECT ?work ?head ?agent')) return rows({ work: state.work, head: state.workRevision, agent: id(50),
      role: state.role, actor: id(4), epoch: 'credit-epoch', sequence: '12',
      model: 'https://rezics.com/definition/native-agent-credit-v1',
      shape: 'https://rezics.com/definition/native-agent-credit-v1' });
    if (sparql.includes('SELECT DISTINCT ?receipt ?admission')) return rows({ receipt: workEditReceiptIri(uuid(1000 + n)),
      admission: uuid(1000 + n), nativeCommand: 'true' });
    if (sparql.includes('SELECT ?outcome ?reason')) return rows({ outcome: `${RV}Succeeded`,
      digest: nativeCreditDigest({ work: state.work, credit: state.credit, role: 'artist', expectedWorkHead: state.workRevision,
        actingSubject: id(4), agent: id(50) }), admissionId: uuid(1000 + n), authorityEpoch: '7',
      scope: `work:edit:${state.work}`, epoch: 'credit-epoch', sequence: '12', work: state.work,
      revision: state.workRevision, predecessor: state.workRevision });
    if (sparql.includes('SELECT DISTINCT ?credit ?revision ?intent')) return rows({ credit: state.credit,
      revision: state.creditRevision, intent: state.credit });
    if (sparql.includes('SELECT ?workHead ?creditHead')) return rows({ workHead: state.workRevision, creditHead: state.creditRevision,
      epoch: live.epoch, routing: 'routing-1' });
    throw new Error(`Unexpected controlled graph query: ${sparql}`);
  };
  const environment = { fuseki: { query }, objectDirectory: directory,
    lineage: { dataEpoch: 'credit-epoch', routingEpoch: 'routing-1' } } as unknown as WorkActivationEnvironment;
  const owners: AssociationReadOwners = {
    retainedCredits: {
      async activation() { return live.activation ? { profile: RETAINED_CREDIT_ASSOCIATIONS, generation: generation(),
        revision: live.activationRevision, receipt: receipt(70), coverageRevision: id(71), coverageReceipt: receipt(71), complete: true } : null; },
      async mapping(input) { return { mapping: input.mapping, generation: generation(), receipt: receipt(72), validationToken: hash('mapping') }; },
      async coverage(input) { return live.hidden.has(input.view.credit) ? { state: 'withheld' } : { state: 'covered',
        generation: generation(), revision: id(73), receipt: receipt(73), adoption: id(74), complete: true,
        statements: [{ statement: id(8000 + entries.find(item => item.state.credit === input.view.credit)!.n),
          revision: id(9000), decisionRevision: id(10000) }] }; },
      async origin({ view }) { return { credit: view.credit, creditRevision: view.creditRevision, work: view.work,
        workRevision: view.workRevision, role: view.role, retainedProfile: view.retainedProfile, origin: view.origin,
        receipt: receipt(80), participations: view.participations, validation: [] }; },
      async attribution({ participation, support }) { return { basis: support.basis,
        state: live.withdrawn ? 'withdrawn' : 'current', receipt: receipt(81), validationToken: hash(String(live.withdrawn)),
        fields: { creditedName: participation.creditedName, ...participation.sourceIdentity }, evidence: support.evidence }; },
    },
    creditProjection: {
      async basis() { if (!live.projection) throw new WorkReadUnavailable('Controlled projection owner unavailable');
        return hash(JSON.stringify([live.token, live.withdrawn, [...live.hidden]])); },
      async read(_session, _selection, view) {
        live.projected.push(view.occurrence);
        const citation: AssociationWitness['citations'][number] = { id: id(7000), sourceWork: id(40),
          representationSha256: 'a'.repeat(64), locator: { pointer: '/credits/0' }, quote: null, quoteWithheld: true,
          method: { kind: 'retained' }, modality: 'text', submitter: id(4), rightsBasis: 'retained-rights' };
        const proof = view.coverage.statements[0]!;
        const projection: AssociationCreditProjection = { statements: [{ id: proof.statement, revision: proof.revision,
          decisionRevision: proof.decisionRevision, subject: view.state.participations[1]!.participant,
          predicate: id(75), value: { kind: 'language-string', lexical: 'red', language: 'en' }, occurrence: view.occurrence,
          context: 'global', applicability: [], qualification: 'asserted', citations: [citation] }], citations: [citation],
          sourceVersionStatus: 'exact', labels: { subject: null, role: 'artist', work: 'Work' }, snippets: [], links: [] };
        live.afterProjection?.();
        return projection;
      },
    },
  };
  const deps = { environment, subjectAssociations: owners,
    access: { assertRecoveryOpen: async () => {}, activePrincipalId: async () => id(4) } } as unknown as MainWorkDependencies;
  const selection = (extra: Partial<AssociationSelection['parameters']> = {}, limit = 2) => selectAssociations({
    profile: 'template-query-v1', query: ASSOCIATION_QUERY, revision: 1, parameters: { kind: 'credit',
      direction: 'work-to-subject', roots: [{ kind: 'resource', ref: id(1) }], projection: 'occurrence', context: 'global',
      frame: [], position: 'start', match: { all: [], any: [], none: [] }, ...extra }, presentation: { language: 'en' }, limit });
  const session = (selected: AssociationSelection, cursor?: string) => {
    const result = new WorkReadSession(deps, new Request('http://main.test/v1/query', { method: 'POST' }),
      { ...selected.presentation, localBasis: true, cursor }, { dataEpoch: live.epoch, sequence: live.sequence });
    result.principal = principal;
    // Current Work disclosure is an owner input here, not a replacement for the
    // credit reader or a public native/Access integration claim.
    result.summaries = async resources => resources.map(reference => ({ reference, status: 'available',
      label: { value: 'Work', language: 'en', direction: 'ltr' }, avatar: { kind: 'fallback', policy: 'test', key: reference, resourceType: 'work' } })) as never;
    return result;
  };
  const page = async (selected = selection(), cursor?: string, surface: 'query' | 'work-credits' = 'query') => {
    const current = session(selected, cursor);
    return withWorkReadSession(current, async () => {
      const value = await readRetainedCreditAssociationPage(current, selected, owners, surface, cursor);
      await current.fenceDependencies(); return value;
    });
  };
  return { live, entries, environment, deps, owners, selection, session, page };
}

test('sealed credit identity, exact head, native/external participations and supported attribution survive both surfaces', async () => {
  const f = fixture();
  const generic = await f.page();
  const dedicated = await f.page(f.selection(), undefined, 'work-credits');
  expect(Value.Check(associationResult, generic)).toBe(true);
  expect(dedicated.items).toEqual(generic.items);
  expect(Value.Check(associationQueryResult, { profile: 'query-v1', template: ASSOCIATION_QUERY, selection: f.selection(), result: generic })).toBe(true);
  const items = generic.items as AssociationWitness[];
  for (const [n, item] of items.entries()) {
    expect(item.occurrence).toBe(f.entries[n]!.state.credit);
    expect(item.revision).toBe(f.entries[n]!.head);
    const { attributionSupports: _supports, ...shown } = f.entries[n]!.state.participations[1]!;
    expect(item.participations[1]).toEqual(shown);
  }
  expect(items[0]!.subject).toEqual({ kind: 'resource', ref: id(50) });
  expect(items[1]!.subject).toEqual({ kind: 'external', provider: 'retained', namespace: 'person', key: 'same-key' });
  expect(items[1]!.participations[1]!.sourceIdentity).toEqual(f.entries[1]!.state.participations[1]!.sourceIdentity);
  expect(items[1]!.participations[1]!.creditedName).toEqual({ lexical: 'Credited alias', language: 'ja' });
  await expect(f.page(f.selection(), generic.nextCursor!, 'work-credits')).rejects.toBeInstanceOf(AssociationCursorInvalid);
  await expect(f.page(f.selection(), dedicated.nextCursor!)).rejects.toBeInstanceOf(AssociationCursorInvalid);
});

test('sparse inverse windows continue past withheld views without invented participation IDs, loss or duplicate credits', async () => {
  const f = fixture(7);
  for (const entry of f.entries.slice(0, 4)) f.live.hidden.add(entry.state.credit);
  const selected = f.selection({ direction: 'subject-to-work', roots: [
    { kind: 'external', provider: 'retained', namespace: 'person', key: 'same-key' } ] });
  const seen: string[] = []; let cursor: string | undefined; let pages = 0;
  do {
    const result = await f.page(selected, cursor); pages++;
    if (pages < 3) { expect(result.items).toEqual([]); expect(result.complete).toBe(false); }
    seen.push(...(result.items as AssociationWitness[]).map(item => item.occurrence));
    cursor = result.nextCursor ?? undefined;
  } while (cursor && pages < 10);
  expect(cursor).toBeUndefined(); expect(pages).toBe(4);
  expect(seen).toEqual(f.entries.slice(4).map(entry => entry.state.credit));
  expect(f.live.projected.every(credit => !f.live.hidden.has(credit))).toBe(true);
});

test('distinct Work projection uses the same exact sealed match continuation', async () => {
  const f = fixture(5), selected = f.selection({ projection: 'work' }, 1);
  const first = await f.page(selected);
  expect(first.complete).toBe(true); expect(first.count.value).toBe(1);
  const group = first.items[0]!;
  if (!('matches' in group)) throw new Error('Expected Work matches');
  expect(group.matches.complete).toBe(false);
  const seen = group.matches.items.map(item => item.occurrence);
  let cursor = group.matches.nextCursor;
  while (cursor) {
    const page = await f.page(associationMatchSelection(selected, group.work), cursor);
    seen.push(...(page.items as AssociationWitness[]).map(item => item.occurrence)); cursor = page.nextCursor;
  }
  expect(seen).toEqual(f.entries.map(entry => entry.state.credit));
});

test('empty inventories require activation and projection owners; missing immutable views cannot become empty success', async () => {
  const f = fixture(0);
  f.live.activation = false;
  await expect(f.page()).rejects.toBeInstanceOf(WorkReadUnavailable);
  f.live.activation = true; f.live.projection = false;
  await expect(f.page()).rejects.toBeInstanceOf(WorkReadUnavailable);
  f.live.projection = true;
  for (const name of ['mapping', 'coverage', 'origin', 'attribution'] as const) {
    const original = f.owners.retainedCredits![name]; delete f.owners.retainedCredits![name];
    await expect(f.page()).rejects.toBeInstanceOf(WorkReadUnavailable);
    Object.assign(f.owners.retainedCredits!, { [name]: original });
  }
  delete f.owners.creditProjection;
  await expect(f.page()).rejects.toBeInstanceOf(WorkReadUnavailable);
  const g = fixture(1); g.live.manifest = false;
  await expect(g.page()).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('continuation fences source sequence, model/restore, activation, evidence and actual reader; withdrawal omits unsupported fields', async () => {
  const f = fixture();
  const first = await f.page();
  for (const change of [() => f.live.sequence = '101', () => f.live.generation = 'c'.repeat(64),
    () => { f.live.epoch = 'restored-epoch'; f.environment.lineage.dataEpoch = f.live.epoch; },
    () => f.live.activationRevision = id(79), () => f.live.token = 'changed', () => f.live.withdrawn = true]) {
    const before = { sequence: f.live.sequence, generation: f.live.generation, epoch: f.live.epoch,
      activationRevision: f.live.activationRevision, token: f.live.token, withdrawn: f.live.withdrawn };
    change(); await expect(f.page(f.selection(), first.nextCursor!)).rejects.toBeInstanceOf(AssociationStaleQuery);
    Object.assign(f.live, before);
    f.environment.lineage.dataEpoch = f.live.epoch;
  }
  const current = f.session(f.selection()); current.principal = { ...principal, subject: 'another-reader' };
  await expect(readRetainedCreditAssociationPage(current, f.selection(), f.owners, 'query', first.nextCursor!))
    .rejects.toBeInstanceOf(AssociationCursorInvalid);
  f.live.withdrawn = true;
  const fresh = await f.page();
  const item = fresh.items[0] as AssociationWitness;
  expect(item.occurrence).toBe(id(100)); expect(item.subject).toEqual({ kind: 'resource', ref: id(50) });
  expect(item.participations[1]!.creditedName).toBeUndefined(); expect(item.participations[1]!.sourceIdentity).toBeUndefined();
  f.live.afterProjection = () => f.live.token = 'moved-during-read';
  await expect(f.page()).rejects.toBeInstanceOf(AssociationStaleQuery);
});

test('query witness requires the exact adopted Statement revisions and cannot substitute a newer projection', async () => {
  const f = fixture(1), original = f.owners.creditProjection!.read;
  f.owners.creditProjection!.read = async (...args) => {
    const projection = await original(...args);
    return projection && { ...projection, statements: projection.statements.map(statement => ({ ...statement, revision: id(9999) })) };
  };
  await expect(f.page()).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('admitted POST and opt-in GET fail closed until actual owners exist; other template roots and default credits remain separate', async () => {
  const f = fixture(0), selected = f.selection();
  const routes = queryRoutes(f.environment.fuseki, f.deps);
  const post = (body: unknown) => routes.handle(new Request('http://main.test/v1/query', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const unavailable = await post(selected);
  expect(unavailable.status).toBe(503); expect((await unavailable.json()).code).toBe('work_read_unavailable');
  expect((await post({ ...selected, parameters: { ...selected.parameters, roots: [] } })).status).toBe(422);
  const inverse = { ...selected, parameters: { ...selected.parameters, direction: 'subject-to-work',
    roots: [{ kind: 'external', provider: 'retained', namespace: 'person', key: 'same-key' }] } };
  expect((await post(inverse)).status).toBe(503);
  expect((await post({ ...inverse, query: 'https://rezics.com/query/work-credits' })).status).toBe(422);
  const get = workReadRoutes(f.deps);
  const params = new URLSearchParams({ profile: 'subject-associations-v1', context: 'global', limit: '64', position: 'start' });
  params.append('frame', id(10)); params.append('frame', id(11));
  const response = await get.handle(new Request(`http://main.test/v1/works/${uuid(1)}/credits?${params}`));
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 503, body: { code: 'work_read_unavailable' } });
  expect((await get.handle(new Request(`http://main.test/v1/works/${uuid(1)}/credits?limit=64`))).status).toBe(422);
  expect(Value.Check(associationCreditsQuery, { profile: 'subject-associations-v1', limit: 64, frame: [id(10), id(11)] })).toBe(true);
  const normalized = selectAssociations(creditAssociationRequest(id(1), { profile: 'subject-associations-v1', limit: 64 }));
  expect(normalized.parameters).toEqual({ ...selected.parameters });
  const failure = associationReadFailure(new AssociationStaleQuery(normalized))!;
  expect(failure.status).toBe(409); expect(Value.Check(associationConflict, await failure.json())).toBe(true);
});


// Independent caller diagnostics: original fixture/assertions above remain byte-for-byte.
// These are controlled-owner checks, not installed public outcome acceptance.
test('independent caller: live Account revocation must still fence the composed credit page', async () => {
  const f = fixture(1), selected = f.selection(), current = f.session(selected);
  let revoked = false, validations = 0;
  current.principal = { ...principal, currentAssertion: async () => {
    validations++;
    if (revoked) throw new Error('independent-account-revoked');
    return principal;
  } };
  f.live.afterProjection = () => { revoked = true; };
  await expect(withWorkReadSession(current, async () => {
    const result = await readRetainedCreditAssociationPage(current, selected, f.owners, 'query');
    await current.fenceDependencies();
    await current.fenceAuthority();
    return result;
  })).rejects.toThrow('independent-account-revoked');
  expect(validations).toBeGreaterThan(0);
});

test('independent caller: expiry on the enclosing principal must reach the retained reader', async () => {
  const f = fixture(1), selected = f.selection(), current = f.session(selected);
  current.principal = { ...principal, accountExpiresAt: Math.floor(Date.now() / 1000) - 1 } as typeof current.principal;
  await expect(readRetainedCreditAssociationPage(current, selected, f.owners, 'query')).rejects.toThrow();
});

test('independent caller: public viewer live revocation must fence a global credit page', async () => {
  const f = fixture(1), selected = f.selection(), prepared = f.session(selected);
  let revoked = false;
  const liveReader = { ...principal, currentAssertion: async () => {
    if (revoked) throw new Error('independent-public-account-revoked');
    return principal;
  } };
  const { disclosureViewer } = await import('../src/modules/disclosure/viewer.ts');
  const current = new WorkReadSession(f.deps, prepared.request,
    { ...prepared.options, publicViewer: disclosureViewer(liveReader) }, { ...prepared.position });
  current.summaries = prepared.summaries;
  f.live.afterProjection = () => { revoked = true; };
  await expect(withWorkReadSession(current, async () => {
    const result = await readRetainedCreditAssociationPage(current, selected, f.owners, 'query');
    await current.fenceDependencies();
    await current.fenceAuthority();
    return result;
  })).rejects.toThrow('independent-public-account-revoked');
});

for (const phase of ['empty-page', 'withheld-disclosure', 'withheld-coverage'] as const) {
  test(`independent caller: ${phase} must close live Account revocation`, async () => {
    const f = fixture(phase === 'empty-page' ? 0 : 1), selected = f.selection(), current = f.session(selected);
    let revoked = false;
    current.principal = { ...principal, currentAssertion: async () => {
      if (revoked) throw new Error('independent-account-revoked');
      return principal;
    } };
    if (phase === 'empty-page') {
      const query = f.environment.fuseki.query.bind(f.environment.fuseki);
      f.environment.fuseki.query = async (...args) => {
        const value = await query(...args);
        if (args[0].includes('SELECT ?work ?credit ?associationHead')) revoked = true;
        return value;
      };
    } else if (phase === 'withheld-disclosure') {
      current.summaries = async () => { revoked = true; return []; };
    } else {
      f.live.hidden.add(id(100));
      const coverage = f.owners.retainedCredits!.coverage!;
      f.owners.retainedCredits!.coverage = async (input) => { const value = await coverage(input); revoked = true; return value; };
    }
    await expect(withWorkReadSession(current, async () => {
      const result = await readRetainedCreditAssociationPage(current, selected, f.owners, 'query');
      await current.fenceDependencies();
      await current.fenceAuthority();
      return result;
    })).rejects.toThrow('independent-account-revoked');
  });
}

test('independent caller: changed live Account disclosure must restart the page', async () => {
  const f = fixture(1), selected = f.selection(), current = f.session(selected);
  let changed = false;
  current.principal = { ...principal, emailVerified: true, currentAssertion: async () => ({ ...principal, emailVerified: !changed }) };
  f.live.afterProjection = () => { changed = true; };
  await expect(withWorkReadSession(current, async () => {
    const result = await readRetainedCreditAssociationPage(current, selected, f.owners, 'query');
    await current.fenceDependencies();
    await current.fenceAuthority();
    return result;
  })).rejects.toBeInstanceOf(AssociationStaleQuery);
});

test('independent caller: an Account token expiring during hydration must refuse completion', async () => {
  const { setSystemTime } = await import('bun:test');
  const f = fixture(1), selected = f.selection(), current = f.session(selected);
  const expiry = Math.floor(Date.now() / 1000) + 300;
  current.principal = { ...principal, accountExpiresAt: expiry } as typeof current.principal;
  f.live.afterProjection = () => setSystemTime(new Date((expiry + 1) * 1000));
  try {
    await expect(withWorkReadSession(current, async () => {
      const result = await readRetainedCreditAssociationPage(current, selected, f.owners, 'query');
      await current.fenceDependencies();
      await current.fenceAuthority();
      return result;
    })).rejects.toThrow();
  } finally { setSystemTime(); }
});

test('live Account authority stays with the retained reader while projections and renewed continuations use serializable positions', async () => {
  const f = fixture(3), selected = f.selection({}, 1);
  const identity = { ...principal, emailVerified: true, accountDisplayName: 'Reader', accountAuthMode: 'oauth',
    accountClientId: 'catalogue-client', accountConsentId: 'consent', accountConsentGeneration: '7',
    accountAudiences: ['https://main.example'], accountScopes: ['catalogue:read'] };
  let expiry = Math.floor(Date.now() / 1000) + 300, validations = 0, projections = 0;
  const currentAssertion = async () => { validations++; return { ...identity, accountExpiresAt: expiry }; };
  const activation = f.owners.retainedCredits!.activation!;
  f.owners.retainedCredits!.activation = async input => {
    expect(input.principal).toMatchObject({ ...identity, accountExpiresAt: expiry });
    expect(input.principal.currentAssertion).toBe(currentAssertion);
    return activation(input);
  };
  const projection = f.owners.creditProjection!.basis;
  f.owners.creditProjection!.basis = async (session, selection, position) => {
    projections++;
    expect(Object.keys(position).sort()).toEqual(['activation', 'generation', 'reader', 'sourcePosition']);
    expect(position.reader).toEqual(identity);
    expect(structuredClone(position)).toEqual(position);
    return projection(session, selection, position);
  };
  const page = async (cursor?: string) => {
    const current = f.session(selected, cursor);
    const authority = { ...identity, accountExpiresAt: expiry, currentAssertion };
    current.principal = authority;
    return withWorkReadSession(current, async () => {
      const result = await readRetainedCreditAssociationPage(current, selected, f.owners, 'query', cursor);
      await current.fenceDependencies();
      await current.fenceAuthority();
      return result;
    });
  };
  const first = await page();
  expect(first.nextCursor).not.toBeNull();
  expiry += 300;
  const next = await page(first.nextCursor!);
  expect((next.items as AssociationWitness[])[0]!.occurrence).not.toBe((first.items as AssociationWitness[])[0]!.occurrence);
  expect(validations).toBeGreaterThan(0);
  expect(projections).toBeGreaterThan(1);
});
