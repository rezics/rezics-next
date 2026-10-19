import { expect, test } from 'bun:test';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { AdmissionDenied, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { WorkEditAuthorityProof } from '../src/modules/access/work-edit-authority.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { authorCreditDigest, type AuthorCreditValue } from '../src/modules/work/author-credit.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';
import { nativeCreditDigest } from '../src/modules/profiles/credits.ts';
import { readCreditOwnerWitness } from '../src/modules/work/credit-verification.ts';
import {
  verifyCreditNativeBasis,
  verifyVndbCreditNativeBasis,
  verifyBangumiCreditNativeBasis,
  verifyMusicBrainzCreditNativeBasis,
  type CreditNativeVerifierDependencies,
  type CreditNativeVerificationInput,
  type CreditNativeVerificationResult,
} from '../src/modules/source/credit-native-verifiers.ts';
import type { SourceAuthorCreditSupport } from '../src/modules/source/author-credit.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const id = (n: number) => `https://rezics.com/id/${uuid(n)}`;
const principal: VerifiedPrincipal = {
  issuer: 'https://account.example',
  subject: 'credit-editor',
};
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

/** Stack-free owner composition fixture. Graph and Access transports are test
 * doubles; successful tests establish no live provider conversion or admission. */
function fixture(provider = 'vndb', namespace = 'staff', agent = false) {
  const admission = uuid(5),
    receipt = workEditReceiptIri(admission);
  const value: AuthorCreditValue = {
    work: id(1),
    credit: id(2),
    revision: id(5),
    expectedHead: id(3),
    actingSubject: id(4),
    role: 'artist',
    nativeOrdinal: 2,
    sourceRoleKey: null,
    sourceKey: 'same-key',
    provider,
    namespace,
    ...(agent ? { agent: id(6) } : {}),
  };
  const state = {
    value,
    head: id(3),
    nativeCommand: true,
    sourceIntent: id(2),
    exists: true,
    revisionAvailable: true,
    origins: 1,
    receiptAvailable: true,
    cancelled: false,
    retired: false,
    protected: false,
    erased: false,
    held: false,
    epoch: 'credit-epoch',
    routing: 'routing-1',
    revisionEpoch: 'credit-epoch',
    sequence: '12',
    receiptDigest: null as string | null,
    receiptAdmission: admission,
    receiptWork: id(1),
    receiptHead: id(3),
    receiptCredit: id(2),
    receiptRevision: id(5),
    originReceipt: receipt,
    receiptIntent: null as string | null,
    authorityCalls: 0,
    sourceCalls: 0,
    denied: false,
    afterAuthority: undefined as (() => void) | undefined,
    afterSource: undefined as (() => void) | undefined,
    authorityEpoch: '7',
    queries: [] as string[],
    pins: null as Record<string, string> | null,
    support: null as SourceAuthorCreditSupport | null,
  };
  const digest = () =>
    state.nativeCommand
      ? nativeCreditDigest({
          work: value.work,
          credit: value.credit,
          role: value.role!,
          expectedWorkHead: value.expectedHead,
          actingSubject: value.actingSubject,
          ...(value.agent
            ? { agent: value.agent }
            : {
                participant: {
                  kind: 'external-reference',
                  provider: value.provider!,
                  namespace: value.namespace!,
                  key: value.sourceKey,
                },
                ordinal: value.nativeOrdinal,
              }),
        })
      : authorCreditDigest(value, state.sourceIntent);
  const query = async (sparql: string): Promise<SparqlResult> => {
    state.queries.push(sparql);
    if (sparql.includes('SELECT ?revision ?kind'))
      return !state.exists || state.retired
        ? rows()
        : rows({
            revision: value.revision,
            kind: `${RV}${value.agent ? 'NativeAgentCredit' : 'AuthorCredit'}`,
          });
    if (sparql.includes('SELECT ?work ?head ?key'))
      return !state.revisionAvailable || state.erased
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
            epoch: state.revisionEpoch,
            sequence: state.sequence,
            ...(state.pins ?? {
              model: value.modelRevision ?? 'https://rezics.com/definition/work-author-credit-v1',
              shape: value.modelRevision ?? 'https://rezics.com/definition/work-author-credit-v1',
              ...(value.modelRevision ? { currentModel: value.modelRevision } : {}),
            }),
            ...(value.sourceRoleKey === null ? {} : { role: value.sourceRoleKey }),
          });
    if (sparql.includes('SELECT ?work ?head ?agent'))
      return !state.revisionAvailable || state.erased
        ? rows()
        : rows({
            work: value.work,
            head: value.expectedHead,
            agent: value.agent!,
            role: value.role!,
            actor: value.actingSubject,
            epoch: state.revisionEpoch,
            sequence: state.sequence,
            ...(state.pins ?? {
              model: value.modelRevision ?? 'https://rezics.com/definition/native-agent-credit-v1',
              shape: value.modelRevision ?? 'https://rezics.com/definition/native-agent-credit-v1',
              ...(value.modelRevision ? { currentModel: value.modelRevision } : {}),
            }),
          });
    if (sparql.includes('SELECT DISTINCT ?receipt ?admission'))
      return rows(
        ...Array.from({ length: state.origins }, (_, index) => ({
          receipt: index ? workEditReceiptIri(uuid(99)) : state.originReceipt,
          admission: index ? uuid(99) : admission,
          nativeCommand: String(state.nativeCommand),
        })),
      );
    if (sparql.includes('SELECT ?outcome ?reason'))
      return !state.receiptAvailable
        ? rows()
        : rows({
            outcome: `${RV}${state.cancelled ? 'Cancelled' : 'Succeeded'}`,
            digest: state.receiptDigest ?? digest(),
            admissionId: state.receiptAdmission,
            authorityEpoch: '7',
            scope: `work:edit:${state.receiptWork}`,
            epoch: 'credit-epoch',
            sequence: state.sequence,
            ...(state.cancelled
              ? {}
              : {
                  work: state.receiptWork,
                  revision: state.receiptHead,
                  predecessor: state.receiptHead,
                }),
          });
    if (sparql.includes('SELECT DISTINCT ?credit ?revision ?intent'))
      return rows({
        credit: state.receiptCredit,
        revision: state.receiptRevision,
        intent: state.receiptIntent ?? state.sourceIntent,
      });
    if (sparql.includes('SELECT ?workHead ?creditHead'))
      return state.retired || state.protected || state.erased || state.held
        ? rows()
        : rows({
            workHead: state.head,
            creditHead: value.revision,
            epoch: state.epoch,
            routing: state.routing,
          });
    throw new Error(`Unexpected graph query: ${sparql}`);
  };
  const environment = {
    fuseki: { query },
    lineage: { dataEpoch: 'credit-epoch', routingEpoch: 'routing-1' },
  } as unknown as WorkActivationEnvironment;
  const deps: CreditNativeVerifierDependencies = {
    environment,
    access: {
      async withWorkEditAuthority(p, actingSubject, work, commit) {
        expect(p).toBe(principal);
        expect(actingSubject).toBe(id(4));
        expect(work).toBe(id(1));
        state.authorityCalls++;
        if (state.authorityCalls === 2) state.afterAuthority?.();
        if (state.denied) throw new AdmissionDenied('revoked');
        return commit({
          principalId: uuid(7),
          principalEpoch: '1',
          actingSubject,
          scope: `work:edit:${work}`,
          action: 'work.edit',
          authorityEpoch: state.authorityEpoch,
          recoveryGeneration: '1',
          subjectGeneration: '1',
          representationId: uuid(8),
          representationGeneration: '1',
          grantId: uuid(9),
          grantGeneration: '1',
          validUntil: new Date(Date.now() + 15_000).toISOString(),
        } satisfies WorkEditAuthorityProof);
      },
    },
    sourceCredits: {
      async read(principalId, supportId) {
        expect(principalId).toBe(uuid(7));
        expect(supportId).toBe(uuid(10));
        state.sourceCalls++;
        if (state.sourceCalls === 2) state.afterSource?.();
        return state.support && structuredClone(state.support);
      },
    },
  };
  const input: CreditNativeVerificationInput = {
    principal,
    actingSubject: id(4),
    basis: {
      target: value.work,
      component: value.credit,
      revision: value.revision,
      receipt,
      workHead: state.head,
      occurrence: value.credit,
      property: 'role',
      source: null,
      qualifications: {
        role: value.role!,
        participant: value.agent
          ? { kind: 'agent', agent: value.agent }
          : { kind: 'external-reference', provider, namespace, key: value.sourceKey },
        ordinal: value.agent ? null : value.nativeOrdinal,
        sourceRoleKey: null,
        workRevision: value.expectedHead,
        participation: null,
        statement: null,
        acceptance: null,
      },
    },
    selected: { value: value.role, language: null },
  };
  function source() {
    state.nativeCommand = false;
    state.sourceIntent = id(10);
    value.revision = id(11);
    state.receiptRevision = value.revision;
    input.basis.revision = value.revision;
    value.sourceRoleKey = 'art';
    input.basis.qualifications.sourceRoleKey = 'art';
    const selected = {
      support: id(10),
      proposal: id(12),
      conversion: id(13),
      record: id(14),
      observation: id(15),
      sourceOccurrence: `urn:rezics:source-occurrence:${'a'.repeat(64)}`,
      sourceOrdinal: 3,
    };
    input.basis.source = selected;
    state.support = {
      profile: 'source-author-credit-support-v1',
      state: 'recorded',
      ...selected,
      work: value.work,
      credit: {
        ...value,
        profile: 'work-author-credit-v1',
        participantKind: 'external-reference',
        provider,
        namespace,
        role: value.role!,
        control: 'human-confirmed',
        rightsStatus: 'undetermined',
        dataEpoch: state.revisionEpoch,
        sequence: state.sequence,
      },
      sourceKey: value.sourceKey,
      sourceRoleKey: value.sourceRoleKey,
      baseSupport: null,
      nativeReceipt: receipt,
      sourceGraphReceipt: `urn:rezics:receipt:${'b'.repeat(64)}`,
      correspondence: null,
      correspondenceKind: 'initial',
      headGuarantee: 'transaction-guarded',
      rightsEvidence: {} as SourceAuthorCreditSupport['rightsEvidence'],
      rightsStatus: 'undetermined',
      withdrawal: null,
      createdAt: '2026-10-19T00:00:00.000Z',
    };
  }
  return { state, deps, input, source, receipt };
}

