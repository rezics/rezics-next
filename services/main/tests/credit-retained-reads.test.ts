import { expect, test, setSystemTime } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Parser } from 'n3';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import type { CommandEnvelope, SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import {
  AccountAssertionDenied,
  AccountAssertionUnavailable,
  AccountAssertionVerifier,
  type VerifiedAccountAssertion,
} from '../src/modules/account/verify-assertion.ts';
import { familyReceiptIri, readComponent, StaleSemanticHead, type SemanticAdmission } from '../src/modules/semantic/command.ts';
import { MODEL_COMPONENT, PROFILES } from '../src/modules/semantic/schema.ts';
import { nativeCreditDigest } from '../src/modules/profiles/credits.ts';
import {
  hash,
  GRAPHS,
  iri,
  lit,
  prepareComponent,
  RV,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { authorCreditDigest, authorCreditEnvelope, authorCreditTriples, creditProfile,
  type AuthorCreditValue } from '../src/modules/work/author-credit.ts';
import { readCreditOwnerWitness } from '../src/modules/work/credit-verification.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';
import {
  canonicalCreditValue,
  checkedRetainedCreditAssociationState,
  retainedCreditAssociationDigest,
  RETAINED_CREDIT_ASSOCIATIONS,
  RETAINED_CREDIT_ASSOCIATIONS_PROFILE,
  type RetainedCreditAssociationState,
  type CreditAttributionField,
  type RetainedCreditMapping,
} from '../src/modules/work/credit-association-state.ts';
import {
  openRetainedCreditAssociationRead,
  openRetainedCreditIdentityRead,
  fenceRetainedCreditIdentityRead,
  RetainedCreditOriginUnavailable,
  fenceRetainedCreditAssociationRead,
  readRetainedCreditAssociationCandidates,
  readRetainedCreditAssociationView,
  readSealedRetainedCreditAssociation,
  resolveRetainedCreditAssociationIdentity,
  RetainedCreditReadMoved,
  RetainedCreditReadUnavailable,
  type RetainedCreditAssociationReadDependencies,
  type RetainedCreditSourceValidation,
} from '../src/modules/work/credit-association-read.ts';
import { bindRetainedCreditAssociation, prepareRetainedCreditBinding,
  type RetainedCreditBindingDependencies, type RetainedCreditBindingInput } from '../src/modules/work/credit-association-write.ts';
import { loadRetainedCreditBinding, type RetainedCreditBindingRequest, type RetainedCreditOriginDependencies,
  type RetainedCreditSelection } from '../src/modules/work/credit-association-origin.ts';
import { creditAttributionOwner, retainedCreditAttributionReader } from '../src/modules/work/credit-attribution.ts';
import type { RelationAttributionOwner } from '../src/modules/relation/attribution.ts';
import type { RelationPublication } from '../src/modules/relation/change.ts';
import { NATIVE_CREDIT_ROLES, type NativeCreditRole } from '../src/modules/work/credit-roles.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const id = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const receipt = (n: number) => `urn:rezics:receipt:${hash(String(n))}`;
const principal: VerifiedPrincipal = { issuer: 'https://account.example', subject: 'reader' };
const rows = (...values: Record<string, string>[]): SparqlResult => ({
  results: {
    bindings: values.map((value) =>
      Object.fromEntries(
        Object.entries(value).map(([key, text]) => [
          key,
          {
            type: text.startsWith('https:') || text.startsWith('urn:') ? 'uri' : 'literal',
            value: text,
          },
        ]),
      ),
    ),
  },
});
const attributedFields: CreditAttributionField[] = [
  'creditedName',
  'provider',
  'namespace',
  'key',
  'alias',
  'eid',
  'note',
];

/** Account's actual verifier produces the live enumerable callback. Only its
 * issuer HTTP transport is local; no Account or read-owner module is mocked. */
async function accountReader() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'credit-reader', alg: 'RS256', use: 'sig' };
  const state = { active: true, emailVerified: true, available: true, calls: 0 };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/jwks') return Response.json({ keys: [jwk] });
      state.calls++;
      if (!state.available) return new Response('unavailable', { status: 503 });
      return Response.json({
        active: state.active,
        iss: principal.issuer,
        sub: principal.subject,
        aud: 'main-credit-read',
        scope: 'work:read',
        client_id: 'credit-reader',
        email_verified: state.emailVerified,
        exp: Math.floor(Date.now() / 1000) + 300,
        rezics_content_evidence: {
          age: 'adult',
          country: 'US',
          accountEligible: true,
          adultAvailable: true,
          categories: { general: true, r15: true, r18: false, r18g: false },
        },
      });
    },
  });
  try {
    const token = await new SignJWT({
      rezics_auth_mode: 'user',
      rezics_consent_id: 'credit-read-consent',
      rezics_consent_generation: '1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'credit-reader' })
      .setIssuer(principal.issuer)
      .setSubject(principal.subject)
      .setAudience('main-credit-read')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const base = `http://127.0.0.1:${server.port}`;
    const verifier = new AccountAssertionVerifier({
      issuer: principal.issuer,
      audience: 'main-credit-read',
      jwksUrl: `${base}/jwks`,
      introspectUrl: `${base}/introspect`,
      clientId: 'credit-reader',
      clientSecret: 'test-secret',
    });
    const reader = await verifier.verify(
      new Request('https://main.test/v1/works/credits', {
        headers: { authorization: `Bearer ${token}` },
      }),
      ['work:read'],
    );
    return { reader, state, close: () => server.stop(true) };
  } catch (error) {
    await server.stop(true);
    throw error;
  }
}

/** Actual immutable component encoding and credit/receipt readers; graph and
 * relation/Source authority transports are bounded doubles. This grants no
 * installed activation, provider adoption or public API outcome coverage. */
function fixture(
  agent = true,
  role: NativeCreditRole = 'artist',
  provider = 'vndb',
  namespace = 'staff',
  readerPrincipal: VerifiedPrincipal = principal,
) {
  const directory = join(import.meta.dir, '../../../.temp/retained-credit-reads', randomUUID());
  mkdirSync(directory, { recursive: true });
  const value: AuthorCreditValue = {
    credit: id(2),
    revision: id(5),
    work: id(1),
    expectedHead: id(3),
    actingSubject: id(4),
    role,
    sourceKey: 'same-key',
    sourceRoleKey: null,
    nativeOrdinal: 2,
    provider,
    namespace,
    ...(role === 'performer' ? { modelRevision: `https://rezics.com/definition/${agent ? 'native-agent-credit' : 'work-author-credit'}-v2` } : {}),
    ...(agent ? { agent: id(6) } : {}),
  };
  const state: RetainedCreditAssociationState = {
    profile: RETAINED_CREDIT_ASSOCIATIONS,
    credit: id(2),
    creditRevision: id(5),
    retainedProfile: agent ? 'native-agent-credit-v1' : 'work-author-credit-v1',
    work: id(1),
    workRevision: id(3),
    role,
    origin: { kind: 'stored-credit', revision: id(5) },
    mapping: {
      revision: id(32),
      definition: id(31),
      workRole: `${id(30)}/role/work`,
      subjectRole: `${id(30)}/role/${role}`,
      originProfile: agent ? 'native-agent-credit-v1' : 'work-author-credit-v1',
      originRole: role,
      externalNamespace: agent ? null : { provider, namespace },
    },
    workParticipation: id(40),
    subjectParticipation: id(41),
    participations: [
      {
        id: id(40),
        role: `${id(30)}/role/work`,
        participant: { kind: 'resource', ref: id(1) },
        attributionSupports: [],
      },
      {
        id: id(41),
        role: `${id(30)}/role/${role}`,
        participant: agent
          ? { kind: 'resource', ref: id(6) }
          : { kind: 'external', provider, namespace, key: 'same-key' },
        ...(agent ? {} : { position: 2 }),
        attributionSupports: [],
      },
    ],
    context: 'global',
    applicability: [],
    qualification: 'asserted',
  };
  const live = {
    head: id(100),
    epoch: 'credit-epoch',
    routing: 'routing-1',
    sequence: '100',
    held: false,
    native: true,
    legacy: true,
    nativeRetired: false,
    nativeProtected: false,
    nativeErased: false,
    headAvailable: true,
    viewsAvailable: true,
    viewRows: 1,
    receiptOverride: null as string | null,
    digestOverride: null as string | null,
    manifestOverride: null as string | null,
    activation: true,
    activationComplete: true,
    activationRevision: id(70),
    mapping: true,
    coverage: true,
    withheld: false,
    readable: true,
    sourceIntent: id(2),
    generation: 'b'.repeat(64),
    sourceState: new Map<string, 'current' | 'withdrawn'>([
      [id(60), 'current'],
      [id(61), 'current'],
    ]),
    sourceCalls: 0,
    mappingCalls: 0,
    readCalls: 0,
    queries: [] as string[],
    afterSource: undefined as (() => void) | undefined,
    afterMapping: undefined as (() => void) | undefined,
    afterRead: undefined as (() => void) | undefined,
    beforeCommand: undefined as (() => void) | undefined,
    lostReply: false,
    writing: false,
    candidates: undefined as Record<string, string>[] | undefined,
  };
  const sealed = new Map<
    string,
    {
      state: RetainedCreditAssociationState;
      manifest: string;
      predecessor: string | null;
      admission: string;
      sequence?: string;
      operation?: string;
      receiptOperation?: string;
      modelGeneration?: string;
    }
  >();
  const commands: CommandEnvelope[] = [];
  const terminals = new Map<string, Record<string, string>>();
  const definitions = new Map<string, { definition: string; manifest: string }>();
  const mappings = new Map<string, RetainedCreditMapping>();
  const store = (
    stored: RetainedCreditAssociationState = state,
    head = live.head,
    predecessor: string | null = null,
  ) => {
    const snapshot = checkedRetainedCreditAssociationState(stored);
    const manifest = `urn:rezics:sha256:${prepareComponent(directory, state.credit, snapshot, RETAINED_CREDIT_ASSOCIATIONS_PROFILE)}`;
    const operation = `https://rezics.com/id/${randomUUID()}`;
    sealed.set(head, {
      state: snapshot,
      manifest,
      predecessor,
      admission: head.split('/').at(-1)!,
      operation,
      receiptOperation: operation,
      modelGeneration: generation(),
    });
    mappings.set(snapshot.mapping.revision, structuredClone(snapshot.mapping));
    return head;
  };
  const generation = () => `urn:rezics:model-generation:${live.generation}`;
  const nativeDigest = () =>
    live.native
      ? nativeCreditDigest({
          work: value.work,
          credit: value.credit,
          role: value.role!,
          expectedWorkHead: value.expectedHead,
          actingSubject: value.actingSubject,
          ...(agent
            ? { agent: value.agent! }
            : {
                participant: {
                  kind: 'external-reference',
                  provider,
                  namespace,
                  key: value.sourceKey,
                },
                ordinal: value.nativeOrdinal,
              }),
        })
      : authorCreditDigest(value, live.sourceIntent);
  const query = async (sparql: string): Promise<SparqlResult> => {
    live.queries.push(sparql);
    if (live.writing) {
      if (sparql.includes('rv:rejectionKind rv:InvalidProfile')) return { boolean: false };
      if (sparql.includes('SELECT ?definition ?manifest ?kind ?model')) {
        const entry = [...definitions].find(([revision]) => sparql.includes(`<${revision}> a rv:DefinitionRevision`))?.[1];
        return entry ? rows({ ...entry, kind: RV + 'RelationDefinition', model: PROFILES.definitionV2 }) : rows();
      }
      if (sparql.includes('ASK') && sparql.includes('rv:definitionHead')) return { boolean: live.mapping };
      if (sparql.includes('SELECT ?outcome ?reason ?kind ?digest')) {
        const ref = sparql.match(/<urn:rezics:receipt:[0-9a-f]{64}>/)?.[0].slice(1, -1);
        return ref && terminals.has(ref) ? rows(terminals.get(ref)!) : rows();
      }
    }
    if (sparql.includes('SELECT ?epoch ?routing ?sequence'))
      return live.held
        ? rows()
        : rows({ epoch: live.epoch, routing: live.routing, sequence: live.sequence });
    if (sparql.includes('SELECT ?generation')) return rows({ generation: generation() });
    if (sparql.includes('SELECT ?manifest ?number'))
      return rows({
        manifest: `urn:rezics:sha256:${live.generation}`,
        number: '1',
        entailment: `${RV}NoEntailment`,
        digest: hash(JSON.stringify({ family: 'model-generation-v1', manifest: live.generation })),
      });
    if (sparql.includes('SELECT ?work ?credit ?associationHead'))
      return rows(
        ...(live.candidates ??
          (live.headAvailable
            ? [{ work: value.work, credit: value.credit, associationHead: live.head }]
            : [])),
      );
    if (sparql.includes('SELECT ?associationHead'))
      return live.headAvailable && !live.nativeRetired && !live.nativeProtected
        ? rows({ associationHead: live.head })
        : rows();
    if (sparql.includes('SELECT ?manifest ?predecessor ?receipt')) {
      const entry = [...sealed].find(([head]) =>
        sparql.includes(`<${head}> a rv:RetainedCreditAssociationRevision`),
      )?.[1];
      if (!entry || !live.viewsAvailable) return rows();
      return rows(
        ...Array.from({ length: live.viewRows }, () => ({
          manifest: live.manifestOverride ?? entry.manifest,
          ...(entry.predecessor ? { predecessor: entry.predecessor } : {}),
          receipt:
            live.receiptOverride ?? familyReceiptIri(entry.admission, RETAINED_CREDIT_ASSOCIATIONS),
          admission: entry.admission,
          digest:
            live.digestOverride ?? retainedCreditAssociationDigest(entry.state, entry.predecessor),
          work: entry.state.work,
          creditRevision: entry.state.creditRevision,
          epoch: live.epoch,
          sequence: entry.sequence ?? '80',
          scope: `work:edit:${entry.state.work}`,
          ...(entry.operation === undefined ? {} : { operation: entry.operation }),
          ...(entry.receiptOperation === undefined ? {} : { receiptOperation: entry.receiptOperation }),
          ...(entry.modelGeneration === undefined ? {} : { modelGeneration: entry.modelGeneration }),
        })),
      );
    }
    if (sparql.includes('SELECT ?revision ?kind'))
      return live.legacy && !live.nativeRetired
        ? rows({
            revision: value.revision,
            kind: `${RV}${agent ? 'NativeAgentCredit' : 'AuthorCredit'}`,
          })
        : rows();
    if (sparql.includes('SELECT ?work ?head ?agent'))
      return live.nativeErased
        ? rows()
        : rows({
            work: value.work,
            head: value.expectedHead,
            agent: value.agent!,
            role: value.role!,
            model: value.modelRevision ?? 'https://rezics.com/definition/native-agent-credit-v1',
            shape: value.modelRevision ?? 'https://rezics.com/definition/native-agent-credit-v1',
            ...(value.modelRevision ? { currentModel: value.modelRevision } : {}),
            actor: value.actingSubject,
            epoch: 'credit-epoch',
            sequence: '12',
          });
    if (sparql.includes('SELECT ?work ?head ?key'))
      return live.nativeErased
        ? rows()
        : rows({
            work: value.work,
            head: value.expectedHead,
            key: value.sourceKey,
            creditRole: value.role!,
            model: value.modelRevision ?? 'https://rezics.com/definition/work-author-credit-v1',
            shape: value.modelRevision ?? 'https://rezics.com/definition/work-author-credit-v1',
            ...(value.modelRevision ? { currentModel: value.modelRevision } : {}),
            provider: value.provider!,
            namespace: value.namespace!,
            ordinal: String(value.nativeOrdinal),
            actor: value.actingSubject,
            epoch: 'credit-epoch',
            sequence: '12',
            ...(value.sourceRoleKey ? { role: value.sourceRoleKey } : {}),
          });
    if (sparql.includes('SELECT DISTINCT ?receipt ?admission'))
      return rows({
        receipt: workEditReceiptIri(uuid(5)),
        admission: uuid(5),
        nativeCommand: String(live.native),
      });
    if (sparql.includes('SELECT ?outcome ?reason'))
      return rows({
        outcome: `${RV}Succeeded`,
        digest: nativeDigest(),
        admissionId: uuid(5),
        authorityEpoch: '7',
        scope: `work:edit:${value.work}`,
        epoch: 'credit-epoch',
        sequence: '12',
        work: value.work,
        revision: value.expectedHead,
        predecessor: value.expectedHead,
      });
    if (sparql.includes('SELECT DISTINCT ?credit ?revision ?intent'))
      return rows({ credit: value.credit, revision: value.revision, intent: live.sourceIntent });
    if (sparql.includes('SELECT ?workHead ?creditHead'))
      return live.nativeRetired || live.nativeProtected || live.nativeErased
        ? rows()
        : rows({
            workHead: value.expectedHead,
            creditHead: value.revision,
            epoch: live.epoch,
            routing: live.routing,
          });
    throw new Error(`Unexpected graph query: ${sparql}`);
  };
  const deps: RetainedCreditAssociationReadDependencies = {
    environment: {
      fuseki: { query, async commandHealth() {
        return { profiles: Object.fromEntries(Object.entries(profileRegistry).map(([name, profile]) => [name, profile.sha256])) };
      }, async commandWithReceipt(command: CommandEnvelope) {
        commands.push(structuredClone(command));
        live.beforeCommand?.();
        if (terminals.has(command.receipt)) return { status: 'committed' };
        const graphBlock = (label: string) => {
          const start = command.update.indexOf('{', command.update.indexOf(label));
          let depth = 0, quoted = false, escaped = false;
          for (let i = start; i < command.update.length; i++) {
            const c = command.update[i];
            if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
            if (c === '"') quoted = true;
            else if (c === '{') depth++;
            else if (c === '}' && --depth === 0) return command.update.slice(start + 1, i);
          }
          throw new Error('unclosed credit command graph block');
        };
        const next = String(Number(live.sequence) + 1);
        const rdf = new Parser({ format: 'TriG' }).parse(`@prefix rv: <${RV}> .\n` + graphBlock('INSERT').replaceAll('?next', next));
        const prop = (subject: string, predicate: string) => rdf.find(quad => quad.subject.value === subject && quad.predicate.value === RV + predicate)?.object.value;
        const success = prop(command.receipt, 'outcome') === RV + 'Succeeded';
        const expected = prop(command.receipt, 'expectedHead') ?? null;
        if (success && ((live.headAvailable ? live.head : null) !== expected || live.nativeRetired || live.nativeProtected || live.nativeErased || !live.mapping)) return { status: 'committed' };
        const properties = { outcome: 'outcome', reason: 'reason', digest: 'requestDigest', admissionId: 'admissionId', authorityEpoch: 'authorityEpoch',
          scope: 'admittedScope', epoch: 'dataEpoch', sequence: 'sequence', component: 'component', revision: 'revision', expected: 'expectedHead', currentHead: 'currentHead' };
        const terminal = Object.fromEntries(Object.entries(properties).flatMap(([field, predicate]) => {
          const value = prop(command.receipt, predicate); return value === undefined ? [] : [[field, value]];
        }));
        if (!success) { delete terminal.component; delete terminal.revision; }
        terminals.set(command.receipt, terminal);
        live.sequence = next;
        if (success) {
          const head = terminal.revision!, manifest = prop(head, 'manifest')!;
          const operation = prop(head, 'operation'), receiptOperation = prop(command.receipt, 'operation');
          const modelGeneration = prop(head, 'modelGeneration');
          expect(operation).toMatch(/^https:\/\/rezics.com\/id\/[0-9a-f-]{36}$/);
          expect(receiptOperation).toBe(operation);
          expect(modelGeneration).toBe(generation());
          const snapshot = checkedRetainedCreditAssociationState(await readComponent(deps.environment, manifest, state.credit, RETAINED_CREDIT_ASSOCIATIONS_PROFILE));
          sealed.set(head, { state: snapshot, manifest, predecessor: expected, admission: terminal.admissionId!, sequence: next,
            operation, receiptOperation, modelGeneration });
          live.head = head; live.headAvailable = true;
        }
        if (live.lostReply) { live.lostReply = false; throw new Error('committed credit reply lost'); }
        return { status: 'committed' };
      } },
      objectDirectory: directory,
      lineage: { dataEpoch: 'credit-epoch', routingEpoch: 'routing-1' },
    } as unknown as WorkActivationEnvironment,
    async canReadWork(reader, work) {
      expect(reader).toEqual(readerPrincipal);
      expect(work).toBe(id(1));
      live.readCalls++;
      const allowed = live.readable;
      live.afterRead?.();
      return allowed;
    },
    owners: {
      async activation() {
        return live.activation
          ? {
              profile: RETAINED_CREDIT_ASSOCIATIONS,
              generation: generation(),
              revision: live.activationRevision,
              receipt: receipt(70),
              coverageRevision: id(71),
              coverageReceipt: receipt(71),
              complete: live.activationComplete as true,
            }
          : null;
      },
      async mapping(input) {
        live.mappingCalls++;
        const mapping = mappings.get(input.mapping.revision);
        const result =
          live.mapping && mapping
            ? {
                mapping: structuredClone(mapping),
                generation: generation(),
                receipt: receipt(72),
                validationToken: hash('mapping'),
              }
            : null;
        live.afterMapping?.();
        return result;
      },
      async coverage() {
        return live.withheld
          ? { state: 'withheld' }
          : live.coverage
            ? {
                state: 'covered',
                generation: generation(),
                revision: id(73),
                receipt: receipt(73),
                adoption: id(74),
                complete: true,
                statements: [{ statement: id(75), revision: id(76), decisionRevision: id(77) }],
              }
            : null;
      },
      async attribution(input) {
        live.sourceCalls++;
        const source =
          live.sourceState.get(
            'support' in input.support.basis ? input.support.basis.support : '',
          ) ?? 'current';
        const result: RetainedCreditSourceValidation = {
          basis: structuredClone(input.support.basis),
          state: source,
          receipt: receipt(60),
          validationToken: hash(source),
          fields: {
            creditedName: { lexical: 'Credited alias', language: 'ja' },
            provider,
            namespace,
            key: value.sourceKey,
            alias: 'Alias',
            eid: '0042',
            note: 'line one\nline two',
          },
          evidence: [id(90)],
        };
        live.afterSource?.();
        return result;
      },
    },
  };
  store();
  const open = () => openRetainedCreditAssociationRead(deps, readerPrincipal);
  const read = async (head?: string) =>
    readRetainedCreditAssociationView(deps, {
      basis: await open(),
      work: value.work,
      credit: value.credit,
      ...(head ? { associationHead: head } : {}),
    });
  const addAttribution = () => {
    state.participations[1]!.creditedName = { lexical: 'Credited alias', language: 'ja' };
    state.participations[1]!.sourceIdentity = {
      provider,
      namespace,
      key: value.sourceKey,
      alias: 'Alias',
      eid: '0042',
      note: 'line one\nline two',
    };
    state.participations[1]!.attributionSupports = [60, 61].map((n) => ({
      basis: { kind: 'source-credit', support: id(n) },
      fields: [...attributedFields],
      evidence: [id(90)],
    }));
    store();
  };
  const defineMapping = (mapping = state.mapping) => {
    const definition = { component: 'definition', kind: 'relation', lifecycle: 'active', successor: null,
      workSubjectRole: 'work', association: { kind: 'credit', workRole: 'work', subjectRoles: [role] },
      retainedCredit: { origin: mapping.originProfile, storedRole: mapping.originRole, subjectRole: role,
        ...(mapping.externalNamespace ? { externalNamespace: mapping.externalNamespace } : {}) },
      roles: [{ key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: role, minParticipants: 1, maxParticipants: 1, ordered: !agent }] };
    definitions.set(mapping.revision, { definition: mapping.definition,
      manifest: `urn:rezics:sha256:${prepareComponent(directory, mapping.definition, definition, PROFILES.definitionV2)}` });
    mappings.set(mapping.revision, structuredClone(mapping));
  };
  const enableBinding = () => {
    live.writing = true; live.headAvailable = false; sealed.clear();
    state.mapping.definition = id(30); state.mapping.externalNamespace = null;
    defineMapping();
    const input = (expectedAssociationHead: string | null = null): RetainedCreditBindingInput => ({
      credit: state.credit, creditRevision: state.creditRevision, work: state.work, workRevision: state.workRevision,
      retainedProfile: state.retainedProfile, role: state.role, origin: structuredClone(state.origin), mapping: structuredClone(state.mapping),
      subject: { participant: structuredClone(state.participations[1]!.participant),
        ...(agent ? {} : { position: value.nativeOrdinal }), attributionSupports: [] }, expectedAssociationHead,
    });
    const writeDeps: RetainedCreditBindingDependencies = { ...deps, canReadReference: async () => live.readable };
    const publication = Object.assign(async (credit: string, commandReceipt: string) => {
      expect(credit).toBe(value.credit); expect(commandReceipt).toMatch(/^urn:rezics:receipt:/);
    }, { guard: '{ FILTER(true) }', complete: async () => {} }) as RelationPublication;
    const admission = async (command: RetainedCreditBindingInput, n = 200): Promise<SemanticAdmission> => ({
      id: uuid(n), action: 'relation.change', scope: `work:edit:${value.work}`,
      requestDigest: (await prepareRetainedCreditBinding(deps.environment, command)).digest,
      authorityEpoch: '7', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const bind = async (command = input(), n = 200) => bindRetainedCreditAssociation(writeDeps, {
      principal: readerPrincipal, actingSubject: value.actingSubject, admission: await admission(command, n), input: command, beforeCommit: publication,
    });
    return { input, deps: writeDeps, publication, admission, bind };
  };
  return {
    state,
    value,
    live,
    deps,
    store,
    open,
    read,
    addAttribution,
    mappings,
    sealed,
    commands,
    terminals,
    defineMapping,
    enableBinding,
    clean: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Exact owner-produced native prestate plus the guarded model/mapping basis.
 * The Java regression executes the captured writer, not a hand-written update. */
async function retainedBindingNativeSeed(f: ReturnType<typeof fixture>) {
  const native = (await readCreditOwnerWitness(f.deps.environment, f.value.credit))!;
  const original = native.receipt;
  const triples = authorCreditTriples(native.value, original.dataEpoch, original.sequence);
  const generation = `urn:rezics:model-generation:${f.live.generation}`;
  const modelReceipt = `urn:rezics:receipt:${hash(`${generation}\0model-generation`)}`;
  return `@prefix rv: <${RV}> .
    @prefix schema: <https://schema.org/> .
    GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:dataEpoch ${lit(f.live.epoch)} ;
      rv:routingEpoch ${lit(f.live.routing)} ; rv:sequence ${f.live.sequence} . }
    GRAPH ${iri(GRAPHS.current)} { ${triples.current}
      ${iri(native.value.work)} a <https://schema.org/CreativeWork> ; rv:head ${iri(native.value.expectedHead)} .
      ${native.value.agent ? `${iri(native.value.agent)} a rv:Agent .` : ''}
      ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(generation)} .
      ${iri(f.state.mapping.definition)} rv:definitionHead ${iri(f.state.mapping.revision)} . }
    GRAPH ${iri(GRAPHS.revisions)} { ${triples.revision}
      ${iri(native.value.expectedHead)} a rv:RevisionAnchor ; rv:component ${iri(native.value.work)} .
      ${iri(f.state.mapping.revision)} rv:lifecycle rv:Active .
      ${iri(generation)} a rv:ModelGeneration, rv:RevisionAnchor ; rv:component ${iri(MODEL_COMPONENT)} ;
        rv:entailmentProfile rv:NoEntailment ; rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
        rv:modelRevision ${iri(PROFILES.generation)} ; rv:shapeRevision ${iri(PROFILES.generation)} ;
        rv:operation ${iri(id(70))} ; rv:dataEpoch ${lit(f.live.epoch)} ; rv:sequence 50 . }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(modelReceipt)} a rv:OperationReceipt ; rv:operation ${iri(id(70))} ;
      rv:outcome rv:Succeeded ; rv:dataEpoch ${lit(f.live.epoch)} ; rv:sequence 50 . }
    ${authorCreditEnvelope(native.value, original.sourceIntent, { id: original.admissionId,
      authorityEpoch: original.authorityEpoch, scope: original.scope, requestDigest: original.requestDigest },
    original.dataEpoch, original.sequence, true)}`;
}

for (const agent of [true, false]) for (const role of ['artist', 'performer'] as const)
  test(`retained bootstrap emits the exact native-runtime envelope for ${agent ? 'Agent' : 'external'} ${role}`, async () => {
    const captures = JSON.parse(readFileSync(new URL(
      '../../../infra/jena/command-module/src/test/resources/credit-retained-binding-commands.json', import.meta.url), 'utf8')) as {
      envelopes: { agent: boolean; role: string; seed: string; operation: string; profile: string;
        command: CommandEnvelope; originalReceipt: string;
        successor: { operation: string; command: CommandEnvelope } }[];
    };
    const captured = captures.envelopes.find(item => item.agent === agent && item.role === role)!;
    const f = fixture(agent, role);
    try {
      const w = f.enableBinding();
      delete f.deps.owners.activation;
      f.live.activation = false; f.live.coverage = false;
      const selection: RetainedCreditBindingRequest = { retained: {
        profile: agent ? 'native-agent-credit-v1' : 'work-author-credit-v1', credit: f.value.credit,
        origin: { kind: 'stored-credit', revision: f.value.revision } },
        mappingRevision: f.state.mapping.revision, attributionSupports: [], expectedAssociationHead: null };
      const loaded = await loadRetainedCreditBinding(w.deps, principal, selection);
      expect(await retainedBindingNativeSeed(f)).toBe(captured.seed);
      const native = (await readCreditOwnerWitness(f.deps.environment, f.value.credit))!;
      expect(creditProfile(native.value)).toBe(captured.profile);
      const created = await bindRetainedCreditAssociation(w.deps, { principal,
        actingSubject: f.value.actingSubject, input: loaded.input, admission: await w.admission(loaded.input) });
      expect(f.commands).toHaveLength(1);
      const command = f.commands[0]!;
      // Only the command's new operation is random. Everything else must be the
      // exact envelope that the production Java runtime executes in its test.
      expect({ ...command, update: command.update.replaceAll(created.operation, captured.operation) }).toEqual(captured.command);
      expect(command.validations).toHaveLength(2);
      expect(command.validations!.map(value => value.focus)).toEqual([[f.value.credit], [f.value.revision]]);
      for (const validation of command.validations!) {
        expect(validation.profile).toBe(captured.profile);
        expect(validation.sha256).toBe(profileRegistry[captured.profile as keyof typeof profileRegistry].sha256);
        if (agent) expect(validation.binding).toBeUndefined();
        else {
          expect(validation.binding).toMatchObject({ receipt: native.receipt.receipt,
            'work-head': native.value.expectedHead, epoch: native.receipt.authorityEpoch,
            intent: native.receipt.sourceIntent, scope: native.receipt.scope });
          expect(validation.binding!.receipt).not.toBe(created.compatibilityReceipt);
        }
      }
      expect(native.receipt.receipt).toBe(captured.originalReceipt);
      const nextInput = w.input(created.associationHead);
      const successor = await bindRetainedCreditAssociation(w.deps, { principal,
        actingSubject: f.value.actingSubject, input: nextInput, admission: await w.admission(nextInput, 201) });
      expect(successor.participations).toEqual(created.participations);
      expect(f.commands).toHaveLength(2);
      const nextCommand = f.commands[1]!;
      expect({ ...nextCommand, update: nextCommand.update.replaceAll(successor.operation, captured.successor.operation) })
        .toEqual(captured.successor.command);
    } finally { f.clean(); }
  });

test('retained binding refuses an unavailable installed native profile before sending product data', async () => {
  const f = fixture(false, 'performer');
  try {
    const w = f.enableBinding();
    const health = await f.deps.environment.fuseki.commandHealth();
    f.deps.environment.fuseki.commandHealth = async () => ({ ...health, profiles: {} });
    await expect(w.bind()).rejects.toThrow('Fuseki profile work-author-credit-v2 differs from reviewed artifact');
    expect(f.commands).toHaveLength(0);
    expect(f.sealed.size).toBe(0);
  } finally { f.clean(); }
});

for (const agent of [true, false]) test(`closed retained selection derives the actual ${agent ? 'Agent' : 'external'} first binding without adoption`, async () => {
  const f = fixture(agent);
  try {
    const w = f.enableBinding();
    f.live.activation = false; f.live.coverage = false;
    // Neither first binding nor an exact internal identity read can depend on
    // a public activation whose Statements need the not-yet-created head.
    delete f.deps.owners.activation;
    const selection: RetainedCreditBindingRequest = { retained: {
      profile: agent ? 'native-agent-credit-v1' : 'work-author-credit-v1', credit: f.value.credit,
      origin: { kind: 'stored-credit', revision: f.value.revision } },
      mappingRevision: f.state.mapping.revision, attributionSupports: [], expectedAssociationHead: null };
    const loaded = await loadRetainedCreditBinding(w.deps, principal, selection);
    expect(loaded.input).toEqual(w.input());
    expect(loaded.originalReceipt).toBe(workEditReceiptIri(uuid(5)));
    expect(loaded.workHead).toBe(f.value.expectedHead);
    expect('activation' in loaded.basis).toBe(false);
    const created = await bindRetainedCreditAssociation(w.deps, { principal,
      actingSubject: f.value.actingSubject, input: loaded.input, admission: await w.admission(loaded.input) });
    expect(created.occurrence).toBe(f.value.credit);
    expect(f.sealed.size).toBe(1);
    const identity = await resolveRetainedCreditAssociationIdentity(w.deps, {
      basis: await openRetainedCreditIdentityRead(w.deps, principal),
      credit: created.occurrence, associationHead: created.associationHead });
    expect(identity.receipt).toBe(created.compatibilityReceipt);
    await expect(f.open()).rejects.toThrow('activation owner unavailable');
    expect(f.commands[0]!.update).not.toContain('rv:GlobalAdoption');
  } finally { f.clean(); }
});

test('unadopted identity reads retain live Account callbacks, expiry and source/model fences', async () => {
  const account = await accountReader();
  const f = fixture(true, 'artist', 'vndb', 'staff', account.reader);
  try {
    delete f.deps.owners.activation;
    const basis = await openRetainedCreditIdentityRead(f.deps, account.reader);
    expect(basis.principal.currentAssertion).toBe(account.reader.currentAssertion);
    expect('activation' in basis).toBe(false);
    await fenceRetainedCreditIdentityRead(f.deps, basis);
    f.live.sequence = '101';
    await expect(fenceRetainedCreditIdentityRead(f.deps, basis)).rejects.toBeInstanceOf(RetainedCreditReadMoved);
    f.live.sequence = basis.sourcePosition.sequence;
    f.live.generation = 'c'.repeat(64);
    await expect(fenceRetainedCreditIdentityRead(f.deps, basis)).rejects.toBeInstanceOf(RetainedCreditReadMoved);
    f.live.generation = 'b'.repeat(64);
    account.state.active = false;
    await expect(fenceRetainedCreditIdentityRead(f.deps, basis)).rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(openRetainedCreditIdentityRead(f.deps, account.reader)).rejects.toBeInstanceOf(AccountAssertionDenied);
  } finally { f.clean(); await account.close(); }
});

test('first binding without publication still refuses denied references, stale origin revisions and generation changes', async () => {
  const f = fixture();
  try {
    const w = f.enableBinding(); delete f.deps.owners.activation;
    const input = w.input(), admission = await w.admission(input);
    f.live.readable = false;
    await expect(bindRetainedCreditAssociation(w.deps, { principal, actingSubject: f.value.actingSubject,
      input, admission })).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
    f.live.readable = true;
    await expect(loadRetainedCreditBinding(w.deps, principal, { retained: {
      profile: 'native-agent-credit-v1', credit: input.credit, origin: { kind: 'stored-credit', revision: id(999) } },
      mappingRevision: input.mapping.revision, attributionSupports: [], expectedAssociationHead: null }))
      .rejects.toThrow('exact stored credit origin unavailable');
    await expect(bindRetainedCreditAssociation(w.deps, { principal, actingSubject: f.value.actingSubject,
      input, admission: { ...admission, scope: `work:edit:${id(999)}` } })).rejects.toThrow('scope differs');
    let changed = false;
    f.live.afterRead = () => { if (!changed) { changed = true; f.live.generation = 'c'.repeat(64); } };
    await expect(bindRetainedCreditAssociation(w.deps, { principal, actingSubject: f.value.actingSubject,
      input, admission })).rejects.toBeInstanceOf(RetainedCreditReadMoved);
    expect(f.commands).toHaveLength(0); expect(f.sealed.size).toBe(0);
  } finally { f.clean(); }
});

test('optional real publication prepares and completes an actual seal, abandons only a sealed stale refusal', async () => {
  const f = fixture();
  try {
    const w = f.enableBinding(); let prepared = 0, completed = 0, abandoned = 0;
    const publication: RelationPublication = Object.assign(async () => { prepared++; }, {
      guard: `{ GRAPH <urn:rezics:graph:current> { <${id(80)}> <${RV}publicationHead> <${id(81)}> } }`,
      complete: async (credit: string, commandReceipt: string) => {
        expect(credit).toBe(f.value.credit); expect(f.terminals.has(commandReceipt)).toBe(true);
        expect(f.sealed.size).toBe(1); completed++;
      }, abandon: async (commandReceipt: string) => {
        expect(f.terminals.get(commandReceipt)?.outcome).toBe(RV + 'Cancelled'); abandoned++;
      },
    });
    const input = w.input();
    const intent = { principal, actingSubject: f.value.actingSubject, input, admission: await w.admission(input), beforeCommit: publication };
    const created = await bindRetainedCreditAssociation(w.deps, intent);
    expect(f.commands[0]!.update).toContain(publication.guard!);
    const replay = await bindRetainedCreditAssociation(w.deps, intent);
    expect(replay.associationHead).toBe(created.associationHead);
    expect([prepared, completed, abandoned]).toEqual([1, 2, 0]);
    await expect(bindRetainedCreditAssociation(w.deps, { ...intent, admission: await w.admission(input, 201) }))
      .rejects.toBeInstanceOf(StaleSemanticHead);
    expect([prepared, completed, abandoned]).toEqual([1, 2, 1]);
    expect(f.sealed.size).toBe(1);
  } finally { f.clean(); }
});

test('a source-derived stored credit keeps its public stored tuple and requires its internally resolved Source receipt', async () => {
  const f = fixture(false);
  try {
    const w = f.enableBinding(); f.live.native = false; f.live.sourceIntent = id(60);
    delete f.deps.owners.activation;
    const request: RetainedCreditBindingRequest = { retained: { profile: 'work-author-credit-v1', credit: f.value.credit,
      origin: { kind: 'stored-credit', revision: f.value.revision } }, mappingRevision: f.state.mapping.revision,
      attributionSupports: [], expectedAssociationHead: null };
    await expect(loadRetainedCreditBinding(w.deps, principal, request)).rejects.toMatchObject({
      code: 'retained_credit_origin_unavailable', owner: 'source-credit', reference: id(60) });
    let withdrawn = false, wrongReceipt = false;
    f.deps.owners.origin = async ({ view, nativeCredit, basis }) => {
      expect(nativeCredit?.receipt.sourceIntent).toBe(id(60));
      expect(nativeCredit?.receipt.credit).toBe(f.value.credit);
      expect('activation' in basis).toBe(false);
      return { ...view, receipt: wrongReceipt ? receipt(60) : workEditReceiptIri(uuid(5)),
        validation: [{ basis: { kind: 'source-credit', support: id(60) }, state: withdrawn ? 'withdrawn' : 'current',
          receipt: receipt(60), validationToken: hash(String(withdrawn)), fields: {}, evidence: [] }] };
    };
    w.deps.originGuard = async ({ state, basis }) => {
      expect(state.origin).toEqual(request.retained.origin); expect('activation' in basis).toBe(false);
      return `GRAPH <urn:rezics:graph:current> { <${id(60)}> <${RV}supportHead> <${id(61)}> }`;
    };
    wrongReceipt = true;
    await expect(loadRetainedCreditBinding(w.deps, principal, request)).rejects.toThrow('source binding differs');
    wrongReceipt = false;
    const loaded = await loadRetainedCreditBinding(w.deps, principal, request);
    const created = await bindRetainedCreditAssociation(w.deps, { principal, actingSubject: f.value.actingSubject,
      input: loaded.input, admission: await w.admission(loaded.input) });
    expect(f.sealed.get(created.associationHead)?.state.origin).toEqual(request.retained.origin);
    expect(f.commands[0]!.update).toContain(`<${id(60)}> <${RV}supportHead> <${id(61)}>`);
    withdrawn = true;
    await expect(w.bind({ ...loaded.input, expectedAssociationHead: created.associationHead }, 201)).rejects.toThrow('withdrawn');
    expect(f.sealed.size).toBe(1);
  } finally { f.clean(); }
});

for (const kind of ['source-binding', 'selected-publication'] as const)
  test(`closed ${kind} preparation derives the exact Source-owned original and reports its missing owner`, async () => {
    const f = fixture(false);
    try {
      const w = f.enableBinding();
      f.state.retainedProfile = 'source-reported-credit-v1'; f.state.mapping.originProfile = f.state.retainedProfile;
      f.defineMapping();
      const retained: RetainedCreditSelection = { profile: 'source-reported-credit-v1', credit: f.value.credit,
        origin: kind === 'source-binding' ? { kind, binding: id(60), proposal: id(61), conversion: id(62),
          record: id(63), observation: id(64), sourceOccurrence: `urn:rezics:source-occurrence:${'a'.repeat(64)}`, sourceOrdinal: 2 }
          : { kind, decision: f.value.credit, source: id(61), record: id(63), observation: id(64) } };
      const request: RetainedCreditBindingRequest = { retained, mappingRevision: f.state.mapping.revision,
        attributionSupports: [], expectedAssociationHead: null };
      const deps: RetainedCreditOriginDependencies = w.deps;
      await expect(loadRetainedCreditBinding(deps, principal, request)).rejects.toMatchObject({
        code: 'retained_credit_origin_unavailable', owner: kind });
      deps.originLoaders = { [kind === 'source-binding' ? 'sourceBinding' : 'selectedPublication']: async (selected: {
        retained: RetainedCreditSelection; attributionSupports: RetainedCreditBindingRequest['attributionSupports'] }) => {
        expect(selected.retained).toEqual(retained);
        return { retained, work: f.value.work, workRevision: f.value.expectedHead, workHead: f.value.expectedHead,
          creditRevision: f.value.revision, role: 'artist', receipt: receipt(60),
          subject: { participant: f.state.participations[1]!.participant, position: f.value.nativeOrdinal,
            attributionSupports: selected.attributionSupports } };
      } };
      deps.owners.origin = async ({ view }) => ({ ...view, receipt: receipt(60), validation: [{
        basis: kind === 'source-binding' ? { kind, binding: id(60) } : { kind, decision: f.value.credit },
        state: 'current', receipt: receipt(60), validationToken: hash(kind), fields: {}, evidence: [] }] });
      deps.originGuard = async () => `{ GRAPH <urn:rezics:graph:current> { <${id(60)}> <${RV}supportHead> <${id(61)}> } }`;
      const loaded = await loadRetainedCreditBinding(deps, principal, request);
      expect(loaded.input.work).toBe(f.value.work);
      expect(loaded.input.origin).toEqual(retained.origin);
      const created = await bindRetainedCreditAssociation(deps, { principal, actingSubject: f.value.actingSubject,
        input: loaded.input, admission: await w.admission(loaded.input) });
      expect(created.occurrence).toBe(retained.credit);
      expect(f.sealed.get(created.associationHead)?.state.origin).toEqual(retained.origin);
      expect(f.sealed.size).toBe(1);
    } finally { f.clean(); }
  });

for (const agent of [true, false]) test(`retained binding seals the actual ${agent ? 'Agent' : 'qualified external'} credit without another occurrence`, async () => {
  const f = fixture(agent);
  try {
    const w = f.enableBinding(), created = await w.bind();
    expect(created.occurrence).toBe(f.value.credit);
    expect(created.compatibilityReceipt).toBe(familyReceiptIri(uuid(200), RETAINED_CREDIT_ASSOCIATIONS));
    expect(created.associationHead).not.toBe(f.value.credit);
    expect(created.operation).toMatch(/^https:\/\/rezics.com\/id\/[0-9a-f-]{36}$/);
    expect([created.associationHead, created.occurrence, id(200)]).not.toContain(created.operation);
    expect(created.modelGeneration).toBe(`urn:rezics:model-generation:${f.live.generation}`);
    expect(created.participations).toHaveLength(2);
    const view = await f.read();
    expect(view?.state.creditRevision).toBe(f.value.revision);
    expect(view?.state.workRevision).toBe(f.value.expectedHead);
    expect(view?.state.participations).toEqual(created.participations);
    expect(view?.operation).toBe(created.operation);
    expect(view?.modelGeneration).toBe(created.modelGeneration);
    const identity = await resolveRetainedCreditAssociationIdentity(f.deps, {
      basis: await f.open(), credit: f.value.credit, associationHead: created.associationHead,
    });
    expect(identity.occurrence).toBe(f.value.credit);
    expect(identity.receipt).toBe(created.compatibilityReceipt);
    expect(identity.manifest).toBe(created.manifest);
    expect(identity.operation).toBe(created.operation);
    expect(identity.modelGeneration).toBe(created.modelGeneration);
    const command = f.commands[0]!;
    expect(command.update).toContain(`rv:creditRevision <${f.value.revision}>`);
    expect(command.update).toContain(`rv:head <${f.value.expectedHead}>`);
    expect(command.update).toContain('rv:protectionHead');
    expect(command.update).toContain('rv:ErasedRevision');
    expect(command.update).not.toContain('a rv:RelationOccurrence');
    expect(command.update).not.toContain('a rv:NativeAgentCredit');
    expect(command.update).not.toContain('a rv:AuthorCredit');
  } finally { f.clean(); }
});

test('concurrent retained binding and lost response reconcile one receipt, view and allocation set', async () => {
  const f = fixture();
  try {
    const w = f.enableBinding(); f.live.lostReply = true;
    const results = await Promise.all([w.bind(), w.bind()]);
    expect(results[0]!.associationHead).toBe(results[1]!.associationHead);
    expect(results[0]!.compatibilityReceipt).toBe(results[1]!.compatibilityReceipt);
    expect(results[0]!.operation).toBe(results[1]!.operation);
    expect(results[0]!.modelGeneration).toBe(results[1]!.modelGeneration);
    expect(results[0]!.participations).toEqual(results[1]!.participations);
    expect(f.sealed.size).toBe(1);
    expect(f.terminals.size).toBe(1);
    expect(new Set(results.flatMap(value => value.participations.map(part => part.id))).size).toBe(2);
    const replay = await w.bind();
    expect(replay.replayed).toBe(true);
    expect(replay.participations).toEqual(results[0]!.participations);
    expect(replay.operation).toBe(results[0]!.operation);
    expect(replay.modelGeneration).toBe(results[0]!.modelGeneration);
    expect(f.sealed.size).toBe(1);
  } finally { f.clean(); }
});

test('replay returns the actual sealed operation and generation after the active model advances', async () => {
  const f = fixture();
  try {
    const w = f.enableBinding(), first = await w.bind();
    const history = canonicalCreditValue(f.sealed.get(first.associationHead));
    f.live.generation = 'c'.repeat(64);
    const replay = await w.bind();
    expect(replay.replayed).toBe(true);
    expect(replay.operation).toBe(first.operation);
    expect(replay.modelGeneration).toBe(first.modelGeneration);
    expect(replay.modelGeneration).not.toBe(`urn:rezics:model-generation:${f.live.generation}`);
    const seal = await readSealedRetainedCreditAssociation(f.deps.environment, f.value.credit, first.associationHead);
    expect(seal.operation).toBe(first.operation);
    expect(seal.modelGeneration).toBe(first.modelGeneration);
    const view = await f.read();
    expect(view?.operation).toBe(first.operation);
    expect(view?.modelGeneration).toBe(first.modelGeneration);
    expect(view?.position.generation.generation).toBe(`urn:rezics:model-generation:${f.live.generation}`);
    expect(f.commands).toHaveLength(1);
    expect(canonicalCreditValue(f.sealed.get(first.associationHead))).toBe(history);
  } finally { f.clean(); }
});

for (const failure of ['operation', 'receiptOperation', 'modelGeneration', 'different-operation', 'revision-as-operation', 'admission-as-operation'] as const)
  test(`historical compatibility metadata ${failure} remains unavailable without replay repair`, async () => {
    const f = fixture();
    try {
      const w = f.enableBinding(), created = await w.bind();
      const stored = f.sealed.get(created.associationHead)!;
      if (failure === 'different-operation') stored.receiptOperation = id(901);
      else if (failure === 'revision-as-operation') stored.operation = stored.receiptOperation = created.associationHead;
      else if (failure === 'admission-as-operation') stored.operation = stored.receiptOperation = id(200);
      else delete stored[failure];
      const history = canonicalCreditValue(stored);
      await expect(readSealedRetainedCreditAssociation(f.deps.environment, f.value.credit, created.associationHead))
        .rejects.toThrow('compatibility command metadata unavailable');
      await expect(resolveRetainedCreditAssociationIdentity(f.deps, { basis: await f.open(),
        credit: f.value.credit, associationHead: created.associationHead }))
        .rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
      await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
      await expect(w.bind()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
      expect(f.commands).toHaveLength(1);
      expect(f.sealed.size).toBe(1);
      expect(canonicalCreditValue(f.sealed.get(created.associationHead))).toBe(history);
    } finally { f.clean(); }
  });

test('a retained head race cannot abandon publication sealed by the same admission', async () => {
  const f = fixture();
  try {
    const w = f.enableBinding(); let abandoned = 0, held = true;
    w.publication.abandon = async () => { abandoned++; };
    const query = f.deps.environment.fuseki.query.bind(f.deps.environment.fuseki);
    f.deps.environment.fuseki.query = async (sparql) => {
      // Finish the same admission after the outer request has checked authority
      // and before it observes the expected head. Its stale-head rejection must
      // reconcile the winner's actual receipt without undoing publication.
      if (held && sparql.includes('SELECT ?associationHead')) {
        held = false;
        await w.bind();
      }
      return query(sparql);
    };
    const replay = await w.bind();
    expect(replay.replayed).toBe(true);
    expect(abandoned).toBe(0);
    expect(f.sealed.size).toBe(1);
    expect(f.terminals.size).toBe(1);
  } finally { f.clean(); }
});

test('an Account-issued live principal can bind and cannot replay after revocation', async () => {
  const account = await accountReader();
  const f = fixture(true, 'artist', 'vndb', 'staff', account.reader);
  try {
    const w = f.enableBinding();
    const first = await w.bind();
    expect(first.occurrence).toBe(f.value.credit);
    const calls = account.state.calls;
    account.state.active = false;
    await expect(w.bind()).rejects.toThrow();
    expect(account.state.calls).toBeGreaterThan(calls);
    expect(f.sealed.size).toBe(1);
    expect(f.terminals.size).toBe(1);
  } finally { f.clean(); await account.close(); }
});

test('a new exact mapping preserves participation IDs, original identity and immutable prior history', async () => {
  const f = fixture();
  try {
    const w = f.enableBinding(), first = await w.bind();
    const prior = canonicalCreditValue(f.sealed.get(first.associationHead));
    const command = w.input(first.associationHead);
    command.mapping = { ...command.mapping, definition: id(34), revision: id(33),
      workRole: `${id(34)}/role/work`, subjectRole: `${id(34)}/role/artist` };
    f.defineMapping(command.mapping);
    const second = await w.bind(command, 201);
    expect(second.predecessor).toBe(first.associationHead);
    expect(second.associationHead).not.toBe(first.associationHead);
    expect(second.operation).not.toBe(first.operation);
    expect(second.participations.map(part => part.id)).toEqual(first.participations.map(part => part.id));
    expect(canonicalCreditValue(f.sealed.get(first.associationHead))).toBe(prior);
    const old = await resolveRetainedCreditAssociationIdentity(f.deps, { basis: await f.open(),
      credit: f.value.credit, associationHead: first.associationHead });
    expect(old.state.mapping.revision).toBe(id(32));
    expect(old.currentAssociationHead).toBe(second.associationHead);
    expect(old.operation).toBe(first.operation);
    expect(old.modelGeneration).toBe(first.modelGeneration);
    expect((await f.read())?.state.mapping.revision).toBe(id(33));
    expect((await w.bind(command, 201)).associationHead).toBe(second.associationHead);
  } finally { f.clean(); }
});

test('stale first binding and changed expected head refuse without duplicate views', async () => {
  const f = fixture();
  try {
    const w = f.enableBinding(), first = await w.bind();
    await expect(w.bind(w.input(), 202)).rejects.toBeInstanceOf(StaleSemanticHead);
    expect(f.sealed.size).toBe(1);
    expect(f.live.head).toBe(first.associationHead);
    expect(f.terminals.get(familyReceiptIri(uuid(202), RETAINED_CREDIT_ASSOCIATIONS))?.outcome).toBe(RV + 'Cancelled');
  } finally { f.clean(); }
});

for (const unavailable of ['nativeRetired', 'nativeProtected', 'nativeErased'] as const)
  test(`retained binding refuses ${unavailable} original identity before sealing`, async () => {
    const f = fixture();
    try {
      const w = f.enableBinding(); f.live[unavailable] = true;
      await expect(w.bind()).rejects.toThrow();
      expect(f.commands).toHaveLength(0); expect(f.sealed.size).toBe(0);
    } finally { f.clean(); }
  });

test('retained binding distinguishes a missing stored Source owner from a changed exact participant', async () => {
  const f = fixture(false);
  try {
    const w = f.enableBinding(); f.live.native = false; f.live.sourceIntent = id(60);
    await expect(w.bind()).rejects.toBeInstanceOf(RetainedCreditOriginUnavailable);
    expect(f.sealed.size).toBe(0);
    f.live.native = true; f.live.sourceIntent = f.value.credit;
    const command = w.input();
    command.subject.participant = { kind: 'external', provider: 'bangumi', namespace: 'person', key: 'same-key' };
    await expect(w.bind(command)).rejects.toThrow('qualifications differ');
    expect(f.commands).toHaveLength(0);
  } finally { f.clean(); }
});

test('native manual citations keep their independent receipt and withdrawal without changing credit identity', async () => {
  const f = fixture();
  try {
    const w = f.enableBinding(); let withdrawn = false;
    const citation: RelationAttributionOwner = { verify: async ({ principal: reader, requests }) => {
      expect(reader.subject).toBe(principal.subject);
      return { guard: `GRAPH <urn:rezics:graph:current> { <${id(90)}> <${RV}citationHead> <${id(91)}> }`,
        proofs: requests.map(({ participation, support }) => ({ basis: support.basis,
          participant: participation.participant, state: withdrawn ? 'withdrawn' : 'current',
          receipt: receipt(90), revision: id(91), validationToken: hash(String(withdrawn)),
          fields: { creditedName: { lexical: 'Credited alias', language: 'ja' } }, evidence: [id(90)] })) };
    } };
    w.deps.attribution = citation;
    f.deps.owners.attribution = retainedCreditAttributionReader(f.deps.environment,
      creditAttributionOwner(f.deps.environment, citation), f.value.actingSubject);
    const command = w.input();
    command.subject.creditedName = { lexical: 'Credited alias', language: 'ja' };
    command.subject.attributionSupports = [{ basis: { kind: 'native-credit', credit: f.value.credit, revision: f.value.revision },
      fields: ['creditedName'], evidence: [id(90)] }];
    const created = await w.bind(command);
    const view = await f.read();
    expect(view?.sourceValidation[0]?.receipt).toBe(receipt(90));
    expect(view?.sourceValidation[0]?.receipt).not.toBe(workEditReceiptIri(uuid(5)));
    expect(view?.state.participations[1]?.attributionSupports[0]?.evidence).toEqual([id(90)]);
    expect(f.commands[0]?.update).toContain(`<${id(90)}> <${RV}citationHead> <${id(91)}>`);
    const history = canonicalCreditValue(f.sealed.get(created.associationHead));
    withdrawn = true;
    const current = await f.read();
    expect(current?.occurrence).toBe(f.value.credit);
    expect(current?.attribution[1]?.unsupportedFields).toEqual(['creditedName']);
    expect(current?.sourceValidation[0]?.state).toBe('withdrawn');
    await expect(w.bind({ ...command, expectedAssociationHead: created.associationHead }, 201)).rejects.toThrow('withdrawn');
    expect(canonicalCreditValue(f.sealed.get(created.associationHead))).toBe(history);
    expect(f.sealed.size).toBe(1);
  } finally { f.clean(); }
});

for (const role of NATIVE_CREDIT_ROLES)
  test(`retained ${role} reads preserve the original native credit and allocations`, async () => {
    const f = fixture(true, role);
    try {
      const view = await f.read();
      expect(view?.occurrence).toBe(f.value.credit);
      expect(view?.associationHead).toBe(id(100));
      expect(view?.state.role).toBe(role);
      expect(view?.state.participations).toEqual(f.state.participations);
      expect(view?.compatibilityReceipt).toBe(
        familyReceiptIri(uuid(100), RETAINED_CREDIT_ASSOCIATIONS),
      );
      expect(view?.headGuarantee).toBe('verified-before-commit');
    } finally {
      f.clean();
    }
  });

for (const [provider, namespace] of [
  ['vndb', 'staff'],
  ['bangumi', 'person'],
  ['musicbrainz', 'artist'],
]) {
  test(`retained external identity preserves ${provider}/${namespace} without an Agent`, async () => {
    const f = fixture(false, 'artist', provider, namespace);
    try {
      const view = await f.read();
      expect(view?.state.participations[1]?.participant).toEqual({
        kind: 'external',
        provider,
        namespace,
        key: 'same-key',
      });
      expect(view?.state.participations[1]?.position).toBe(2);
      expect(view?.sourceValidation).toEqual([]);
    } finally {
      f.clean();
    }
  });
}

test('exact old view reads retain their own mapping and allocations after a new binding', async () => {
  const f = fixture();
  try {
    const old = structuredClone(f.state);
    f.live.head = id(101);
    f.state.mapping.revision = id(33);
    f.state.mapping.definition = id(34);
    f.state.workParticipation = id(42);
    f.state.subjectParticipation = id(43);
    f.state.participations[0]!.id = id(42);
    f.state.participations[1]!.id = id(43);
    f.store(f.state, id(101), id(100));
    expect((await f.read(id(100)))?.state).toEqual(old);
    expect((await f.read())?.state.mapping.revision).toBe(id(33));
    expect((await f.read())?.predecessor).toBe(id(100));
  } finally {
    f.clean();
  }
});

test('repeated and concurrent reads reuse the sealed participation set without writes', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.read(), f.read(), f.read()]);
    expect(
      results.every((result) => canonicalCreditValue(result) === canonicalCreditValue(results[0])),
    ).toBe(true);
    expect(f.live.queries.every((query) => !/\b(INSERT|DELETE)\b/.test(query))).toBe(true);
    expect(f.sealed.size).toBe(1);
  } finally {
    f.clean();
  }
});

test('aliases, eid, multiline notes, exact language and independent source supports remain on the participation', async () => {
  const f = fixture(false);
  try {
    f.addAttribution();
    const view = await f.read();
    expect(view?.state.participations[1]).toEqual(f.state.participations[1]);
    expect(view?.state.participations[0]?.sourceIdentity).toBeUndefined();
    expect(view?.sourceValidation).toHaveLength(2);
    expect(view?.attribution[1]?.unsupportedFields).toEqual([]);
  } finally {
    f.clean();
  }
});

test('withdrawing one support preserves independent support and never removes the occurrence', async () => {
  const f = fixture(false);
  try {
    f.addAttribution();
    f.live.sourceState.set(id(60), 'withdrawn');
    const view = await f.read();
    expect(view?.occurrence).toBe(id(2));
    expect(view?.sourceValidation.map((item) => item.state)).toEqual(['withdrawn', 'current']);
    expect(view?.attribution[1]?.currentFields).toEqual([...attributedFields].sort());
    f.live.sourceState.set(id(61), 'withdrawn');
    const withdrawn = await f.read();
    expect(withdrawn?.state.participations).toEqual(view?.state.participations);
    expect(withdrawn?.attribution[1]?.currentFields).toEqual([]);
    expect(withdrawn?.attribution[1]?.unsupportedFields).toEqual([...attributedFields].sort());
  } finally {
    f.clean();
  }
});

for (const failure of ['activation', 'mapping', 'coverage', 'view', 'legacy'] as const)
  test(`missing ${failure} is unavailable, never a manufactured view`, async () => {
    const f = fixture();
    try {
      if (failure === 'view') f.live.headAvailable = false;
      else f.live[failure] = false;
      await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
    } finally {
      f.clean();
    }
  });
test('missing or incomplete activation cannot turn an empty candidate result into exact empty', async () => {
  const f = fixture();
  try {
    f.live.headAvailable = false;
    const basis = await f.open();
    f.live.activation = false;
    await expect(
      readRetainedCreditAssociationCandidates(f.deps, { basis, limit: 2 }),
    ).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
    f.live.activation = true;
    f.live.activationComplete = false;
    await expect(f.open()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
  } finally {
    f.clean();
  }
});
test('complete owner activation permits an exact empty retained candidate page', async () => {
  const f = fixture();
  try {
    f.live.headAvailable = false;
    expect(
      await readRetainedCreditAssociationCandidates(f.deps, { basis: await f.open(), limit: 2 }),
    ).toEqual({ items: [], more: false });
  } finally {
    f.clean();
  }
});
test('candidate pages use ordered original credit IDs and one lookahead without truncating ambiguity', async () => {
  const f = fixture();
  try {
    f.live.candidates = [2, 7, 8].map((n) => ({
      work: id(1),
      credit: id(n),
      associationHead: id(100 + n),
    }));
    const basis = await f.open();
    const page = await readRetainedCreditAssociationCandidates(f.deps, {
      basis,
      works: [id(1)],
      limit: 2,
    });
    expect(page.items.map((item) => item.credit)).toEqual([id(2), id(7)]);
    expect(page.more).toBe(true);
    expect(
      f.live.queries.some((query) =>
        query.includes('ORDER BY ?work ?credit ?associationHead LIMIT 3'),
      ),
    ).toBe(true);
    f.live.candidates = [
      f.live.candidates[0]!,
      { ...f.live.candidates[0]!, associationHead: id(900) },
    ];
    await expect(
      readRetainedCreditAssociationCandidates(f.deps, { basis, limit: 1 }),
    ).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
  } finally {
    f.clean();
  }
});

for (const failure of [
  'credit-as-receipt',
  'wrong-digest',
  'missing-receipt',
  'ambiguous-receipt',
  'missing-objects',
] as const) {
  test(`refuses ${failure} instead of returning a compatibility witness`, async () => {
    const f = fixture();
    try {
      if (failure === 'credit-as-receipt') f.live.receiptOverride = id(2);
      if (failure === 'wrong-digest') f.live.digestOverride = 'f'.repeat(64);
      if (failure === 'missing-receipt') f.live.viewsAvailable = false;
      if (failure === 'ambiguous-receipt') f.live.viewRows = 2;
      if (failure === 'missing-objects')
        f.live.manifestOverride = `urn:rezics:sha256:${'f'.repeat(64)}`;
      await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
    } finally {
      f.clean();
    }
  });
}
for (const failure of [
  'role',
  'participant',
  'position',
  'workRevision',
  'provider-collision',
] as const) {
  test(`a sealed view cannot rewrite the original ${failure}`, async () => {
    const f = fixture(false);
    try {
      if (failure === 'role') {
        f.state.role = 'director';
        f.state.mapping.originRole = 'director';
      }
      if (failure === 'participant')
        f.state.participations[1]!.participant = { kind: 'resource', ref: id(6) };
      if (failure === 'position') f.state.participations[1]!.position = 3;
      if (failure === 'workRevision') f.state.workRevision = id(900);
      if (failure === 'provider-collision')
        f.state.participations[1]!.participant = {
          kind: 'external',
          provider: 'bangumi',
          namespace: 'person',
          key: 'same-key',
        };
      f.store();
      await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
    } finally {
      f.clean();
    }
  });
}
for (const failure of ['nativeRetired', 'nativeProtected', 'nativeErased', 'held'] as const)
  test(`${failure} removes live credit witness eligibility`, async () => {
    const f = fixture();
    try {
      f.live[failure] = true;
      await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
    } finally {
      f.clean();
    }
  });
test('source, model and activation positions are fences, not successful empty reads', async () => {
  const f = fixture();
  try {
    const basis = await f.open();
    f.live.sequence = '101';
    await expect(fenceRetainedCreditAssociationRead(f.deps, basis)).rejects.toBeInstanceOf(
      RetainedCreditReadMoved,
    );
    f.live.sequence = '100';
    f.live.generation = 'c'.repeat(64);
    await expect(fenceRetainedCreditAssociationRead(f.deps, basis)).rejects.toBeInstanceOf(
      RetainedCreditReadMoved,
    );
    f.live.generation = 'b'.repeat(64);
    f.live.activationRevision = id(701);
    await expect(fenceRetainedCreditAssociationRead(f.deps, basis)).rejects.toBeInstanceOf(
      RetainedCreditReadMoved,
    );
  } finally {
    f.clean();
  }
});
test('support withdrawal during hydration restarts instead of sealing a mixed read', async () => {
  const f = fixture(false);
  try {
    f.addAttribution();
    f.live.afterSource = () => {
      f.live.sourceState.set(id(60), 'withdrawn');
    };
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadMoved);
  } finally {
    f.clean();
  }
});
test('mapping and head changes during hydration restart even without a graph counter change', async () => {
  const f = fixture();
  try {
    f.live.afterMapping = () => {
      f.live.head = id(101);
    };
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadMoved);
  } finally {
    f.clean();
  }
});
test('query disclosure and coverage withholding hide a witness without fabricating a view', async () => {
  const f = fixture();
  try {
    f.live.readable = false;
    expect(await f.read()).toBeNull();
    f.live.readable = true;
    f.live.withheld = true;
    expect(await f.read()).toBeNull();
    f.live.withheld = false;
    f.live.afterRead = () => {
      f.live.readable = false;
    };
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadMoved);
  } finally {
    f.clean();
  }
});
test('an unknown attribution is unavailable even if the stored field claims explicit null', async () => {
  const f = fixture(false);
  try {
    f.addAttribution();
    f.state.participations[1]!.sourceIdentity!.alias = null;
    f.store();
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
    f.state.participations[1]!.sourceIdentity!.alias = 'Alias';
    f.store();
    delete f.deps.owners.attribution;
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
  } finally {
    f.clean();
  }
});
test('native credit attribution resolves its own receipt and cannot infer a credited name', async () => {
  const f = fixture();
  try {
    f.state.participations[1]!.creditedName = {
      lexical: 'Name inferred from Agent',
      language: 'en',
    };
    f.state.participations[1]!.attributionSupports = [
      {
        basis: { kind: 'native-credit', credit: id(2), revision: id(5) },
        fields: ['creditedName'],
        evidence: [],
      },
    ];
    f.store();
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
  } finally {
    f.clean();
  }
});
test('ambiguous legacy Source origin requires its exact installed binding owner', async () => {
  const f = fixture(false);
  try {
    f.live.native = false;
    f.live.sourceIntent = id(60);
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
    f.state.origin = {
      kind: 'source-binding',
      binding: id(60),
      proposal: id(61),
      conversion: id(62),
      record: id(63),
      observation: id(64),
      sourceOccurrence: `urn:rezics:source-occurrence:${'a'.repeat(64)}`,
      sourceOrdinal: 0,
    };
    f.store();
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
  } finally {
    f.clean();
  }
});
test('view codec refuses unknown metadata, incomplete source identity and duplicate allocations', () => {
  const f = fixture(false);
  try {
    expect(() =>
      checkedRetainedCreditAssociationState({ ...f.state, guessedPositionMeaning: 'director' }),
    ).toThrow();
    f.addAttribution();
    const missing = structuredClone(f.state) as unknown as {
      participations: { sourceIdentity?: Record<string, unknown> }[];
    };
    delete missing.participations[1]!.sourceIdentity!.eid;
    expect(() => checkedRetainedCreditAssociationState(missing)).toThrow();
    f.state.participations[1]!.id = f.state.participations[0]!.id;
    expect(() => checkedRetainedCreditAssociationState(f.state)).toThrow();
  } finally {
    f.clean();
  }
});

