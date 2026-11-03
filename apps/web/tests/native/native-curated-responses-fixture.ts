import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  startNativeCuratedCollectionsFixture,
  type NativeCuratedCollectionsFixture,
  type NativeCuratedPersona,
} from './native-curated-collections-fixture.ts';

export const nativeCuratedResponseScenarioNames = [
  'collectionCreate',
  'memberFirstCreate',
  'memberDuplicateCreate',
  'memberOtherCreate',
  'collectionOwnerReadAfterCreate',
  'ownerMembersInitialPage1',
  'ownerMembersInitialPage2',
  'collectionMetadataEdit',
  'collectionMetadataEditReplay',
  'staleCollectionMetadataEdit',
  'staleCollectionMetadataEditReplay',
  'collectionAfterCas',
  'memberNoteEdit',
  'memberNoteEditReplay',
  'ownerMembersAfterEditPage1',
  'ownerMembersAfterEditPage2',
  'memberMove',
  'memberMoveReplay',
  'ownerMembersAfterMovePage1',
  'ownerMembersAfterMovePage2',
  'visibilityUnlisted',
  'privateOwnerCollection',
  'privateOtherCollection',
  'privateAnonymousCollection',
  'privateOwnerMembers',
  'privateOtherMembers',
  'privateAnonymousMembers',
  'visibilityPublic',
  'hiddenSubjectDisclosure',
  'unlistedOwnerCollection',
  'unlistedOtherCollection',
  'unlistedAnonymousCollection',
  'unlistedOwnerMembers',
  'unlistedOtherMembers',
  'unlistedAnonymousMembers',
  'publicOwnerCollection',
  'publicOtherCollection',
  'publicAnonymousCollection',
  'publicOwnerMembers',
  'publicOtherMembers',
  'publicAnonymousMembers',
  'visibilityPrivateAgain',
  'privateFinalOwnerCollection',
  'privateFinalOwnerMembers',
  'memberRemove',
  'memberRemoveReplay',
  'memberUndo',
  'ownerMembersAfterUndoPage1',
  'ownerMembersAfterUndoPage2',
  'dynamicCollectionCreate',
  'dynamicMembersRead',
  'selectedPublicationUnavailable',
] as const;

export type NativeCuratedResponseScenario = (typeof nativeCuratedResponseScenarioNames)[number];
export type NativeCuratedResponsePersona = NativeCuratedPersona | 'editor' | 'steward';
export type NativeCuratedVisibility = 'private' | 'unlisted' | 'public';
export type NativeCuratedAccessRole = 'owner' | 'other' | 'anonymous';

export const nativeCuratedAccessExports = {
  private: {
    owner: { collection: 'privateOwnerCollection', members: 'privateOwnerMembers' },
    other: { collection: 'privateOtherCollection', members: 'privateOtherMembers' },
    anonymous: { collection: 'privateAnonymousCollection', members: 'privateAnonymousMembers' },
  },
  unlisted: {
    owner: { collection: 'unlistedOwnerCollection', members: 'unlistedOwnerMembers' },
    other: { collection: 'unlistedOtherCollection', members: 'unlistedOtherMembers' },
    anonymous: { collection: 'unlistedAnonymousCollection', members: 'unlistedAnonymousMembers' },
  },
  public: {
    owner: { collection: 'publicOwnerCollection', members: 'publicOwnerMembers' },
    other: { collection: 'publicOtherCollection', members: 'publicOtherMembers' },
    anonymous: { collection: 'publicAnonymousCollection', members: 'publicAnonymousMembers' },
  },
} as const satisfies Record<
  NativeCuratedVisibility,
  Record<
    NativeCuratedAccessRole,
    {
      collection: NativeCuratedResponseScenario;
      members: NativeCuratedResponseScenario;
    }
  >
>;

export type NativeCuratedCommand = Readonly<{
  kind: 'http';
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  persona: NativeCuratedResponsePersona;
  inputBodyText?: string;
  observedRevision?: number;
  retainedCommandKey?: string;
}>;

export type NativeCuratedResponseFact = Readonly<{
  method: NativeCuratedCommand['method'];
  path: string;
  persona: NativeCuratedResponsePersona;
  status: number;
  body: unknown;
  bodyText: string;
  headers: Readonly<Record<string, string>>;
}>;

