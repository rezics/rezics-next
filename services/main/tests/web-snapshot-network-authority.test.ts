import { expect, test } from 'bun:test';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import {
  AdmissionDenied,
  AdmissionExpired,
  type AdmissionRequest,
  type GraphTerminalProof,
  type RegisteredAdmission,
  type VerifiedPrincipal,
} from '../src/modules/access/admission.ts';
import { setWebSnapshot, snapshotReceiptIri } from '../src/modules/web-publication/command.ts';
import { InvalidWebSnapshot } from '../src/modules/web-publication/schema.ts';
import type { SnapshotTransport } from '../src/modules/web-publication/transport.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const native = 'https://rezics.com/id/';
const work = `${native}10000000-0000-4000-8000-000000000001`;
const publication = `${native}10000000-0000-4000-8000-000000000002`;
const actor = `${native}10000000-0000-4000-8000-000000000003`;
const snapshot = `${native}10000000-0000-4000-8000-000000000004`;
const request = new Request('https://main.test/v1/works/snapshots', {
  method: 'POST',
  headers: { authorization: 'Bearer snapshot-editor' },
});
const firstPrincipal: VerifiedPrincipal = { issuer: 'https://account.test', subject: 'editor' };
const freshPrincipal: VerifiedPrincipal = { ...firstPrincipal, emailVerified: true };
const registrationReached = new Error('Capture passed live authority and reached registration');

function fixture(
  options: {
    denyAccount?: 'before' | 'after';
    denyEdit?: 'before' | 'after';
  } = {},
) {
  const events: string[] = [];
  const verifications: { request: Request; scopes: string[] }[] = [];
  const editChecks: { principal: VerifiedPrincipal; actor: string; work: string }[] = [];
  const registrations: AdmissionRequest[] = [];
  const outbound: string[] = [];
  let publicationReads = 0,
    writes = 0,
    puts = 0,
    claims = 0,
    retainedChecks = 0;
  let captured = false;
  const deps = {
    account: {
      verify: async (verifiedRequest: Request, scopes: string[]) => {
        events.push('verify');
        verifications.push({ request: verifiedRequest, scopes });
        if (options.denyAccount === (captured ? 'after' : 'before')) {
          throw new AccountAssertionDenied('Snapshot Account assertion is inactive');
        }
        return captured ? freshPrincipal : firstPrincipal;
      },
    },
    access: {
      canEditWork: async (
        principal: VerifiedPrincipal,
        actingSubject: string,
        targetWork: string,
      ) => {
        events.push('edit');
        editChecks.push({ principal, actor: actingSubject, work: targetWork });
        return options.denyEdit !== (captured ? 'after' : 'before');
      },
      register: async (admission: AdmissionRequest) => {
        events.push('register');
        registrations.push(admission);
        throw registrationReached;
      },
      claim: async () => {
        claims++;
        throw new Error('Unexpected claim');
      },
    },
    environment: {
      lineage: { dataEpoch: '10000000-0000-4000-8000-000000000005', routingEpoch: '1' },
      fuseki: {
        query: async (query: string) => {
          if (query.includes('SELECT ?url ?head ?kind')) {
            events.push('publication');
            publicationReads++;
            return {
              results: {
                bindings: [
                  {
                    url: { value: 'https://publication.test/story' },
                    head: { value: 'urn:rezics:release:head' },
                    kind: { value: 'web' },
                  },
                ],
              },
            };
          }
          if (query.includes('ASK')) return { boolean: true };
          throw new Error('Unexpected snapshot graph query');
        },
        commandWithReceipt: async () => {
          writes++;
          throw new Error('Unexpected graph write');
        },
      },
      workObjects: {
        put: async () => {
          puts++;
          throw new Error('Unexpected object retention');
        },
      },
    },
  } as unknown as MainWorkDependencies;
  const transport: SnapshotTransport = {
    get: async (url: URL) => {
      events.push(`get:${url.pathname}`);
      outbound.push(url.href);
      if (url.pathname === '/robots.txt') {
        return { status: 404, bytes: Buffer.alloc(0), mediaType: '' };
      }
      captured = true;
      return { status: 200, bytes: Buffer.from('Captured publication'), mediaType: 'text/plain' };
    },
  };
  const fetchBody = {
    profile: 'web-snapshot-v1',
    actingSubject: actor,
    id: snapshot,
    acquisition: 'fetch',
    coverage: { scope: 'publication', complete: true },
  };
  const input = {
    work,
    publication,
    idempotencyKey: 'snapshot-authority',
    body: fetchBody,
    transport,
    rightsPermitted: async () => {
      retainedChecks++;
      return true;
    },
  };
  return {
    deps,
    input,
    events,
    verifications,
    editChecks,
    registrations,
    outbound,
    counts: () => ({ publicationReads, writes, puts, claims, retainedChecks }),
  };
}

