import { expect, test } from 'bun:test';
import {
  bindLibraryDomain,
  composeLibraryDomain,
  peekLibraryDomain,
  unbindLibraryDomain,
} from '../../src/composition/library.ts';
import { createLibraryApplications } from '../../src/library/application/index.ts';
import type { LibraryCapabilities } from '../../src/library/contract/capabilities.ts';
import {
  emptyProgressOperationCatalog,
  EMPTY_COLLECTION_AUTHORIZATION_PREPARATION,
} from '../../src/library/contract/index.ts';
import type { LibraryActor } from '../../src/library/contract/actors.ts';
import { preparedSource, type CollectionSourceObservation } from '../../src/library/contract/source.ts';
import {
  CollectionWorkLedger,
  accountDimensions,
  admissionTerm,
  classifyPublicationFilter,
  classifySourceOutput,
  orderedOccurrences,
  repeatedSubjectCount,
  sumAdmission,
  workAllowance,
} from '../../src/library/core/index.ts';
import { LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS } from '../../src/library/identity-native-bounds.ts';
import { LIBRARY_IDENTITY_SELECTED_STATEMENTS } from '../../src/library/identity-native-planner-projection.ts';
import { preparePresentationSelection } from '../../src/library/collection-presentation.ts';
import { libraryActorOf } from '../../src/library/contract/index.ts';
import { admitComposedEntryProgress, libraryCommandAuthorization } from '../../src/library/command-support.ts';
import { createLibraryObservationApplication } from '../../src/semantic/library-observation.ts';

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
    semanticObservations: createLibraryObservationApplication(),
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
      specializeCollectionList() {
        return { status: 'unavailable' as const };
      },
      collectionAuthorizationPreparation() {
        return EMPTY_COLLECTION_AUTHORIZATION_PREPARATION;
      },
    },
    identityDisclosure: {
      async readRelease() {
        return { digest: 'release' };
      },
      async readOriginalTerminal() {
        return { original: `${subjectId}:original`, terminal: `${subjectId}:terminal` };
      },
      async readActiveRelease() {
        return { digest: 'release', release: { types: { work: {} } } };
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
      filterLeaves(filter) {
        return filter && typeof filter === 'object' && 'owner' in filter ? (['owner'] as const) : [];
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
      async readableCover() {
        return null;
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
    progressCatalog: emptyProgressOperationCatalog(),
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
  const base = fakeCapabilities();
  const entryDeadline = Date.now() + 1_000;
  const entryAt = { epoch: 2 };
  let authorizationInput: Parameters<typeof base.authorization.admitCollectionRead>[0] | undefined;
  let disclosureInput: Parameters<typeof base.identityDisclosure.readOriginalTerminal>[0] | undefined;
  const domain = createLibraryApplications({
    ...base,
    authorization: {
      ...base.authorization,
      async admitCollectionRead(input) {
        authorizationInput = input;
        return { authorized: true };
      },
    },
    identityDisclosure: {
      ...base.identityDisclosure,
      async readOriginalTerminal(input) {
        disclosureInput = input;
        return { original: `${subjectId}:original`, terminal: `${subjectId}:terminal` };
      },
    },
  });
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
    deadline: entryDeadline,
    subjectId,
    at: entryAt,
  });
  expect(progress).toMatchObject({
    admitted: true,
    original: `${subjectId}:original`,
    terminal: `${subjectId}:terminal`,
  });
  expect(progress.admission.complete).toBe(true);
  expect(progress.admission.terms.map((term) => term.name)).toEqual(['grant', 'identity-disclosure', 'entry-progress']);
  expect(authorizationInput).toMatchObject({ actor, deadline: entryDeadline, at: entryAt, collectionId: subjectId });
  expect(disclosureInput).toEqual({ actor, subjectId, deadline: entryDeadline, at: entryAt });

  const expired = await domain.entryProgress.admit({
    actor,
    deadline: Date.now() - 1,
    subjectId,
  });
  expect(expired.admitted).toBe(false);
  expect(expired.admission.terms[0]?.name).toBe('deadline');

  const funded = await domain.progressOperations.admit({
    actor,
    deadline: entryDeadline,
    subjectId,
    at: entryAt,
  });
  expect(funded).toMatchObject({
    admitted: true,
    original: `${subjectId}:original`,
    terminal: `${subjectId}:terminal`,
  });
  expect(funded.admission.terms.map((term) => term.name)).toEqual([
    'grant',
    'identity-disclosure',
    'progress-operation',
  ]);
  const startPlan = domain.progressOperations.planCommand(
    'start',
    {
      accountId,
      clientId: actor.clientId,
      requestedBy: null,
      kind: 'progress_session.start',
      key: 'rk1.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      input: { subjectId, versionSubjectId: null },
    },
    1,
  );
  expect(startPlan.total.engineRequests).toBe(0);
  expect(startPlan.total.statements).toBeGreaterThan(0);
  expect(domain.progressOperations.planCommand('journal', startPlan.original, 1).kind).toBe('journal');
  expect((await domain.progressOperations.admit({ actor, deadline: Date.now() - 1, subjectId })).admitted).toBe(false);
  expect(
    (await domain.progressOperations.admit({ actor: { kind: 'anonymous' }, deadline: Date.now() + 1_000, subjectId }))
      .admission.terms[0]?.name,
  ).toBe('actor');

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
  expect(libraryActorOf({ kind: 'anonymous' })).toEqual({ kind: 'anonymous' });
  expect(libraryActorOf(actor).kind).toBe('account');
  expect(domain.searchPreparation.filterLeaves({ owner: true })).toEqual(['owner']);
  expect(classifyPublicationFilter(['catalogue', 'catalogue'])).toBe('catalogue');
  expect(classifyPublicationFilter(['owner'])).toBe('owner');
  expect(classifyPublicationFilter(['catalogue', 'owner'])).toBe('unavailable');
  expect(classifyPublicationFilter([])).toBe('unavailable');
});