for (const agent of [false, true]) {
  test(`exact V2 ${agent ? 'Agent' : 'external'} credit retains its original native receipt on repeated reads`, async () => {
    const { state, deps, receipt } = fixture('vndb', 'staff', agent);
    state.value.role = 'performer';
    state.value.modelRevision = `https://rezics.com/definition/${agent ? 'native-agent-credit' : 'work-author-credit'}-v2`;
    const first = await readCreditOwnerWitness(deps.environment, state.value.credit);
    expect(first).toMatchObject({ value: { role: 'performer', modelRevision: state.value.modelRevision },
      receipt: { receipt, credit: state.value.credit, revision: state.value.revision, expectedHead: state.value.expectedHead } });
    expect(await readCreditOwnerWitness(deps.environment, state.value.credit)).toEqual(first);
    const mismatchedPins: Record<string, string>[] = [
      { model: state.value.modelRevision, shape: state.value.modelRevision },
      { model: state.value.modelRevision, shape: state.value.modelRevision, currentModel: 'https://rezics.com/definition/wrong-v2' },
      { model: state.value.modelRevision, shape: state.value.modelRevision.replace('-v2', '-v1'), currentModel: state.value.modelRevision },
    ];
    for (const pins of mismatchedPins) {
      state.pins = pins;
      await expect(readCreditOwnerWitness(deps.environment, state.value.credit)).rejects.toThrow();
    }
    state.pins = null;
    state.receiptRevision = id(99);
    await expect(readCreditOwnerWitness(deps.environment, state.value.credit)).rejects.toThrow();
  });
}