test('credited language uses shared syntax validation and preserves its recorded spelling', () => {
  const f = fixture(false);
  try {
    f.addAttribution();
    for (const language of ['ja', 'EN-latn-us', 'x-retained', 'i-klingon']) {
      f.state.participations[1]!.creditedName!.language = language;
      expect(
        checkedRetainedCreditAssociationState(f.state).participations[1]!.creditedName!.language,
      ).toBe(language);
    }
    for (const language of ['', 'en US', 'en-a', 'en-a-value-a-again', ' ja']) {
      f.state.participations[1]!.creditedName!.language = language;
      expect(() => checkedRetainedCreditAssociationState(f.state)).toThrow();
    }
  } finally {
    f.clean();
  }
});

test('Source binding reads compare exact retained coordinates and keep withdrawal separate from the native occurrence', async () => {
  const f = fixture(false);
  try {
    f.live.native = false;
    f.live.sourceIntent = id(60);
    f.state.origin = {
      kind: 'source-binding',
      binding: id(60),
      proposal: id(61),
      conversion: id(62),
      record: id(63),
      observation: id(64),
      sourceOccurrence: `urn:rezics:source-occurrence:${'a'.repeat(64)}`,
      sourceOrdinal: 0,
    };
    const original = structuredClone(f.state);
    f.deps.owners.origin = async () => ({
      credit: original.credit,
      creditRevision: original.creditRevision,
      work: original.work,
      workRevision: original.workRevision,
      role: original.role,
      retainedProfile: original.retainedProfile,
      origin: structuredClone(original.origin),
      receipt: workEditReceiptIri(uuid(5)),
      participations: structuredClone(original.participations),
      validation: [
        {
          basis: { kind: 'source-binding', binding: id(60) },
          state: f.live.sourceState.get(id(60))!,
          receipt: receipt(60),
          validationToken: hash(f.live.sourceState.get(id(60))!),
          fields: {},
          evidence: [id(90)],
        },
      ],
    });
    f.store();
    expect((await f.read())?.sourceValidation[0]?.state).toBe('current');
    f.live.sourceState.set(id(60), 'withdrawn');
    const withdrawn = await f.read();
    expect(withdrawn?.occurrence).toBe(id(2));
    expect(withdrawn?.sourceValidation[0]?.state).toBe('withdrawn');
    f.state.origin.sourceOrdinal = 1;
    f.store();
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
  } finally {
    f.clean();
  }
});