test('Entry/progress refuses before identity disclosure when collection authorization denies', async () => {
  const capabilities = fakeCapabilities();
  let disclosureReads = 0;
  const domain = createLibraryApplications({
    ...capabilities,
    authorization: {
      ...capabilities.authorization,
      async admitCollectionRead() {
        return { authorized: false };
      },
    },
    identityDisclosure: {
      ...capabilities.identityDisclosure,
      async readOriginalTerminal() {
        disclosureReads += 1;
        return { original: subjectId, terminal: subjectId };
      },
    },
  });

  const result = await domain.entryProgress.admit({ actor, deadline: Date.now() + 1_000, subjectId, at: { epoch: 1 } });

  expect(result).toMatchObject({ admitted: false, original: null, terminal: null });
  expect(result.admission.terms.map((term) => term.name)).toEqual(['collection-read-denied']);
  expect(disclosureReads).toBe(0);
  const previous = peekLibraryDomain();
  bindLibraryDomain(domain);
  try {
    await admitComposedEntryProgress({
      actor,
      subjectId,
      deadline: Date.now() + 1_000,
      at: { epoch: 1 },
    });
  } finally {
    unbindLibraryDomain();
    if (previous) bindLibraryDomain(previous);
  }
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
    filterLeaves() {
      return [];
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
  expect(filtered.prepared).toEqual({
    basis: 'digest',
    filter: { all: [] },
    releaseDigest: 'digest',
  });
  expect(searchingWork.receipt().used.statements).toBe(1);
});

test('Collection presentation admits kinds through composed identity and withholds cover without Content', async () => {
  const previous = peekLibraryDomain();
  const domain = bindLibraryDomain(createLibraryApplications(fakeCapabilities()));
  try {
    expect(
      await preparePresentationSelection(
        { pool: {} as never, access: {} as never },
        actor,
        { presentationKind: 'work' },
        Date.now() + 1_000,
      ),
    ).toBeNull();
    expect(
      await preparePresentationSelection(
        { pool: {} as never, access: {} as never },
        actor,
        { presentationKind: 'missing' },
        Date.now() + 1_000,
      ),
    ).toMatchObject({ code: 'invalid_request' });
    expect(
      await domain.contentPublication.readableCover({ actor, mediaId: collectionId, deadline: Date.now() + 1_000 }),
    ).toBeNull();
  } finally {
    unbindLibraryDomain();
    if (previous) bindLibraryDomain(previous);
  }
});

test('libraryActorOf keeps account fields and treats missing accounts as anonymous', () => {
  expect(libraryActorOf(actor)).toEqual(actor);
  expect(libraryActorOf({ kind: 'anonymous' })).toEqual({ kind: 'anonymous' });
  expect(libraryActorOf({ kind: 'account' })).toEqual({ kind: 'anonymous' });
});

test('contract, core and application load without Access, Search, Semantic or Content implementations', async () => {
  const contract = await import('../../src/library/contract/index.ts');
  const core = await import('../../src/library/core/index.ts');
  const application = await import('../../src/library/application/index.ts');
  expect(typeof contract.preparedSource).toBe('symbol');
  expect(core.classifySourceOutput(observation({ kind: 'activated_output', generation: 'gen' }))).toBe(
    'activated_public',
  );
  const domain = application.createLibraryApplications(fakeCapabilities());
  expect(
    domain.publicationAdmission.admit({
      locator,
      privateWorking: true,
      observation: observation({ kind: 'curated' }),
      episodePresent: true,
    }).phase,
  ).toBe('staging');
});

test('ordinary composeLibraryDomain installs native identity, authorization and publication adapters', async () => {
  const previous = peekLibraryDomain();
  unbindLibraryDomain();
  try {
    const domain = composeLibraryDomain();
    expect(peekLibraryDomain()).toBe(domain);
    const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
    const nativeFailure = new Error('native Semantic checkout reached');
    const pool = {
      connect: async () => {
        throw nativeFailure;
      },
    } as unknown as import('pg').Pool;
    const copies = domain.copyPorts!({ pool, access: {} as import('../../src/request/access.ts').Access, tokens });
    const binding = { operation: 'library.copy.list', parameters: { accountId } };
    const continuation = { epoch: 9, after: ['2026-11-01T00:00:00.000Z', subjectId] };
    const cursor = copies.encodeCursor(binding, continuation);
    expect(copies.decodeCursor(binding, cursor)).toEqual({ ok: true, ...continuation });
    expect(copies.decodeCursor({ ...binding, parameters: { accountId: publicationId } }, cursor).ok).toBe(false);
    expect(copies.decodeCursor({ ...binding, operation: 'library.collection.members' }, cursor).ok).toBe(false);
    expect(copies.decodeCursor(binding, `${cursor}x`).ok).toBe(false);
    await expect(domain.presentation!.readMappings(pool, [subjectId])).rejects.toBe(nativeFailure);
    expect(domain.identityNative.jobSizeSQL).toContain('identity_epoch_job');
    const basis = domain.identityNative.basisStatements();
    expect(basis).toHaveLength(7);
    expect(basis.every((item) => Array.isArray(item.values) && item.engineRequests === 0)).toBe(true);
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
    ).toEqual({ authorized: false, reason: 'unbound' });
    expect(
      await domain.entryProgress.admit({
        actor,
        deadline: Date.now() + 1_000,
        subjectId,
        at: { epoch: 1 },
      }),
    ).toMatchObject({ admitted: false, admission: { terms: [{ name: 'collection-read-unbound' }] } });
    await admitComposedEntryProgress({
      actor,
      subjectId,
      deadline: Date.now() + 1_000,
      at: { epoch: 1 },
    });
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
    expect(
      await domain.contentPublication.readableCover({
        actor,
        mediaId: collectionId,
        deadline: Date.now() + 1_000,
      }),
    ).toBeNull();
    expect(domain.progressCatalog.access.accountRead.sql).toContain('access.account');
    expect(domain.progressCatalog.semantic.releaseRead.sql).toContain('definition_release');
    expect(domain.progressCatalog.semantic.mappingCurrent.sql).toContain('identity_epoch_group');
    expect(domain.progressCatalog.semantic.itemTypes.sql).toContain('semantic.subject');
    const nativeStart = domain.progressOperations.planCommand(
      'start',
      {
        accountId,
        clientId: actor.clientId,
        requestedBy: null,
        kind: 'progress_session.start',
        key: 'rk1.1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        input: { subjectId, versionSubjectId: null },
      },
      1,
    );
    expect(nativeStart.total.engineRequests).toBe(0);
    expect(nativeStart.original.accountId).toBe(accountId);
    expect(domain.progressOperations.sourceWork(subjectId, true).statements).toBeGreaterThan(0);
    expect(typeof domain.searchPreparation.filterLeaves).toBe('function');
    expect(typeof domain.searchPreparation.ownerFilterHasOwnerLeaf).toBe('function');
    expect(await domain.identityDisclosure.readActiveRelease(undefined)).toBeNull();
    const disclosure = await domain.identityDisclosure.readOriginalTerminal({
      actor,
      subjectId,
      deadline: Date.now() + 1_000,
      at: { epoch: 1 },
    });
    expect(disclosure).toEqual({ original: null, terminal: null });
    for (const { sql, values } of Object.values(LIBRARY_IDENTITY_SELECTED_STATEMENTS())) {
      expect(domain.identityNative.selectedFootprint(sql, values)).toEqual(
        domain.identityNative.footprint(sql, values),
      );
    }
    expect(domain.identityNative.basisStatements()).toHaveLength(
      LIBRARY_IDENTITY_NATIVE_OPERATION_DECLARATIONS().sourceBasis.length,
    );
    unbindLibraryDomain();
    expect(peekLibraryDomain()).toBeUndefined();
  } finally {
    if (previous) bindLibraryDomain(previous);
  }
});

