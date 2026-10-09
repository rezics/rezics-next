import { expect, test } from 'bun:test';
import { AdmissionDenied, type AccessAdmissionRegistry, type ClaimedAdmission,
  type RegisteredAdmission, type VerifiedPrincipal } from '../src/modules/access/admission.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { sealWorkEdit, settleWorkEdit, type WorkEditEnvelope } from '../src/modules/work/command-envelope.ts';
import { PendingAdmittedWork } from '../src/modules/work/create-admitted.ts';
import { workEditReceiptIri } from '../src/modules/work/edit.ts';

class SpecimenUnavailable extends Error {}
class SpecimenInvalid extends Error {}
class SpecimenStale extends Error {}

const RV = 'https://rezics.com/vocab/';
const work = 'https://rezics.com/id/work';
const specimen = 'https://rezics.com/id/specimen';
const revision = 'https://rezics.com/id/revision';
const family: WorkEditEnvelope<'specimen'> = {
  target: 'specimen', revision: 'specimenRevision', deadlineMs: 10_000,
  unavailable: SpecimenUnavailable, invalid: SpecimenInvalid, stale: SpecimenStale,
  incomplete: 'Specimen receipt is incomplete',
  cancelled: 'Specimen command was cancelled; refresh its basis',
  mismatch: 'Specimen receipt targets another specimen', sealInvalid: false,
};
const principal: VerifiedPrincipal = { issuer: 'https://accounts.example', subject: 'user' };

function admission(over: Partial<RegisteredAdmission> = {}): RegisteredAdmission {
  return {
    id: '00000000-0000-4000-8000-0000000000aa', principalId: 'principal',
    actingSubject: 'https://rezics.com/id/subject', scope: `work:edit:${work}`, action: 'work.edit',
    idempotencyKey: 'specimen-key', requestDigest: 'digest-1', authorityEpoch: '4',
    expiresAt: '2026-10-10T00:00:10.000Z', state: 'claimed', dispatchEligible: true, replayed: false, ...over,
  };
}

type Binding = Record<string, { type: string; value: string }>;
const literal = (value: string) => ({ type: 'literal', value });
const uri = (value: string) => ({ type: 'uri', value });

function quoted(update: string, predicate: string): string {
  const match = new RegExp(`rv:${predicate} ("(?:\\\\.|[^"\\\\])*")`).exec(update);
  if (!match?.[1]) throw new Error(`cancel update has no ${predicate}`);
  return JSON.parse(match[1]) as string;
}

function graph() {
  let stored: { admissionId: string; row: Binding } | null = null;
  const updates: { update: string; deadlineMs: number }[] = [];
  const queries: string[] = [];
  let lose = false;
  let keepOnLoss = true;
  const fuseki = {
    async query(sparql: string) {
      queries.push(sparql);
      if (sparql.includes('ASK')) return { boolean: false };
      if (!stored || !sparql.includes(JSON.stringify(stored.admissionId))) return { results: { bindings: [] } };
      return { results: { bindings: [stored.row] } };
    },
    async commandWithReceipt(command: { update: string; deadlineMs: number }) {
      updates.push({ update: command.update, deadlineMs: command.deadlineMs });
      if (!lose || keepOnLoss) stored = { admissionId: quoted(command.update, 'admissionId'), row: {
        outcome: uri(`${RV}Cancelled`), digest: literal(quoted(command.update, 'requestDigest')),
        authority: literal(quoted(command.update, 'authorityEpoch')), scope: literal(quoted(command.update, 'admittedScope')),
        epoch: literal(quoted(command.update, 'dataEpoch')), sequence: literal('9'),
      } };
      if (lose) throw new Error('lost response');
      return { status: 'committed' as const };
    },
  };
  return { fuseki, updates, queries, lose(keep: boolean) { lose = true; keepOnLoss = keep; },
    succeed(admissionId: string, digest: string) {
      stored = { admissionId, row: {
        outcome: uri(`${RV}Succeeded`), digest: literal(digest), authority: literal('4'),
        scope: literal(`work:edit:${work}`), epoch: literal('7'), sequence: literal('9'),
        work: uri(work), component: uri(specimen), revision: uri(revision),
      } };
    } };
}

function environment(fuseki: object): WorkActivationEnvironment {
  return { fuseki, lineage: { dataEpoch: '7', routingEpoch: '1' }, objectDirectory: 'unused' } as WorkActivationEnvironment;
}