export type NativeCuratedResponseOutcome =
  | Readonly<{
      availability: 'produced';
      command: NativeCuratedCommand;
      response: NativeCuratedResponseFact;
    }>
  | Readonly<{
      availability: 'unavailable';
      binding: 'dependency_unavailable' | 'native_preparing';
      command: NativeCuratedCommand;
      response: NativeCuratedResponseFact;
    }>;

export type NativeCuratedResponseManifest = Readonly<{
  identity: Readonly<{
    source: Readonly<{ repository: 'rezics'; revision: string; clean: boolean }>;
    build: Readonly<{ id: string; runtime: 'Bun'; runtimeVersion: string }> | null;
  }>;
  personas: Readonly<{ ownerAccountId: string; otherAccountId: string }>;
  ids: Readonly<{
    collectionId: string;
    dynamicCollectionId: string;
    firstSubjectId: string;
    otherSubjectId: string;
    firstOccurrenceId: string;
    duplicateOccurrenceId: string;
    otherOccurrenceId: string;
  }>;
  sequence: readonly NativeCuratedSequenceStep[];
  outcomes: Readonly<Record<NativeCuratedResponseScenario, NativeCuratedResponseOutcome>>;
  routeMap: readonly NativeCuratedRouteMapEntry[];
  observations: Readonly<{
    initialOrder: readonly string[];
    orderAfterMove: readonly string[];
    orderAfterUndo: readonly string[];
    initialPageCursor: string;
    afterEditPageCursor: string;
    afterMovePageCursor: string;
    removedOccurrence: Readonly<{ id: string; deletionId: string; deletionRevision: number }>;
  }>;
}>;

export type NativeCuratedSequenceStep =
  | Readonly<{ kind: 'fixture'; name: 'startNativeCuratedCollectionsFixture' }>
  | Readonly<{
      kind: 'fixture-helper';
      name: 'createSubject';
      input: Readonly<{ label: string }>;
      result: Readonly<{ subjectId: string }>;
    }>
  | Readonly<{ kind: 'response'; name: NativeCuratedResponseScenario }>;

export type NativeCuratedRouteMapEntry = Readonly<{
  exportName: NativeCuratedResponseScenario;
  state: string;
  method: NativeCuratedCommand['method'];
  path: string;
  persona: NativeCuratedResponsePersona;
  availability: NativeCuratedResponseOutcome['availability'];
}>;

export type NativeCuratedResponsesFixture = Readonly<{
  manifest: NativeCuratedResponseManifest;
  close(): Promise<void>;
}>;

export const nativeCuratedResponseHeaderAllowlist = [
  'cache-control',
  'content-type',
  'retry-after',
  'vary',
  'www-authenticate',
  'library-collection-member-deletion-id',
  'library-collection-member-deletion-revision',
] as const;

const collectionPath = (id: string) => `/v1/collections/${encodeURIComponent(id)}`;
const memberPath = (collectionId: string, memberId: string) =>
  `${collectionPath(collectionId)}/members/${encodeURIComponent(memberId)}`;
const newCommandKey = () => JSON.stringify(randomUUID());

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} was not a JSON object`);
  return value as Record<string, unknown>;
}

function nestedObject(value: unknown, name: string, label: string): Record<string, unknown> {
  return object(object(value, label)[name], `${label}.${name}`);
}

function stringField(value: unknown, name: string, label: string): string {
  const field = object(value, label)[name];
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${label}.${name} was not a non-empty string`);
  return field;
}

function numberField(value: unknown, name: string, label: string): number {
  const field = object(value, label)[name];
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) throw new Error(`${label}.${name} was not an integer`);
  return field;
}

function revisionOf(outcome: NativeCuratedResponseOutcome, label: string): number {
  return numberField(nestedObject(outcome.response.body, 'collection', label), 'revision', label);
}

function listOfMembers(outcome: NativeCuratedResponseOutcome, label: string): Record<string, unknown>[] {
  const rows = object(outcome.response.body, label).members;
  if (!Array.isArray(rows)) throw new Error(`${label}.members was not an array`);
  return rows.map((row, index) => object(row, `${label}.members[${index}]`));
}