test('Library command authorization preserves native fallback and forwards composed command arguments', async () => {
  const previous = peekLibraryDomain();
  unbindLibraryDomain();
  const access = {
    async authenticate(): Promise<never> {
      throw new Error('Authentication is not part of command preparation');
    },
    async authorize() {
      return true;
    },
  };
  const args: Parameters<typeof libraryCommandAuthorization> = [
    access,
    actor,
    'library_entry:update',
    { route: 1, id: accountId },
    { pool: {} as never, deadline: Date.now() + 1_000 },
    () => new Error('denied'),
  ];
  try {
    const native = await libraryCommandAuthorization(...args);
    expect(native.action).toBe(args[2]);
    expect(native.resource).toEqual(args[3]);
    expect(native.denied).toBe(args[5]);
    const capabilities = fakeCapabilities();
    const calls: (readonly unknown[])[] = [];
    capabilities.authorization.commandAuthorization = async (...forwarded) => {
      calls.push(forwarded);
      return native;
    };
    bindLibraryDomain(createLibraryApplications(capabilities));
    expect(await libraryCommandAuthorization(...args)).toBe(native);
    expect(calls).toHaveLength(1);
    for (const [index, value] of args.entries()) expect(calls[0]![index]).toBe(value);
  } finally {
    unbindLibraryDomain();
    if (previous) bindLibraryDomain(previous);
  }
});