function disposition(
  result: CreditNativeVerificationResult,
  expected: CreditNativeVerificationResult['disposition'],
) {
  expect(result.disposition).toBe(expected);
}

for (const [provider, namespace, verify] of [
  ['vndb', 'staff', verifyVndbCreditNativeBasis],
  ['bangumi', 'person', verifyBangumiCreditNativeBasis],
  ['musicbrainz', 'artist', verifyMusicBrainzCreditNativeBasis],
] as const) {
  test(`${provider} entry returns the actual command receipt and exact native basis`, async () => {
    const { state, deps, input, receipt } = fixture(provider, namespace);
    input.basis.property = 'key';
    input.selected.value = 'same-key';
    const result = await verify(deps, input);
    expect(result).toMatchObject({
      disposition: 'verified',
      receipt,
      revision: id(5),
      nativeBasis: input.basis,
      value: 'same-key',
      language: null,
      headGuarantee: 'verified-before-commit',
      commandReceipt: {
        admissionId: uuid(5),
        credit: id(2),
        revision: id(5),
        work: id(1),
        expectedHead: id(3),
      },
    });
    expect(receipt).not.toBe(input.basis.component);
    expect(receipt).not.toBe(input.basis.revision);
    expect(state.authorityCalls).toBe(2);
    expect(state.queries.length).toBeLessThanOrEqual(12);
  });
}