test('selected-publication transcriber reads preserve the actual decision credit and require its owner', async () => {
  const f = fixture();
  try {
    f.state.role = 'transcriber';
    f.state.mapping.originRole = 'transcriber';
    f.state.origin = {
      kind: 'selected-publication',
      decision: f.state.credit,
      source: id(66),
      record: id(67),
      observation: id(68),
    };
    f.state.mapping.subjectRole = `${id(30)}/role/transcriber`;
    f.state.participations[1]!.role = f.state.mapping.subjectRole;
    const original = structuredClone(f.state);
    f.deps.owners.origin = async () => ({
      credit: original.credit,
      creditRevision: original.creditRevision,
      work: original.work,
      workRevision: original.workRevision,
      role: original.role,
      retainedProfile: original.retainedProfile,
      origin: structuredClone(original.origin),
      receipt: receipt(65),
      participations: structuredClone(original.participations),
      validation: [
        {
          basis: { kind: 'selected-publication', decision: original.credit },
          state: 'current',
          receipt: receipt(65),
          validationToken: hash('selected'),
          fields: {},
          evidence: [id(90)],
        },
      ],
    });
    f.store();
    const view = await f.read();
    expect(view?.occurrence).toBe(id(2));
    expect(view?.state.role).toBe('transcriber');
    expect(view?.state.origin).toEqual(original.origin);
    delete f.deps.owners.origin;
    await expect(f.read()).rejects.toBeInstanceOf(RetainedCreditReadUnavailable);
  } finally {
    f.clean();
  }
});