function accessFor(registered: RegisteredAdmission, claim: 'advance' | 'deny' | 'stay') {
  const calls = { claim: 0, commit: 0, recorded: 0 };
  const access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'> = {
    async register(request) {
      expect(request).toMatchObject({ principal, actingSubject: registered.actingSubject, action: 'work.edit',
        scope: `work:edit:${work}`, idempotencyKey: 'specimen-key', requestDigest: registered.requestDigest });
      return registered;
    },
    async claim(id, digest, who): Promise<ClaimedAdmission> {
      calls.claim += 1;
      expect(id).toBe(registered.id);
      expect(digest).toBe(registered.requestDigest);
      expect(who).toBe(principal);
      if (claim === 'deny') throw new AdmissionDenied('edit is not admitted');
      return { ...registered, ...(claim === 'advance' ? { state: 'claimed' as const } : {}),
        claimedAt: '2026-10-10T00:00:01.000Z' };
    },
    async recordGraphOutcome(id, proof) {
      calls.recorded += 1;
      expect(id).toBe(registered.id);
      expect(proof.admissionId).toBe(registered.id);
      expect(proof.receipt).toBe(workEditReceiptIri(registered.id));
    },
  };
  return { access, calls };
}

async function run(registered: RegisteredAdmission, claim: 'advance' | 'deny' | 'stay',
  commit: (admission: RegisteredAdmission, env: WorkActivationEnvironment, g: ReturnType<typeof graph>) => Promise<boolean>,
  g = graph()) {
  const { access, calls } = accessFor(registered, claim);
  const env = environment(g.fuseki);
  try {
    const result = await settleWorkEdit(env, access, principal, family, registered.actingSubject, work,
      'specimen-key', registered.requestDigest, specimen, admission => {
        calls.commit += 1;
        return commit(admission, env, g);
      });
    return { result, calls, g };
  } catch (error) { return { error, calls, g }; }
}

test('a denied claim cancels the work-edit envelope without committing', async () => {
  const { error, calls, g } = await run(admission({ state: 'registered' }), 'deny', async () => true);
  expect(error).toBeInstanceOf(SpecimenStale);
  expect((error as Error).message).toBe(family.cancelled);
  expect(calls.claim).toBe(1);
  expect(calls.commit).toBe(0);
  expect(calls.recorded).toBe(1);
  expect(g.updates).toHaveLength(1);
  expect(g.updates[0]!.deadlineMs).toBe(family.deadlineMs);
  expect(g.updates[0]!.update).toContain('rv:AdmissionCancelledEvent');
  expect(g.updates[0]!.update).toContain('rv:outcome rv:Cancelled');
  expect(g.queries.some(query => query.includes('rv:specimen ') && query.includes('rv:specimenRevision')
    && query.includes(JSON.stringify(admission().id)))).toBe(true);
});

test('an expected-revision mismatch seals a cancel and reports stale', async () => {
  const { error, calls, g } = await run(admission(), 'advance', async (admitted, env) => {
    await sealWorkEdit(env, admitted, family);
    return false;
  });
  expect(error).toBeInstanceOf(SpecimenStale);
  expect(calls.commit).toBe(1);
  expect(calls.recorded).toBe(1);
  expect(g.updates[0]!.update).toContain('rv:Cancelled');
});

test('revoked authority cancels without a claim or a commit', async () => {
  const { error, calls } = await run(admission({ dispatchEligible: false }), 'advance', async () => true);
  expect(error).toBeInstanceOf(SpecimenStale);
  expect(calls.claim).toBe(0);
  expect(calls.commit).toBe(0);
  expect(calls.recorded).toBe(1);
});

test('a lost commit response resolves by rereading the admission receipt', async () => {
  const { result, calls, g } = await run(admission(), 'advance', async (_admitted, _env, current) => {
    current.succeed(admission().id, 'digest-1');
    throw new Error('lost response');
  });
  expect(result).toMatchObject({ work, specimen, revision, replayed: true,
    receipt: workEditReceiptIri(admission().id), sourcePosition: { dataEpoch: '7', sequence: '9' } });
  expect(calls.commit).toBe(1);
  expect(calls.recorded).toBe(1);
  expect(g.updates).toHaveLength(0);
  const kept = graph();
  kept.lose(true);
  const reread = await run(admission({ dispatchEligible: false }), 'advance', async () => true, kept);
  expect(reread.error).toBeInstanceOf(SpecimenStale);
  expect(reread.calls.recorded).toBe(1);
  const dropped = graph();
  dropped.lose(false);
  const unresolved = await run(admission({ dispatchEligible: false }), 'advance', async () => true, dropped);
  expect(unresolved.error).toBeInstanceOf(PendingAdmittedWork);
  expect((unresolved.error as PendingAdmittedWork).phase).toBe('work-edit');
  expect(unresolved.calls.recorded).toBe(0);
});

test('a claim that leaves the admission registered cancels the partial dispatch', async () => {
  const { error, calls, g } = await run(admission({ state: 'registered' }), 'stay', async () => true);
  expect(error).toBeInstanceOf(SpecimenStale);
  expect(calls.claim).toBe(1);
  expect(calls.commit).toBe(0);
  expect(g.updates[0]!.update).toContain(`rv:admissionId ${JSON.stringify(admission().id)}`);
  expect(g.updates[0]!.update).toContain('rv:action "work.edit"');
});