test('snapshot Account denial prevents publication lookup, retention checks and outbound acquisition', async () => {
  const f = fixture({ denyAccount: 'before' });
  await expect(setWebSnapshot(f.deps, request, f.input)).rejects.toBeInstanceOf(
    AccountAssertionDenied,
  );
  expect(f.verifications).toEqual([{ request, scopes: ['work:edit'] }]);
  expect(f.editChecks).toEqual([]);
  expect(f.outbound).toEqual([]);
  expect(f.registrations).toEqual([]);
  expect(f.counts()).toEqual({
    publicationReads: 0,
    writes: 0,
    puts: 0,
    claims: 0,
    retainedChecks: 0,
  });
});

test('snapshot Work edit denial prevents any outbound request for the exact actor and Work', async () => {
  const f = fixture({ denyEdit: 'before' });
  await expect(setWebSnapshot(f.deps, request, f.input)).rejects.toBeInstanceOf(AdmissionDenied);
  expect(f.verifications).toEqual([{ request, scopes: ['work:edit'] }]);
  expect(f.editChecks).toEqual([{ principal: firstPrincipal, actor, work }]);
  expect(f.outbound).toEqual([]);
  expect(f.registrations).toEqual([]);
  expect(f.counts()).toEqual({
    publicationReads: 0,
    writes: 0,
    puts: 0,
    claims: 0,
    retainedChecks: 0,
  });
});

test('fixture acquisition also requires Work edit authority before retaining bytes', async () => {
  const f = fixture({ denyEdit: 'before' });
  const body = {
    profile: 'web-snapshot-v1',
    actingSubject: actor,
    id: snapshot,
    acquisition: 'fixture',
    bytesBase64: Buffer.from('Fixture publication').toString('base64'),
    mediaType: 'text/plain',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    coverage: { scope: 'publication', complete: true },
  };
  await expect(setWebSnapshot(f.deps, request, { ...f.input, body })).rejects.toBeInstanceOf(
    AdmissionDenied,
  );
  expect(f.editChecks).toEqual([{ principal: firstPrincipal, actor, work }]);
  expect(f.outbound).toEqual([]);
  expect(f.registrations).toEqual([]);
  expect(f.counts()).toEqual({
    publicationReads: 0,
    writes: 0,
    puts: 0,
    claims: 0,
    retainedChecks: 0,
  });
});

test('Account revocation during acquisition prevents registration and captured byte retention', async () => {
  const f = fixture({ denyAccount: 'after' });
  await expect(setWebSnapshot(f.deps, request, f.input)).rejects.toBeInstanceOf(
    AccountAssertionDenied,
  );
  expect(f.verifications).toEqual([
    { request, scopes: ['work:edit'] },
    { request, scopes: ['work:edit'] },
  ]);
  expect(f.editChecks).toEqual([{ principal: firstPrincipal, actor, work }]);
  expect(f.outbound).toEqual([
    'https://publication.test/robots.txt',
    'https://publication.test/story',
  ]);
  expect(f.registrations).toEqual([]);
  expect(f.counts()).toEqual({
    publicationReads: 1,
    writes: 0,
    puts: 0,
    claims: 0,
    retainedChecks: 1,
  });
});

