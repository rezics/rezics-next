import { expect, test, setSystemTime } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import {
  AccountAssertionDenied,
  AccountAssertionUnavailable,
  AccountAssertionVerifier,
  type VerifiedAccountAssertion,
} from '../src/modules/account/verify-assertion.ts';
import { familyReceiptIri } from '../src/modules/semantic/command.ts';
import { nativeCreditDigest } from '../src/modules/profiles/credits.ts';
import {
  hash,
  prepareComponent,
  RV,
  type WorkActivationEnvironment,
} from '../src/modules/work/activate.ts';
import { authorCreditDigest, type AuthorCreditValue } from '../src/modules/work/author-credit.ts';
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
  fenceRetainedCreditAssociationRead,
  readRetainedCreditAssociationCandidates,
  readRetainedCreditAssociationView,
  RetainedCreditReadMoved,
  RetainedCreditReadUnavailable,
  type RetainedCreditAssociationReadDependencies,
  type RetainedCreditSourceValidation,
} from '../src/modules/work/credit-association-read.ts';
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
    server.stop(true);
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
    candidates: undefined as Record<string, string>[] | undefined,
  };
  const sealed = new Map<
    string,
    {
      state: RetainedCreditAssociationState;
      manifest: string;
      predecessor: string | null;
      admission: string;
    }
  >();
  const mappings = new Map<string, RetainedCreditMapping>();
  const store = (
    stored: RetainedCreditAssociationState = state,
    head = live.head,
    predecessor: string | null = null,
  ) => {
    const snapshot = checkedRetainedCreditAssociationState(stored);
    const manifest = `urn:rezics:sha256:${prepareComponent(directory, state.credit, snapshot, RETAINED_CREDIT_ASSOCIATIONS_PROFILE)}`;
    sealed.set(head, {
      state: snapshot,
      manifest,
      predecessor,
      admission: head.split('/').at(-1)!,
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
          sequence: '80',
          scope: `work:edit:${entry.state.work}`,
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
      fuseki: { query },
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
    clean: () => rmSync(directory, { recursive: true, force: true }),
  };
}

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
    account.close();
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
    account.close();
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
      account.close();
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
      account.close();
    }
  });
}