test('Account-issued principals open, fence, page and hydrate without cloning live authority', async () => {
  const account = await accountReader();
  const f = fixture(false, 'artist', 'vndb', 'staff', account.reader);
  try {
    expect(Object.keys(account.reader)).toContain('currentAssertion');
    expect(account.reader.accountScopes).toEqual(['work:read']);
    expect(account.reader.accountConsentId).toBe('credit-read-consent');
    f.addAttribution();
    const seen = new Set<string>();
    const original = { ...f.deps.owners };
    const liveAuthority = (operation: string, reader: VerifiedPrincipal) => {
      seen.add(operation);
      expect(reader.currentAssertion).toBe(account.reader.currentAssertion);
      expect((reader as VerifiedAccountAssertion).accountExpiresAt).toBe(
        account.reader.accountExpiresAt,
      );
      expect(reader.contentEvidence).toEqual(account.reader.contentEvidence);
    };
    f.deps.owners.activation = async (input) => {
      liveAuthority('activation', input.principal);
      return original.activation!(input);
    };
    f.deps.owners.mapping = async (input) => {
      liveAuthority('mapping', input.principal);
      expect(() => structuredClone(input.basis)).not.toThrow();
      return original.mapping!(input);
    };
    f.deps.owners.coverage = async (input) => {
      liveAuthority('coverage', input.principal);
      expect(() => structuredClone(input.basis)).not.toThrow();
      return original.coverage!(input);
    };
    f.deps.owners.attribution = async (input) => {
      liveAuthority('attribution', input.principal);
      expect(() => structuredClone(input.basis)).not.toThrow();
      return original.attribution!(input);
    };
    const initialCalls = account.state.calls;
    const opening = f.open();
    await expect(opening).resolves.toMatchObject({ reader: { subject: principal.subject } });
    const basis = await opening;
    expect(Object.keys(basis.reader)).not.toContain('currentAssertion');
    expect(Object.keys(basis.reader)).not.toContain('accountExpiresAt');
    expect(() => structuredClone(basis.reader)).not.toThrow();
    await fenceRetainedCreditAssociationRead(f.deps, basis);
    const page = await readRetainedCreditAssociationCandidates(f.deps, { basis, limit: 2 });
    expect(page.items.map((item) => item.credit)).toEqual([f.value.credit]);
    const view = await readRetainedCreditAssociationView(f.deps, {
      basis,
      work: f.value.work,
      credit: f.value.credit,
    });
    expect(view?.occurrence).toBe(f.value.credit);
    expect(view?.sourceValidation).toHaveLength(2);
    expect(view?.position.reader).toEqual(basis.reader);
    expect(() => structuredClone(view)).not.toThrow();
    expect([...seen].sort()).toEqual(['activation', 'attribution', 'coverage', 'mapping']);
    expect(account.state.calls).toBeGreaterThan(initialCalls);

    account.state.active = false;
    for (const read of [
      () => f.open(),
      () => fenceRetainedCreditAssociationRead(f.deps, basis),
      () => readRetainedCreditAssociationCandidates(f.deps, { basis, limit: 2 }),
      () =>
        readRetainedCreditAssociationView(f.deps, {
          basis,
          work: f.value.work,
          credit: f.value.credit,
        }),
    ])
      await expect(read()).rejects.toBeInstanceOf(AccountAssertionDenied);
  } finally {
    f.clean();
    await account.close();
  }
});