test('a stored native Agent participant is attested by identity; a provider cannot infer that binding', async () => {
  const { deps, input } = fixture('vndb', 'staff', true);
  input.basis.property = 'participant';
  input.selected.value = { kind: 'agent', agent: id(6) };
  disposition(await verifyCreditNativeBasis(deps, input), 'verified');
  disposition(await verifyVndbCreditNativeBasis(deps, input), 'unavailable');
  input.basis.property = 'creditedName';
  input.selected.value = 'A current display name';
  disposition(await verifyCreditNativeBasis(deps, input), 'unavailable');
});

test('replay returns the same actual receipt and occurrence without writing or allocating anything', async () => {
  const { deps, input, state } = fixture();
  const first = await verifyVndbCreditNativeBasis(deps, input);
  const [second, concurrent] = await Promise.all([
    verifyVndbCreditNativeBasis(deps, input),
    verifyVndbCreditNativeBasis(deps, input),
  ]);
  expect(second).toEqual(first);
  expect(concurrent).toEqual(first);
  expect(state.queries.every((query) => !/\b(INSERT|DELETE|UPDATE)\b/.test(query))).toBe(true);
});

test('provider and namespace collisions cannot reuse a matching external key', async () => {
  const { deps, input, state } = fixture();
  disposition(await verifyBangumiCreditNativeBasis(deps, input), 'target-mismatch');
  input.basis.qualifications.participant = {
    kind: 'external-reference',
    provider: 'vndb',
    namespace: 'person',
    key: 'same-key',
  };
  disposition(await verifyVndbCreditNativeBasis(deps, input), 'target-mismatch');
  expect(state.queries).toHaveLength(0);
});

for (const field of ['component', 'revision', 'receipt', 'occurrence'] as const) {
  test(`an acknowledgement cannot substitute its ${field}`, async () => {
    const { deps, input } = fixture();
    input.basis[field] = field === 'receipt' ? workEditReceiptIri(uuid(90)) : id(90);
    // This transport fixture returns one stored owner regardless of the queried
    // subject; the other exact coordinates must still prevent acknowledgement.
    disposition(
      await verifyVndbCreditNativeBasis(deps, input),
      field === 'component'
        ? 'unavailable'
        : field === 'revision'
          ? 'head-mismatch'
          : 'target-mismatch',
    );
  });
}

