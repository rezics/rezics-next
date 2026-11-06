import { expect, test } from 'bun:test';
import {
  composeLibraryDomain,
  peekLibraryDomain,
  unbindLibraryDomain,
} from '../../src/composition/library.ts';
import { createLibraryApplications } from '../../src/library/application/index.ts';
import type { LibraryCapabilities } from '../../src/library/contract/capabilities.ts';
import type { LibraryActor } from '../../src/library/contract/actors.ts';
import { preparedSource, type CollectionSourceObservation } from '../../src/library/contract/source.ts';
import {
  CollectionWorkLedger,
  accountDimensions,
  admissionTerm,
  classifySourceOutput,
  orderedOccurrences,
  repeatedSubjectCount,
  sumAdmission,
  workAllowance,
} from '../../src/library/core/index.ts';

const accountId = '00000000-0000-7000-8000-000000000001';
const collectionId = '00000000-0000-7000-8000-000000000002';
const subjectId = '00000000-0000-7000-8000-000000000003';
const publicationId = '00000000-0000-7000-8000-000000000004';

const actor: LibraryActor = {
  kind: 'account',
  accountId,
  clientId: '00000000-0000-7000-8000-000000000005',
  scopes: ['collection:read'],
  requestedBy: null,
  authnEpoch: 1,
};

function observation(authority: CollectionSourceObservation['authority']): CollectionSourceObservation {
  return {
    collectionId,
    route: 1,
    incarnation: 'incarnation',
    revision: 1,
    authority,
    stamp: { partition: 1, epoch: 1, position: 1n },
    basis: { digest: 'digest', identity: { digest: 'identity' }, query: null, profilePins: [], projection: null },
  };
}

function source(authority: CollectionSourceObservation['authority']) {
  return { [preparedSource]: true as const, observation: observation(authority) };
}

function receipt(reservationId: string) {
  return {
    reservationId,
    used: {
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 0,
      witnessKeys: 0,
      statements: 0,
      bytes: 0,
    },
  };
}

function fakeCapabilities(
  overrides: Partial<LibraryCapabilities> & {
    sourceAuthority?: CollectionSourceObservation['authority'];
  } = {},
): LibraryCapabilities {
  const authority = overrides.sourceAuthority ?? { kind: 'curated' as const };
  return {
    authorization: {
      async admitCollectionRead() {
        return { authorized: true };
      },
      async fenceAccount() {},
      isLifecycleDenied() {
        return false;
      },
      async commandAuthorization() {
        return {};
      },
      deadlineClient: (client) => client,
      within: (_deadline, work) => work(),
    },
    identityDisclosure: {
      async readRelease() {
        return { digest: 'release' };
      },
      async readOriginalTerminal() {
        return { original: `${subjectId}:original`, terminal: `${subjectId}:terminal` };
      },
      initiatorCommitment() {
        return 'initiator';
      },
    },
    searchPreparation: {
      async prepareScope(input) {
        return {
          prepared: { basis: input.filter, filter: input.filter },
          work: receipt(input.allowance.reservationId),
          scope: {
            async sourcePrefix() {
              return {
                candidates: [],
                observation: observation(authority),
                exhausted: true,
                coveredThrough: null,
                work: receipt(input.allowance.reservationId),
              };
            },
            async evaluate(_prepared, subjects) {
              return { values: subjects.map(() => true) };
            },
            work() {
              return receipt(input.allowance.reservationId);
            },
          },
        };
      },
      ownerFilterHasOwnerLeaf(filter) {
        return Boolean(filter && typeof filter === 'object' && 'owner' in filter);
      },
    },
    contentPublication: {
      admitActivatedOutput(input) {
        const output = classifySourceOutput(input.observation);
        if (input.privateWorking && output === 'activated_public') return { admitted: false, reason: 'unavailable' };
        if (input.privateWorking) return { admitted: output === 'private_working', reason: 'private_working' };
        if (output === 'activated_public') return { admitted: true, reason: 'activated_public' };
        return { admitted: false, reason: 'unavailable' };
      },
    },
    identityNative: {
      bound() {
        return undefined;
      },
      footprint() {
        return undefined;
      },
      selectedFootprint() {
        return undefined;
      },
      isFullPartitionSQL() {
        return false;
      },
      isSourceBasisSQL() {
        return false;
      },
      sourceBasisFootprint() {
        return undefined;
      },
      sourceBasisBound() {
        return undefined;
      },
      selectedBound() {
        return undefined;
      },
      basisStatements() {
        return [];
      },
      jobSizeSQL: '',
    },
    sourceCapture: {
      async prepare(input) {
        return { source: source(authority), work: receipt(input.allowance.reservationId) };
      },
    },
    accountAdmission: sumAdmission([admissionTerm('account', { statements: 1, nativeRows: 1 })]),
    ...overrides,
  };
}