test('Account expiry, unavailable enforcement and changed disclosure refuse every retained read entry point', async () => {
  const account = await accountReader();
  const f = fixture(true, 'artist', 'vndb', 'staff', account.reader);
  try {
    const basis = await f.open();
    const reads = [
      () => f.open(),
      () => fenceRetainedCreditAssociationRead(f.deps, basis),
      () => readRetainedCreditAssociationCandidates(f.deps, { basis, limit: 2 }),
      () =>
        readRetainedCreditAssociationView(f.deps, {
          basis,
          work: f.value.work,
          credit: f.value.credit,
        }),
    ];
    account.state.available = false;
    for (const read of reads)
      await expect(read()).rejects.toBeInstanceOf(AccountAssertionUnavailable);
    account.state.available = true;
    account.state.emailVerified = false;
    // A fresh opening can bind the changed reader; an existing continuation cannot.
    for (const read of reads.slice(1))
      await expect(read()).rejects.toBeInstanceOf(RetainedCreditReadMoved);
    account.state.emailVerified = true;
    setSystemTime(account.reader.accountExpiresAt! * 1000);
    for (const read of reads) await expect(read()).rejects.toBeInstanceOf(AccountAssertionDenied);
  } finally {
    setSystemTime();
    f.clean();
    await account.close();
  }
});