test('Work target mismatches remain distinct from unavailable owners', async () => {
  const changed = fixture();
  changed.state.value.work = id(90);
  changed.state.receiptWork = id(90);
  disposition(await verifyVndbCreditNativeBasis(changed.deps, changed.input), 'target-mismatch');
  const absent = fixture();
  absent.state.exists = false;
  disposition(await verifyVndbCreditNativeBasis(absent.deps, absent.input), 'unavailable');
});

for (const change of ['role', 'ordinal', 'participant', 'sourceRoleKey', 'workRevision'] as const) {
  test(`exact participation qualification includes ${change}`, async () => {
    const { deps, input } = fixture();
    const q = input.basis.qualifications;
    if (change === 'role') q.role = 'director';
    if (change === 'ordinal') q.ordinal = 1;
    if (change === 'participant')
      q.participant = {
        kind: 'external-reference',
        provider: 'vndb',
        namespace: 'staff',
        key: 'other-key',
      };
    if (change === 'sourceRoleKey') q.sourceRoleKey = 'art';
    if (change === 'workRevision') q.workRevision = id(99);
    disposition(await verifyVndbCreditNativeBasis(deps, input), 'target-mismatch');
  });
}

for (const change of ['value', 'language', 'coercion'] as const) {
  test(`retained ${change} differences cannot attest the selected value`, async () => {
    const { deps, input } = fixture();
    if (change === 'value') input.selected.value = 'author';
    if (change === 'language') input.selected.language = 'ja';
    if (change === 'coercion') {
      input.basis.property = 'ordinal';
      input.selected.value = '2';
    }
    disposition(await verifyVndbCreditNativeBasis(deps, input), 'value-mismatch');
  });
}

for (const property of ['alias', 'eid', 'note', 'creditedName', 'sourceRoleKey'] as const) {
  test(`unwritten ${property} is unavailable, including an explicit null selection`, async () => {
    const { deps, input } = fixture();
    input.basis.property = property;
    input.selected.value = null;
    disposition(await verifyVndbCreditNativeBasis(deps, input), 'unavailable');
  });
}

for (const qualification of ['participation', 'statement', 'acceptance'] as const) {
  test(`a claimed ${qualification} needs its installed qualified occurrence owner`, async () => {
    const { deps, input } = fixture();
    input.basis.qualifications[qualification] = id(44);
    disposition(await verifyVndbCreditNativeBasis(deps, input), 'unavailable');
  });
}

for (const change of [
  'origins',
  'missing-receipt',
  'digest',
  'admission',
  'cancelled',
  'revision-epoch',
] as const) {
  test(`unavailable original ${change} never becomes a synthetic receipt`, async () => {
    const { deps, input, state } = fixture();
    if (change === 'origins') state.origins = 2;
    if (change === 'missing-receipt') state.receiptAvailable = false;
    if (change === 'digest') state.receiptDigest = 'f'.repeat(64);
    if (change === 'admission') state.receiptAdmission = uuid(99);
    if (change === 'cancelled') state.cancelled = true;
    if (change === 'revision-epoch') state.revisionEpoch = 'another-epoch';
    disposition(await verifyVndbCreditNativeBasis(deps, input), 'unavailable');
  });
}

for (const change of ['retired', 'protected', 'erased', 'held', 'epoch', 'routing'] as const) {
  test(`current owner ${change} invalidates a formerly valid witness`, async () => {
    const { deps, input, state } = fixture();
    state.afterAuthority = () => {
      if (change === 'epoch' || change === 'routing') state[change] = 'changed';
      else state[change] = true;
    };
    disposition(await verifyVndbCreditNativeBasis(deps, input), 'unavailable');
  });
}

test('stale acknowledged and concurrently moving Work heads have the head disposition', async () => {
  const stale = fixture();
  stale.input.basis.workHead = id(99);
  disposition(await verifyVndbCreditNativeBasis(stale.deps, stale.input), 'head-mismatch');
  const moved = fixture();
  moved.state.afterAuthority = () => {
    moved.state.head = id(99);
  };
  disposition(await verifyVndbCreditNativeBasis(moved.deps, moved.input), 'head-mismatch');
});