function nextCursor(outcome: NativeCuratedResponseOutcome, label: string): string {
  const next = object(outcome.response.body, label).next;
  if (typeof next !== 'string' || next.length === 0) throw new Error(`${label}.next did not contain a real cursor`);
  return next;
}

function parseResponseBody(bodyText: string): unknown {
  if (bodyText.length === 0) return null;
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

async function captureIdentity() {
  const root = resolve(import.meta.dir, '../../../..');
  const revisionResult = Bun.spawnSync({ cmd: ['git', 'rev-parse', 'HEAD'], cwd: root });
  if (revisionResult.exitCode !== 0)
    throw new Error(`Unable to read native curated fixture source revision: ${revisionResult.stderr.toString()}`);
  const revision = revisionResult.stdout.toString().trim();
  if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error(`Invalid native curated fixture source revision: ${revision}`);
  const statusResult = Bun.spawnSync({ cmd: ['git', 'status', '--porcelain=v1', '--untracked-files=all'], cwd: root });
  if (statusResult.exitCode !== 0)
    throw new Error(`Unable to read native curated fixture source status: ${statusResult.stderr.toString()}`);
  const clean = statusResult.stdout.toString().trim().length === 0;
  return {
    source: { repository: 'rezics' as const, revision, clean },
    build: clean
      ? { id: `native-production-web-worker:${revision}`, runtime: 'Bun' as const, runtimeVersion: Bun.version }
      : null,
  };
}

function unavailableBinding(
  response: NativeCuratedResponseFact,
): 'dependency_unavailable' | 'native_preparing' | undefined {
  if (
    response.status === 503 &&
    response.body !== null &&
    typeof response.body === 'object' &&
    'code' in response.body
  ) {
    if ((response.body as { code?: unknown }).code === 'dependency_unavailable') return 'dependency_unavailable';
  }
  if (
    response.status === 202 &&
    response.body !== null &&
    typeof response.body === 'object' &&
    'preparing' in response.body
  ) {
    if ((response.body as { preparing?: unknown }).preparing === true) return 'native_preparing';
  }
  return undefined;
}

export async function startNativeCuratedResponsesFixture(): Promise<NativeCuratedResponsesFixture> {
  const identity = await captureIdentity();
  const fixture = await startNativeCuratedCollectionsFixture();
  try {
    const owner = await fixture.stack.authPersona('alice');
    const other = await fixture.stack.authPersona('bob');
    const sequence: NativeCuratedSequenceStep[] = [{ kind: 'fixture', name: 'startNativeCuratedCollectionsFixture' }];
    const outcomes = {} as Record<NativeCuratedResponseScenario, NativeCuratedResponseOutcome>;
    const routeMap: NativeCuratedRouteMapEntry[] = [];

    async function capture(
      name: NativeCuratedResponseScenario,
      state: string,
      method: NativeCuratedCommand['method'],
      path: string,
      persona: NativeCuratedResponsePersona,
      inputBody?: unknown,
      retainedCommandKey?: string,
      observedRevision?: number,
    ): Promise<NativeCuratedResponseOutcome> {
      const inputBodyText = inputBody === undefined ? undefined : jsonText(inputBody);
      const command: NativeCuratedCommand = {
        kind: 'http',
        method,
        path,
        persona,
        ...(inputBodyText === undefined ? {} : { inputBodyText }),
        ...(observedRevision === undefined ? {} : { observedRevision }),
        ...(retainedCommandKey === undefined ? {} : { retainedCommandKey }),
      };
      const headers: Record<string, string> = {};
      if (inputBodyText !== undefined) headers['content-type'] = 'application/json';
      if (retainedCommandKey !== undefined) headers['idempotency-key'] = retainedCommandKey;
      const raw = await fixture.stack.kernel(
        path,
        {
          method,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(inputBodyText === undefined ? {} : { body: inputBodyText }),
        },
        persona,
      );
      const bodyText = await raw.text();
      const responseHeaders: Record<string, string> = {};
      for (const header of nativeCuratedResponseHeaderAllowlist) {
        const value = raw.headers.get(header);
        if (value !== null) responseHeaders[header] = value;
      }
      const response: NativeCuratedResponseFact = {
        method,
        path,
        persona,
        status: raw.status,
        body: parseResponseBody(bodyText),
        bodyText,
        headers: responseHeaders,
      };
      const binding = unavailableBinding(response);
      const outcome: NativeCuratedResponseOutcome = binding
        ? { availability: 'unavailable', binding, command, response }
        : { availability: 'produced', command, response };
      outcomes[name] = outcome;
      routeMap.push({
        exportName: name,
        state,
        method,
        path,
        persona,
        availability: outcome.availability,
      });
      sequence.push({ kind: 'response', name });
      return outcome;
    }

    async function readMembers(
      name: NativeCuratedResponseScenario,
      state: string,
      collectionId: string,
      persona: NativeCuratedPersona,
      limit: number,
      cursor?: string,
    ): Promise<NativeCuratedResponseOutcome> {
      const query = new URLSearchParams({ limit: String(limit), view: 'FULL' });
      if (cursor !== undefined) query.set('cursor', cursor);
      return capture(name, state, 'GET', `${collectionPath(collectionId)}/members?${query.toString()}`, persona);
    }

    async function readCollection(
      name: NativeCuratedResponseScenario,
      visibility: NativeCuratedVisibility,
      collectionId: string,
      persona: NativeCuratedPersona,
    ): Promise<NativeCuratedResponseOutcome> {
      return capture(name, visibility, 'GET', collectionPath(collectionId), persona);
    }

    async function updateVisibility(
      name: 'visibilityUnlisted' | 'visibilityPublic' | 'visibilityPrivateAgain',
      visibility: NativeCuratedVisibility,
      collectionId: string,
      prior: NativeCuratedResponseOutcome,
    ): Promise<NativeCuratedResponseOutcome> {
      const observedRevision = revisionOf(prior, `${name} current Collection`);
      return capture(
        name,
        `visibility-${visibility}`,
        'PATCH',
        collectionPath(collectionId),
        'alice',
        { revision: observedRevision, visibility },
        newCommandKey(),
        observedRevision,
      );
    }

    const firstLabel = `Response fixture first ${randomUUID().slice(0, 8)}`;
    const otherLabel = `Response fixture other ${randomUUID().slice(0, 8)}`;
    const firstSubject = await fixture.createSubject(firstLabel);
    sequence.push({
      kind: 'fixture-helper',
      name: 'createSubject',
      input: { label: firstLabel },
      result: { subjectId: firstSubject.id },
    });
    const otherSubject = await fixture.createSubject(otherLabel);
    sequence.push({
      kind: 'fixture-helper',
      name: 'createSubject',
      input: { label: otherLabel },
      result: { subjectId: otherSubject.id },
    });

    const collectionTitle = `Native response shelf ${randomUUID().slice(0, 8)}`;
    const createKey = newCommandKey();
    const created = await capture(
      'collectionCreate',
      'private-created',
      'POST',
      '/v1/collections',
      'alice',
      { title: collectionTitle, visibility: 'private' },
      createKey,
    );
    if (created.response.status !== 201)
      throw new Error(`Private curated Collection create failed: ${created.response.bodyText}`);
    const collectionId = stringField(
      nestedObject(created.response.body, 'collection', 'Collection create'),
      'id',
      'Collection create',
    );

    async function addMember(
      name: 'memberFirstCreate' | 'memberDuplicateCreate' | 'memberOtherCreate',
      subjectId: string,
      note: string,
    ): Promise<NativeCuratedResponseOutcome> {
      return capture(
        name,
        'private-curated',
        'POST',
        `${collectionPath(collectionId)}/members`,
        'alice',
        { subjectId, note },
        newCommandKey(),
      );
    }

    const firstAdded = await addMember('memberFirstCreate', firstSubject.id, 'First occurrence note');
    const duplicateAdded = await addMember('memberDuplicateCreate', firstSubject.id, 'Duplicate occurrence note');
    const otherAdded = await addMember('memberOtherCreate', otherSubject.id, 'Other member note');
    for (const [name, outcome] of [
      ['first occurrence', firstAdded],
      ['duplicate occurrence', duplicateAdded],
      ['other occurrence', otherAdded],
    ] as const) {
      if (outcome.response.status !== 201) throw new Error(`Adding ${name} failed: ${outcome.response.bodyText}`);
    }
    const firstOccurrenceId = stringField(
      nestedObject(firstAdded.response.body, 'member', 'First member create'),
      'id',
      'First member create',
    );
    const duplicateOccurrenceId = stringField(
      nestedObject(duplicateAdded.response.body, 'member', 'Duplicate member create'),
      'id',
      'Duplicate member create',
    );
    const otherOccurrenceId = stringField(
      nestedObject(otherAdded.response.body, 'member', 'Other member create'),
      'id',
      'Other member create',
    );

    const collectionOwnerReadAfterCreate = await capture(
      'collectionOwnerReadAfterCreate',
      'private-curated',
      'GET',
      collectionPath(collectionId),
      'alice',
    );
    const initialPage1 = await readMembers('ownerMembersInitialPage1', 'private-curated', collectionId, 'alice', 2);
    const initialPage2 = await readMembers(
      'ownerMembersInitialPage2',
      'private-curated',
      collectionId,
      'alice',
      2,
      nextCursor(initialPage1, 'Initial owner member page'),
    );
    const initialRows = [
      ...listOfMembers(initialPage1, 'Initial owner page 1'),
      ...listOfMembers(initialPage2, 'Initial owner page 2'),
    ];
    const initialOrder = initialRows.map((row) => stringField(row, 'id', 'Initial member row'));
    const occurrenceToEdit = initialRows.find(
      (row) => row.subjectId === firstSubject.id && row.id === duplicateOccurrenceId,
    );
    if (!occurrenceToEdit) throw new Error('Duplicate occurrence was absent from the actual first owner member pages');
    const originalAddedAt = stringField(occurrenceToEdit, 'addedAt', 'Duplicate occurrence');

    const currentRevision = revisionOf(collectionOwnerReadAfterCreate, 'Initial private Collection read');
    const editKey = newCommandKey();
    const editBody = { revision: currentRevision, title: `${collectionTitle} edited` };
    const collectionMetadataEdit = await capture(
      'collectionMetadataEdit',
      'private-curated',
      'PATCH',
      collectionPath(collectionId),
      'alice',
      editBody,
      editKey,
      currentRevision,
    );
    const collectionMetadataEditReplay = await capture(
      'collectionMetadataEditReplay',
      'private-curated',
      'PATCH',
      collectionPath(collectionId),
      'alice',
      editBody,
      editKey,
      currentRevision,
    );
    const staleKey = newCommandKey();
    const staleBody = { revision: currentRevision, title: `${collectionTitle} stale` };
    const staleCollectionMetadataEdit = await capture(
      'staleCollectionMetadataEdit',
      'private-curated-stale-cas',
      'PATCH',
      collectionPath(collectionId),
      'alice',
      staleBody,
      staleKey,
      currentRevision,
    );
    const staleCollectionMetadataEditReplay = await capture(
      'staleCollectionMetadataEditReplay',
      'private-curated-stale-cas',
      'PATCH',
      collectionPath(collectionId),
      'alice',
      staleBody,
      staleKey,
      currentRevision,
    );
    const collectionAfterCas = await capture(
      'collectionAfterCas',
      'private-curated',
      'GET',
      collectionPath(collectionId),
      'alice',
    );

    const noteKey = newCommandKey();
    const noteBody = { note: 'Edited duplicate occurrence note' };
    const memberNoteEdit = await capture(
      'memberNoteEdit',
      'private-curated-occurrence-edit',
      'PATCH',
      memberPath(collectionId, duplicateOccurrenceId),
      'alice',
      noteBody,
      noteKey,
    );
    const memberNoteEditReplay = await capture(
      'memberNoteEditReplay',
      'private-curated-occurrence-edit',
      'PATCH',
      memberPath(collectionId, duplicateOccurrenceId),
      'alice',
      noteBody,
      noteKey,
    );
    const afterEditFirst = await readMembers('ownerMembersAfterEditPage1', 'private-curated', collectionId, 'alice', 2);
    const afterEditCursor = nextCursor(afterEditFirst, 'Owner page after note edit');
    const afterEditSecond = await readMembers(
      'ownerMembersAfterEditPage2',
      'private-curated',
      collectionId,
      'alice',
      2,
      afterEditCursor,
    );

    const moveKey = newCommandKey();
    const memberMove = await capture(
      'memberMove',
      'private-curated-occurrence-move',
      'POST',
      `${memberPath(collectionId, duplicateOccurrenceId)}:move`,
      'alice',
      { after: null },
      moveKey,
    );
    const memberMoveReplay = await capture(
      'memberMoveReplay',
      'private-curated-occurrence-move',
      'POST',
      `${memberPath(collectionId, duplicateOccurrenceId)}:move`,
      'alice',
      { after: null },
      moveKey,
    );
    const afterMoveFirst = await readMembers('ownerMembersAfterMovePage1', 'private-curated', collectionId, 'alice', 2);
    const afterMoveCursor = nextCursor(afterMoveFirst, 'Owner page after occurrence move');
    const afterMoveSecond = await readMembers(
      'ownerMembersAfterMovePage2',
      'private-curated',
      collectionId,
      'alice',
      2,
      afterMoveCursor,
    );
    const orderAfterMove = [
      ...listOfMembers(afterMoveFirst, 'Owner page after move 1'),
      ...listOfMembers(afterMoveSecond, 'Owner page after move 2'),
    ].map((row) => stringField(row, 'id', 'Member after move'));

    await captureVisibilityReads('private', collectionId);

    const visibilityUnlisted = await updateVisibility(
      'visibilityUnlisted',
      'unlisted',
      collectionId,
      outcomes.privateOwnerCollection!,
    );
    if (visibilityUnlisted.response.status !== 200)
      throw new Error(`Unlisted visibility update failed: ${visibilityUnlisted.response.bodyText}`);
    await captureVisibilityReads('unlisted', collectionId);

    const visibilityPublic = await updateVisibility(
      'visibilityPublic',
      'public',
      collectionId,
      outcomes.unlistedOwnerCollection!,
    );
    if (visibilityPublic.response.status !== 200)
      throw new Error(`Public visibility update failed: ${visibilityPublic.response.bodyText}`);
    const hiddenSubjectDisclosure = await capture(
      'hiddenSubjectDisclosure',
      'current-subject-hidden',
      'POST',
      `/v1/subjects/${encodeURIComponent(otherSubject.id)}:hide`,
      'steward',
      { reason: 'Native Collection response disclosure fixture' },
      newCommandKey(),
    );
    await captureVisibilityReads('public', collectionId);

    const visibilityPrivateAgain = await updateVisibility(
      'visibilityPrivateAgain',
      'private',
      collectionId,
      outcomes.publicOwnerCollection!,
    );
    if (visibilityPrivateAgain.response.status !== 200)
      throw new Error(`Private visibility update failed: ${visibilityPrivateAgain.response.bodyText}`);
    await capture(
      'privateFinalOwnerCollection',
      'private-after-visibility-cycle',
      'GET',
      collectionPath(collectionId),
      'alice',
    );
    await readMembers('privateFinalOwnerMembers', 'private-after-visibility-cycle', collectionId, 'alice', 20);

    const preRemovalRows = listOfMembers(
      outcomes.privateFinalOwnerMembers!,
      'Private owner member read before removal',
    );
    const memberToRemove = preRemovalRows.find((row) => row.id === duplicateOccurrenceId);
    if (!memberToRemove) throw new Error('The selected duplicate occurrence was absent before ordinary removal');
    const preRemovalCollection = outcomes.privateFinalOwnerCollection!;
    const removalRevision = revisionOf(preRemovalCollection, 'Private owner Collection before removal');
    const deletionKey = newCommandKey();
    const deletionPath = `${memberPath(collectionId, duplicateOccurrenceId)}?revision=${removalRevision}`;
    const memberRemove = await capture(
      'memberRemove',
      'private-curated-occurrence-removal',
      'DELETE',
      deletionPath,
      'alice',
      undefined,
      deletionKey,
      removalRevision,
    );
    const memberRemoveReplay = await capture(
      'memberRemoveReplay',
      'private-curated-occurrence-removal-replay',
      'DELETE',
      deletionPath,
      'alice',
      undefined,
      deletionKey,
      removalRevision,
    );
    const removedResponseHeaders = memberRemove.response.headers;
    const deletionId = removedResponseHeaders['library-collection-member-deletion-id'];
    const deletionRevisionText = removedResponseHeaders['library-collection-member-deletion-revision'];
    if (!deletionId || !deletionRevisionText)
      throw new Error('Native occurrence removal omitted its deletion receipt headers');
    const deletionRevision = Number(deletionRevisionText);
    if (!Number.isSafeInteger(deletionRevision))
      throw new Error('Native occurrence deletion revision was not an integer');
    const memberUndo = await capture(
      'memberUndo',
      'private-curated-occurrence-exact-undo',
      'POST',
      `${memberPath(collectionId, duplicateOccurrenceId)}:restore`,
      'alice',
      { deletionId, revision: deletionRevision },
      newCommandKey(),
      deletionRevision,
    );
    const afterUndoFirst = await readMembers('ownerMembersAfterUndoPage1', 'private-curated', collectionId, 'alice', 2);
    const afterUndoCursor = nextCursor(afterUndoFirst, 'Owner page after exact Undo');
    const afterUndoSecond = await readMembers(
      'ownerMembersAfterUndoPage2',
      'private-curated',
      collectionId,
      'alice',
      2,
      afterUndoCursor,
    );
    const orderAfterUndo = [
      ...listOfMembers(afterUndoFirst, 'Owner page after Undo 1'),
      ...listOfMembers(afterUndoSecond, 'Owner page after Undo 2'),
    ].map((row) => stringField(row, 'id', 'Member after Undo'));

    const dynamicTitle = `Native response publication boundary ${randomUUID().slice(0, 8)}`;
    const dynamicCreated = await capture(
      'dynamicCollectionCreate',
      'private-saved-dynamic',
      'POST',
      '/v1/collections',
      'alice',
      {
        title: dynamicTitle,
        visibility: 'private',
        membershipKind: 'dynamic',
        rule: { filter: { owner: { presence: true } } },
      },
      newCommandKey(),
    );
    if (dynamicCreated.response.status !== 201)
      throw new Error(`Private saved Collection setup failed: ${dynamicCreated.response.bodyText}`);
    const dynamicCollectionId = stringField(
      nestedObject(dynamicCreated.response.body, 'collection', 'Dynamic Collection create'),
      'id',
      'Dynamic Collection create',
    );
    const dynamicMembersRead = await readMembers(
      'dynamicMembersRead',
      'private-saved-dynamic-native-read',
      dynamicCollectionId,
      'alice',
      20,
    );
    const dynamicRevision = revisionOf(dynamicCreated, 'Private saved Collection create');
    const selectedPublicationUnavailable = await capture(
      'selectedPublicationUnavailable',
      'selected-publication-provider',
      'POST',
      `${collectionPath(dynamicCollectionId)}:publishSelected`,
      'alice',
      { revision: dynamicRevision, subjectIds: [firstSubject.id] },
      newCommandKey(),
      dynamicRevision,
    );

    const required = [...nativeCuratedResponseScenarioNames];
    const missing = required.filter((name) => !outcomes[name]);
    if (missing.length) throw new Error(`Native curated response manifest omitted: ${missing.join(', ')}`);

    const manifest: NativeCuratedResponseManifest = {
      identity,
      personas: { ownerAccountId: owner.accountId, otherAccountId: other.accountId },
      ids: {
        collectionId,
        dynamicCollectionId,
        firstSubjectId: firstSubject.id,
        otherSubjectId: otherSubject.id,
        firstOccurrenceId,
        duplicateOccurrenceId,
        otherOccurrenceId,
      },
      sequence,
      outcomes,
      routeMap,
      observations: {
        initialOrder,
        orderAfterMove,
        orderAfterUndo,
        initialPageCursor: nextCursor(initialPage1, 'Initial owner page'),
        afterEditPageCursor: afterEditCursor,
        afterMovePageCursor: afterMoveCursor,
        removedOccurrence: { id: duplicateOccurrenceId, deletionId, deletionRevision },
      },
    };
    return { manifest, close: () => fixture.close() };

    async function captureVisibilityReads(visibility: NativeCuratedVisibility, id: string): Promise<void> {
      const byRole = nativeCuratedAccessExports[visibility];
      for (const role of ['owner', 'other', 'anonymous'] as const) {
        const persona: NativeCuratedPersona = role === 'owner' ? 'alice' : role === 'other' ? 'bob' : 'anonymous';
        const scenarios = byRole[role];
        await readCollection(scenarios.collection, visibility, id, persona);
        await readMembers(scenarios.members, visibility, id, persona, 20);
      }
    }
  } catch (error) {
    await fixture.close().catch(() => {});
    throw error;
  }
}