const locator = {
  route: 1,
  ownerAccountId: accountId,
  collectionId,
  publicationId,
};

test('Library applications run with fake capabilities through Source, members, publication and Entry/progress', async () => {
  const domain = createLibraryApplications(fakeCapabilities());
  const allowance = workAllowance(8, 'reservation');
  const captured = await domain.sourceCapture.capture({
    actor,
    collectionId,
    deadline: Date.now() + 1_000,
    at: { epoch: 1 },
    allowance,
  });
  expect(captured.privateWorking).toBe(true);
  expect(captured.source[preparedSource]).toBe(true);

  const publicDomain = createLibraryApplications(
    fakeCapabilities({ sourceAuthority: { kind: 'activated_output', generation: 'gen' } }),
  );
  const activated = await publicDomain.sourceCapture.capture({
    actor,
    collectionId,
    deadline: Date.now() + 1_000,
    at: { epoch: 1 },
    allowance,
  });
  expect(activated.privateWorking).toBe(false);

  await expect(
    publicDomain.sourceCapture.capture({
      actor,
      collectionId,
      deadline: Date.now() + 1_000,
      at: { epoch: 1 },
      allowance,
      logical: true,
    }),
  ).rejects.toBeInstanceOf(TypeError);

  const occurrences = orderedOccurrences([
    { occurrenceId: 'b', subjectId, ordinal: 2 },
    { occurrenceId: 'a', subjectId, ordinal: 1 },
    { occurrenceId: 'c', subjectId: collectionId, ordinal: 3 },
  ]);
  expect(occurrences.map((row) => row.occurrenceId)).toEqual(['a', 'b', 'c']);
  expect(repeatedSubjectCount(occurrences)).toBe(2);
  const members = await domain.memberPreparation.prepare({
    actor,
    collectionId,
    deadline: Date.now() + 1_000,
    occurrences,
  });
  expect(members.page.occurrences).toEqual(occurrences);
  expect(members.admission.complete).toBe(true);
  expect(members.admission.terms.map((term) => term.name)).toEqual([
    'source-prepare',
    'canonical-members',
    'repeated-occurrences',
  ]);
  expect(accountDimensions(members.admission).candidateKeys).toBe(5);

  await expect(
    domain.memberPreparation.prepare({
      actor,
      collectionId,
      deadline: Date.now() + 1_000,
      occurrences,
      filter: { owner: true },
    }),
  ).rejects.toBeInstanceOf(TypeError);

  const fenced = await domain.memberPreparation.prepare({
    actor,
    collectionId,
    deadline: Date.now() + 1_000,
    occurrences,
    filter: { owner: true },
    ownerFence: accountId,
  });
  expect(fenced.ownerFence).toBe(accountId);
  expect(fenced.admission.terms.some((term) => term.name === 'owner-fence')).toBe(true);

  const staging = domain.publicationAdmission.admit({
    locator,
    privateWorking: true,
    observation: observation({ kind: 'curated' }),
    episodePresent: true,
  });
  expect(staging).toMatchObject({ admitted: true, phase: 'staging', privateWorking: true, activatedPublic: false });

  const publicOut = publicDomain.publicationAdmission.admit({
    locator,
    privateWorking: false,
    observation: observation({ kind: 'activated_output', generation: 'gen' }),
    episodePresent: true,
  });
  expect(publicOut).toMatchObject({
    admitted: true,
    phase: 'awaiting_activation',
    privateWorking: false,
    activatedPublic: true,
  });

  const mixed = domain.publicationAdmission.admit({
    locator,
    privateWorking: true,
    observation: observation({ kind: 'activated_output', generation: 'gen' }),
    episodePresent: true,
  });
  expect(mixed).toMatchObject({ admitted: false, phase: 'unavailable' });

  expect(
    domain.publicationAdmission.admit({
      locator: null,
      privateWorking: true,
      observation: observation({ kind: 'curated' }),
      episodePresent: true,
    }).admitted,
  ).toBe(false);

  const progress = await domain.entryProgress.admit({
    actor,
    deadline: Date.now() + 1_000,
    subjectId,
    at: { epoch: 1 },
  });
  expect(progress).toMatchObject({
    admitted: true,
    original: `${subjectId}:original`,
    terminal: `${subjectId}:terminal`,
  });
  expect(progress.admission.complete).toBe(true);
  expect(progress.admission.terms.map((term) => term.name)).toEqual(['grant', 'identity-disclosure', 'entry-progress']);

  const expired = await domain.entryProgress.admit({
    actor,
    deadline: Date.now() - 1,
    subjectId,
  });
  expect(expired.admitted).toBe(false);
  expect(expired.admission.terms[0]?.name).toBe('deadline');

  const anonymous = await domain.entryProgress.admit({
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 1_000,
    subjectId,
  });
  expect(anonymous.admitted).toBe(false);
  expect(anonymous.admission.terms[0]?.name).toBe('actor');

  const work = new CollectionWorkLedger(workAllowance(8, 'owner-query'));
  const opened = await domain.ownerQuery.open({
    actor,
    collectionId,
    deadline: Date.now() + 1_000,
    work,
    at: { epoch: 1 },
  });
  expect(opened.source[preparedSource]).toBe(true);
  expect(await opened.originals(subjectId)).toEqual([subjectId]);
});