for (const phase of [
  'empty-page',
  'witness',
  'withheld-disclosure',
  'withheld-coverage',
] as const) {
  test(`Account revocation during ${phase} cannot return a completed retained read`, async () => {
    const account = await accountReader();
    const f = fixture(true, 'artist', 'vndb', 'staff', account.reader);
    try {
      const basis = await f.open();
      const revoke = () => {
        account.state.active = false;
      };
      if (phase === 'empty-page') {
        f.live.headAvailable = false;
        const query = f.deps.environment.fuseki.query.bind(f.deps.environment.fuseki);
        f.deps.environment.fuseki.query = async (...args) => {
          const result = await query(...args);
          if (args[0].includes('ORDER BY ?work ?credit ?associationHead')) revoke();
          return result;
        };
      } else if (phase === 'witness') f.live.afterMapping = revoke;
      else if (phase === 'withheld-disclosure') {
        f.live.readable = false;
        f.live.afterRead = revoke;
      } else {
        f.live.withheld = true;
        const coverage = f.deps.owners.coverage!;
        f.deps.owners.coverage = async (input) => {
          const result = await coverage(input);
          revoke();
          return result;
        };
      }
      const read =
        phase === 'empty-page'
          ? readRetainedCreditAssociationCandidates(f.deps, { basis, limit: 2 })
          : readRetainedCreditAssociationView(f.deps, {
              basis,
              work: f.value.work,
              credit: f.value.credit,
            });
      await expect(read).rejects.toBeInstanceOf(AccountAssertionDenied);
    } finally {
      f.clean();
      await account.close();
    }
  });
}