test('active Work-edit authority is checked twice and revoked authority never succeeds', async () => {
  const denied = fixture();
  denied.state.denied = true;
  disposition(await verifyVndbCreditNativeBasis(denied.deps, denied.input), 'authority-denied');
  expect(denied.state.queries).toHaveLength(0);
  const revoked = fixture();
  revoked.state.afterAuthority = () => {
    revoked.state.denied = true;
  };
  disposition(await verifyVndbCreditNativeBasis(revoked.deps, revoked.input), 'authority-denied');
  const changed = fixture();
  changed.state.afterAuthority = () => {
    changed.state.authorityEpoch = '8';
  };
  disposition(await verifyVndbCreditNativeBasis(changed.deps, changed.input), 'authority-denied');
});

test('Source adoption resolves its exact support tuple and retained role key twice', async () => {
  const { deps, input, source, state } = fixture();
  source();
  input.basis.property = 'sourceRoleKey';
  input.selected.value = 'art';
  const before = structuredClone(state.support);
  expect(await verifyVndbCreditNativeBasis(deps, input)).toMatchObject({
    disposition: 'verified',
    value: 'art',
    nativeBasis: { source: input.basis.source },
    commandReceipt: { sourceIntent: id(10) },
  });
  expect(state.sourceCalls).toBe(2);
  expect(state.support).toEqual(before);
  // No silent relabelling of the retained art key as an author role.
  input.basis.property = 'role';
  input.selected.value = 'art';
  disposition(await verifyVndbCreditNativeBasis(deps, input), 'value-mismatch');
});

test('Source origin cannot be replaced by an unqualified native assertion', async () => {
  const { deps, input, source } = fixture();
  source();
  input.basis.source = null;
  disposition(await verifyVndbCreditNativeBasis(deps, input), 'unavailable');
});

for (const coordinate of [
  'support',
  'proposal',
  'conversion',
  'record',
  'observation',
  'sourceOccurrence',
  'sourceOrdinal',
] as const) {
  test(`a different retained ${coordinate} cannot share the native receipt`, async () => {
    const { deps, input, source } = fixture();
    source();
    const selected = input.basis.source!;
    if (coordinate === 'sourceOrdinal') selected.sourceOrdinal++;
    else
      selected[coordinate] =
        coordinate === 'sourceOccurrence'
          ? `urn:rezics:source-occurrence:${'c'.repeat(64)}`
          : id(99);
    disposition(await verifyVndbCreditNativeBasis(deps, input), 'unavailable');
  });
}

test('independent Source support is checked and withdrawal does not retire the native occurrence', async () => {
  const { deps, input, source, state } = fixture();
  source();
  state.afterSource = () => {
    state.support!.state = 'withdrawn';
    state.support!.withdrawal = {
      withdrawal: id(80),
      reason: 'withdraw this evidence',
      createdAt: '2026-10-19T01:00:00.000Z',
    };
  };
  disposition(await verifyVndbCreditNativeBasis(deps, input), 'unavailable');
  expect(state.retired).toBe(false);
  expect(state.exists).toBe(true);
});

test('unknown qualifications and caller mutation cannot enter a verified acknowledgement', async () => {
  const unknown = fixture();
  Object.assign(unknown.input.basis.qualifications, { alias: 'not attested' });
  disposition(await verifyVndbCreditNativeBasis(unknown.deps, unknown.input), 'unavailable');
  const mutated = fixture();
  const original = structuredClone(mutated.input.basis);
  mutated.state.afterAuthority = () => {
    mutated.input.basis.property = 'note';
    mutated.input.selected.value = 'invented';
  };
  expect(await verifyVndbCreditNativeBasis(mutated.deps, mutated.input)).toMatchObject({
    disposition: 'verified',
    value: 'artist',
    nativeBasis: original,
  });
});