test('owner-query filter uses the Search preparation capability and records nested admission on the ledger', async () => {
  const searchPreparation: LibraryCapabilities['searchPreparation'] = {
    async prepareScope(input) {
      return {
        prepared: { basis: input.releaseDigest, filter: input.filter, releaseDigest: input.releaseDigest },
        work: {
          reservationId: input.allowance.reservationId,
          used: {
            candidateKeys: 2,
            nativeRows: 4,
            identityMetadataRows: 0,
            emptySeeks: 1,
            nativePoints: 2,
            witnessKeys: 0,
            statements: 1,
            bytes: 128,
          },
        },
        scope: {
          async sourcePrefix() {
            return {
              candidates: [],
              observation: observation({ kind: 'curated' }),
              exhausted: true,
              coveredThrough: null,
              work: receipt(input.allowance.reservationId),
            };
          },
          async evaluate(_prepared, subjects) {
            return { values: subjects.map(() => true) };
          },
          work() {
            return receipt(input.allowance.reservationId);
          },
        },
      };
    },
    ownerFilterHasOwnerLeaf() {
      return false;
    },
  };
  const domain = createLibraryApplications(fakeCapabilities({ searchPreparation }));
  const work = new CollectionWorkLedger(workAllowance(8, 'filter-query'));
  const opened = await domain.ownerQuery.open({
    actor,
    collectionId,
    deadline: Date.now() + 1_000,
    work,
    at: { epoch: 1 },
  });
  await expect(opened.filter({ all: [] }, 'digest')).rejects.toBeInstanceOf(TypeError);

  const searching = createLibraryApplications({
    ...fakeCapabilities({ searchPreparation }),
    search: {},
    routeKey: new Uint8Array(32),
  });
  const searchingWork = new CollectionWorkLedger(workAllowance(8, 'filter-query-2'));
  const searchingOpen = await searching.ownerQuery.open({
    actor,
    collectionId,
    deadline: Date.now() + 1_000,
    work: searchingWork,
    at: { epoch: 1 },
  });
  const filtered = await searchingOpen.filter({ all: [] }, 'digest');
  expect(filtered.prepared).toEqual({ filter: { all: [] }, releaseDigest: 'digest' });
  expect(searchingWork.receipt().used.statements).toBe(1);
});

test('ordinary composeLibraryDomain installs native identity, authorization and publication adapters', async () => {
  unbindLibraryDomain();
  const domain = composeLibraryDomain();
  expect(peekLibraryDomain()).toBe(domain);
  expect(domain.identityNative.jobSizeSQL).toContain('identity_epoch_job');
  expect(domain.identityNative.basisStatements().length).toBeGreaterThan(0);
  expect(
    await domain.authorization.admitCollectionRead({
      actor,
      at: { epoch: 1 },
      deadline: Date.now() + 1_000,
      route: 1,
      collectionId,
      curatorAccountId: accountId,
      visibility: 'private',
      membershipKind: 'curated',
      privateOwner: true,
    }),
  ).toEqual({ authorized: true });
  expect(
    domain.contentPublication.admitActivatedOutput({
      observation: observation({ kind: 'curated' }),
      privateWorking: true,
    }),
  ).toEqual({ admitted: true, reason: 'private_working' });
  expect(
    domain.contentPublication.admitActivatedOutput({
      observation: observation({ kind: 'activated_output', generation: 'gen' }),
      privateWorking: true,
    }),
  ).toEqual({ admitted: false, reason: 'unavailable' });
  const disclosure = await domain.identityDisclosure.readOriginalTerminal({
    actor,
    subjectId,
    deadline: Date.now() + 1_000,
    at: { epoch: 1 },
  });
  expect(disclosure).toEqual({ original: subjectId, terminal: subjectId });
  unbindLibraryDomain();
  expect(peekLibraryDomain()).toBeUndefined();
});