for (const origin of ['source-binding', 'selected-publication'] as const) {
  test(`Account authority reaches the ${origin} origin owner independently of serialized positions`, async () => {
    const account = await accountReader();
    const f = fixture(false, 'artist', 'vndb', 'staff', account.reader);
    try {
      f.live.native = false;
      f.live.sourceIntent = id(60);
      if (origin === 'source-binding') {
        f.state.origin = {
          kind: origin,
          binding: id(60),
          proposal: id(61),
          conversion: id(62),
          record: id(63),
          observation: id(64),
          sourceOccurrence: `urn:rezics:source-occurrence:${'a'.repeat(64)}`,
          sourceOrdinal: 0,
        };
      } else {
        f.state.role = 'transcriber';
        f.state.mapping.originRole = 'transcriber';
        f.state.mapping.subjectRole = `${id(30)}/role/transcriber`;
        f.state.participations[1]!.role = f.state.mapping.subjectRole;
        f.state.origin = {
          kind: origin,
          decision: f.state.credit,
          source: id(66),
          record: id(67),
          observation: id(68),
        };
      }
      f.addAttribution();
      const original = structuredClone(f.state);
      let originReads = 0;
      f.deps.owners.origin = async (input) => {
        originReads++;
        expect(input.principal.currentAssertion).toBe(account.reader.currentAssertion);
        expect(input.basis.reader.accountConsentId).toBe(account.reader.accountConsentId);
        expect(() => structuredClone(input.basis)).not.toThrow();
        return {
          credit: original.credit,
          creditRevision: original.creditRevision,
          work: original.work,
          workRevision: original.workRevision,
          role: original.role,
          retainedProfile: original.retainedProfile,
          origin: original.origin,
          receipt: origin === 'source-binding' ? workEditReceiptIri(uuid(5)) : receipt(65),
          participations: original.participations,
          validation: [
            {
              basis:
                origin === 'source-binding'
                  ? { kind: 'source-binding', binding: id(60) }
                  : { kind: 'selected-publication', decision: original.credit },
              state: 'current',
              receipt: receipt(60),
              validationToken: hash('current'),
              fields: {},
              evidence: [id(90)],
            },
          ],
        };
      };
      const view = await f.read();
      expect(view?.occurrence).toBe(original.credit);
      expect(view?.state.origin).toEqual(original.origin);
      expect(originReads).toBeGreaterThan(1);
      expect(() => structuredClone(view)).not.toThrow();
    } finally {
      f.clean();
      await account.close();
    }
  });
}