test('Work edit revocation during acquisition prevents registration and captured byte retention', async () => {
  const f = fixture({ denyEdit: 'after' });
  await expect(setWebSnapshot(f.deps, request, f.input)).rejects.toBeInstanceOf(AdmissionDenied);
  expect(f.verifications).toEqual([
    { request, scopes: ['work:edit'] },
    { request, scopes: ['work:edit'] },
  ]);
  expect(f.editChecks).toEqual([
    { principal: firstPrincipal, actor, work },
    { principal: freshPrincipal, actor, work },
  ]);
  expect(f.outbound).toEqual([
    'https://publication.test/robots.txt',
    'https://publication.test/story',
  ]);
  expect(f.registrations).toEqual([]);
  expect(f.counts()).toEqual({
    publicationReads: 1,
    writes: 0,
    puts: 0,
    claims: 0,
    retainedChecks: 1,
  });
});

test('allowed acquisition rechecks live Account and Work authority before registration', async () => {
  const f = fixture();
  await expect(setWebSnapshot(f.deps, request, f.input)).rejects.toBe(registrationReached);
  expect(f.events).toEqual([
    'verify',
    'edit',
    'publication',
    'get:/robots.txt',
    'get:/story',
    'verify',
    'edit',
    'register',
  ]);
  expect(f.verifications).toEqual([
    { request, scopes: ['work:edit'] },
    { request, scopes: ['work:edit'] },
  ]);
  expect(f.editChecks).toEqual([
    { principal: firstPrincipal, actor, work },
    { principal: freshPrincipal, actor, work },
  ]);
  expect(f.registrations).toHaveLength(1);
  expect(f.registrations[0]).toMatchObject({
    principal: freshPrincipal,
    actingSubject: actor,
    action: 'work.edit',
    scope: `work:edit:${work}`,
    idempotencyKey: 'snapshot-authority',
  });
  expect(f.registrations[0]!.requestDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(f.counts()).toEqual({
    publicationReads: 1,
    writes: 0,
    puts: 0,
    claims: 0,
    retainedChecks: 1,
  });
});

function cancellationFixture(outcome: 'claim-denied' | 'claim-expired' | 'edit-denied') {
  const f = fixture();
  const admissionId = '10000000-0000-4000-8000-000000000006';
  const claimCalls: { id: string; digest: string; principal?: VerifiedPrincipal }[] = [];
  const terminalRecords: { id: string; proof: GraphTerminalProof }[] = [];
  const cancellations: { receipt: string; digest: string; update: string }[] = [];
  let registered: RegisteredAdmission | null = null;
  let terminal: GraphTerminalProof | null = null;
  let claimFinished = false;
  const query = f.deps.environment.fuseki.query;
  const canEditWork = f.deps.access.canEditWork;
  f.deps.access.canEditWork = async (principal, actingSubject, targetWork) => {
    const allowed = await canEditWork(principal, actingSubject, targetWork);
    return allowed && !(outcome === 'edit-denied' && claimFinished);
  };
  f.deps.access.register = async (admission) => {
    f.events.push('register');
    f.registrations.push(admission);
    registered = {
      id: admissionId,
      principalId: 'snapshot-editor',
      actingSubject: admission.actingSubject,
      scope: admission.scope,
      action: admission.action,
      idempotencyKey: admission.idempotencyKey,
      requestDigest: admission.requestDigest,
      authorityEpoch: '1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      state: 'claimed',
      dispatchEligible: true,
      replayed: true,
    };
    return registered;
  };
  f.deps.access.claim = async (id, digest, principal) => {
    claimCalls.push({ id, digest, principal });
    claimFinished = true;
    if (outcome === 'claim-denied') throw new AdmissionDenied('Claim authority was revoked');
    if (outcome === 'claim-expired') throw new AdmissionExpired('Claim authority expired');
    if (!registered) throw new Error('Claim preceded registration');
    return { ...registered, state: 'claimed', claimedAt: new Date().toISOString() };
  };
  f.deps.access.recordGraphOutcome = async (id, proof) => {
    terminalRecords.push({ id, proof });
  };
  f.deps.environment.fuseki.query = async (sparql, maxBytes) => {
    if (sparql.includes('SELECT ?outcome ?digest ?authority')) {
      if (!terminal) return { results: { bindings: [] } };
      return {
        results: {
          bindings: [
            {
              outcome: { type: 'uri', value: 'https://rezics.com/vocab/Cancelled' },
              digest: { type: 'literal', value: terminal.requestDigest },
              authority: { type: 'literal', value: terminal.authorityEpoch },
              scope: { type: 'literal', value: terminal.scope },
              epoch: { type: 'literal', value: terminal.dataEpoch },
              sequence: { type: 'literal', value: terminal.sequence },
            },
          ],
        },
      };
    }
    if (sparql.includes('rv:rejectionKind rv:InvalidProfile')) return { boolean: false };
    return query(sparql, maxBytes);
  };
  f.deps.environment.fuseki.commandWithReceipt = async (envelope) => {
    if (!registered) throw new Error('Cancellation preceded registration');
    cancellations.push(envelope);
    terminal = {
      outcome: 'cancelled',
      receipt: envelope.receipt,
      admissionId: registered.id,
      requestDigest: envelope.digest,
      authorityEpoch: registered.authorityEpoch,
      scope: registered.scope,
      dataEpoch: f.deps.environment.lineage.dataEpoch,
      sequence: '1',
    };
    return {
      status: 'committed',
      position: {
        datasetId: 'urn:rezics:dataset:product',
        dataEpoch: terminal.dataEpoch,
        sequence: '1',
      },
    };
  };
  return { ...f, admissionId, claimCalls, terminalRecords, cancellations };
}

for (const outcome of ['claim-denied', 'claim-expired', 'edit-denied'] as const) {
  test(`claimed snapshot ${outcome} seals cancellation without retaining captured bytes`, async () => {
    const f = cancellationFixture(outcome);
    await expect(setWebSnapshot(f.deps, request, f.input)).rejects.toBeInstanceOf(
      InvalidWebSnapshot,
    );
    expect(f.registrations).toHaveLength(1);
    const digest = f.registrations[0]!.requestDigest;
    expect(f.claimCalls).toEqual([{ id: f.admissionId, digest, principal: freshPrincipal }]);
    expect(f.cancellations).toHaveLength(1);
    expect(f.cancellations[0]).toMatchObject({
      receipt: snapshotReceiptIri(f.admissionId),
      digest,
    });
    expect(f.cancellations[0]!.update).toContain('rv:outcome rv:Cancelled');
    expect(f.cancellations[0]!.update).not.toContain('a rv:WebSnapshot');
    expect(f.terminalRecords).toEqual([
      {
        id: f.admissionId,
        proof: {
          outcome: 'cancelled',
          receipt: snapshotReceiptIri(f.admissionId),
          admissionId: f.admissionId,
          requestDigest: digest,
          authorityEpoch: '1',
          scope: `work:edit:${work}`,
          dataEpoch: f.deps.environment.lineage.dataEpoch,
          sequence: '1',
        },
      },
    ]);
    expect(f.editChecks).toEqual(
      outcome === 'edit-denied'
        ? [
            { principal: firstPrincipal, actor, work },
            { principal: freshPrincipal, actor, work },
            { principal: freshPrincipal, actor, work },
          ]
        : [
            { principal: firstPrincipal, actor, work },
            { principal: freshPrincipal, actor, work },
          ],
    );
    expect(f.outbound).toEqual([
      'https://publication.test/robots.txt',
      'https://publication.test/story',
    ]);
    expect(f.counts().puts).toBe(0);
  });
}
