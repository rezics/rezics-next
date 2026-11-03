import { expect, setDefaultTimeout, test } from 'bun:test';
import {
  nativeCuratedAccessExports,
  nativeCuratedResponseHeaderAllowlist,
  nativeCuratedResponseScenarioNames,
  startNativeCuratedResponsesFixture,
  type NativeCuratedResponseManifest,
  type NativeCuratedResponseOutcome,
  type NativeCuratedResponseScenario,
} from './native-curated-responses-fixture.ts';

setDefaultTimeout(900_000);

function response(manifest: NativeCuratedResponseManifest, name: NativeCuratedResponseScenario) {
  return manifest.outcomes[name].response;
}

function bodyObject(outcome: NativeCuratedResponseOutcome, label: string): Record<string, unknown> {
  const body = outcome.response.body;
  expect(body, label).toBeTruthy();
  expect(typeof body, label).toBe('object');
  expect(Array.isArray(body), label).toBe(false);
  return body as Record<string, unknown>;
}

function collection(outcome: NativeCuratedResponseOutcome, label: string): Record<string, unknown> {
  return bodyObject(outcome, label).collection as Record<string, unknown>;
}

function rows(outcome: NativeCuratedResponseOutcome, label: string): Record<string, unknown>[] {
  const result = bodyObject(outcome, label).members;
  expect(Array.isArray(result), `${label}.members`).toBe(true);
  return result as Record<string, unknown>[];
}

function member(outcome: NativeCuratedResponseOutcome, label: string): Record<string, unknown> {
  return bodyObject(outcome, label).member as Record<string, unknown>;
}

function rowById(values: readonly Record<string, unknown>[], id: string) {
  const found = values.find((row) => row.id === id);
  expect(found, `member occurrence ${id}`).toBeDefined();
  return found!;
}

function allRows(manifest: NativeCuratedResponseManifest, first: NativeCuratedResponseScenario, second: NativeCuratedResponseScenario) {
  return [...rows(manifest.outcomes[first], first), ...rows(manifest.outcomes[second], second)];
}

function withoutRequestId(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'request_id'));
}

function expectRawResponses(manifest: NativeCuratedResponseManifest) {
  const exports = new Map(manifest.routeMap.map((entry) => [entry.exportName, entry]));
  expect(manifest.routeMap).toHaveLength(nativeCuratedResponseScenarioNames.length);
  expect(new Set(exports.keys()).size).toBe(nativeCuratedResponseScenarioNames.length);
  expect([...exports.keys()].sort()).toEqual([...nativeCuratedResponseScenarioNames].sort());
  for (const name of nativeCuratedResponseScenarioNames) {
    const outcome = manifest.outcomes[name];
    const route = exports.get(name)!;
    expect(outcome.command.kind, name).toBe('http');
    expect(outcome.response.method, name).toBe(outcome.command.method);
    expect(outcome.response.path, name).toBe(outcome.command.path);
    expect(outcome.response.persona, name).toBe(outcome.command.persona);
    expect(route.method, name).toBe(outcome.response.method);
    expect(route.path, name).toBe(outcome.response.path);
    expect(route.persona, name).toBe(outcome.response.persona);
    expect(route.availability, name).toBe(outcome.availability);
    expect(Object.keys(outcome.response.headers).every((header) =>
      (nativeCuratedResponseHeaderAllowlist as readonly string[]).includes(header),
    ), `${name} headers`).toBe(true);
    const parsed = outcome.response.bodyText.length === 0 ? null : JSON.parse(outcome.response.bodyText);
    expect(outcome.response.body, `${name} body was enriched or normalized`).toEqual(parsed);
  }
  const serialized = JSON.stringify(manifest);
  expect(serialized).not.toMatch(/"(?:authorization|cookie|set-cookie|access_token|refresh_token|signature)"/i);
}

test('native curated response exports bind raw occurrence facts, visibility, CAS and unavailable publication states', async () => {
  const fixture = await startNativeCuratedResponsesFixture();
  try {
    const { manifest } = fixture;
    expectRawResponses(manifest);
    expect(manifest.identity.source.repository).toBe('rezics');
    expect(manifest.identity.source.revision).toMatch(/^[0-9a-f]{40}$/i);
    expect(manifest.identity.source.clean).toBe(true);
    expect(manifest.identity.build).not.toBeNull();
    expect(manifest.identity.build!.id).toBe(`native-production-web-worker:${manifest.identity.source.revision}`);
    expect(manifest.identity.build!.runtime).toBe('Bun');
    expect(manifest.identity.build!.runtimeVersion).toBe(Bun.version);

    const created = manifest.outcomes.collectionCreate;
    expect(created.response.status).toBe(201);
    expect(created.command).toMatchObject({ method: 'POST', path: '/v1/collections', persona: 'alice' });
    expect(collection(created, 'private Collection create')).toMatchObject({
      id: manifest.ids.collectionId,
      curatorAccountId: manifest.personas.ownerAccountId,
      visibility: 'private',
      membershipKind: 'curated',
    });
    expect(manifest.personas.ownerAccountId).not.toBe(manifest.personas.otherAccountId);
    expect(manifest.ids.firstSubjectId).not.toBe(manifest.ids.firstOccurrenceId);
    expect(manifest.ids.firstSubjectId).not.toBe(manifest.ids.duplicateOccurrenceId);
    expect(manifest.ids.otherSubjectId).not.toBe(manifest.ids.otherOccurrenceId);
    expect(new Set([
      manifest.ids.firstOccurrenceId,
      manifest.ids.duplicateOccurrenceId,
      manifest.ids.otherOccurrenceId,
    ]).size).toBe(3);

    const firstCreated = member(manifest.outcomes.memberFirstCreate, 'First occurrence create');
    const duplicateCreated = member(manifest.outcomes.memberDuplicateCreate, 'Duplicate occurrence create');
    const otherCreated = member(manifest.outcomes.memberOtherCreate, 'Other occurrence create');
    expect(manifest.outcomes.memberFirstCreate.response.status).toBe(201);
    expect(manifest.outcomes.memberDuplicateCreate.response.status).toBe(201);
    expect(manifest.outcomes.memberOtherCreate.response.status).toBe(201);
    expect(firstCreated).toMatchObject({ id: manifest.ids.firstOccurrenceId, subjectId: manifest.ids.firstSubjectId });
    expect(duplicateCreated).toMatchObject({ id: manifest.ids.duplicateOccurrenceId, subjectId: manifest.ids.firstSubjectId });
    expect(otherCreated).toMatchObject({ id: manifest.ids.otherOccurrenceId, subjectId: manifest.ids.otherSubjectId });
    expect(firstCreated.note).toBe('First occurrence note');
    expect(duplicateCreated.note).toBe('Duplicate occurrence note');
    expect(otherCreated.note).toBe('Other member note');
    for (const name of ['memberFirstCreate', 'memberDuplicateCreate', 'memberOtherCreate'] as const) {
      const command = manifest.outcomes[name].command;
      expect(command.retainedCommandKey).toMatch(/^"[0-9a-f-]{36}"$/i);
      expect(command.inputBodyText).toBeString();
    }

    const initialPage1 = rows(manifest.outcomes.ownerMembersInitialPage1, 'Initial owner member page 1');
    const initialPage2 = rows(manifest.outcomes.ownerMembersInitialPage2, 'Initial owner member page 2');
    const initialRows = [...initialPage1, ...initialPage2];
    expect(manifest.outcomes.ownerMembersInitialPage1.response.status).toBe(200);
    expect(manifest.outcomes.ownerMembersInitialPage2.response.status).toBe(200);
    expect(initialPage1).toHaveLength(2);
    expect(initialPage2).toHaveLength(1);
    expect(initialPage1.map((row) => row.id).concat(initialPage2.map((row) => row.id))).toEqual(
      manifest.observations.initialOrder,
    );
    expect(new Set(initialRows.map((row) => row.id)).size).toBe(3);
    expect(initialRows.filter((row) => row.subjectId === manifest.ids.firstSubjectId)).toHaveLength(2);
    expect(initialRows.filter((row) => row.subjectId === manifest.ids.otherSubjectId)).toHaveLength(1);
    expect(initialRows.map((row) => row.id)).toContain(manifest.ids.firstOccurrenceId);
    expect(initialRows.map((row) => row.id)).toContain(manifest.ids.duplicateOccurrenceId);
    expect(initialRows.map((row) => row.id)).toContain(manifest.ids.otherOccurrenceId);
    expect(initialRows.map((row) => row.note)).toContain('First occurrence note');
    expect(initialRows.map((row) => row.note)).toContain('Duplicate occurrence note');
    expect(new URLSearchParams(manifest.outcomes.ownerMembersInitialPage2.command.path.split('?')[1]).get('cursor')).toBe(
      manifest.observations.initialPageCursor,
    );
    expect(manifest.outcomes.ownerMembersInitialPage1.response.body).toMatchObject({ next: manifest.observations.initialPageCursor });
    expect(manifest.outcomes.ownerMembersInitialPage2.response.body).toMatchObject({ next: null });
    for (const name of ['ownerMembersInitialPage1', 'ownerMembersInitialPage2'] as const) {
      expect(manifest.outcomes[name].command.path).toContain('view=FULL');
      expect(manifest.outcomes[name].response.headers['cache-control']).toContain('private, no-store');
    }
    expect(rowById(initialRows, manifest.ids.firstOccurrenceId).addedAt).toBe(firstCreated.addedAt);
    expect(rowById(initialRows, manifest.ids.duplicateOccurrenceId).addedAt).toBe(duplicateCreated.addedAt);
    expect(rowById(initialRows, manifest.ids.otherOccurrenceId).addedAt).toBe(otherCreated.addedAt);

    const metadataEdit = manifest.outcomes.collectionMetadataEdit;
    const metadataReplay = manifest.outcomes.collectionMetadataEditReplay;
    const staleEdit = manifest.outcomes.staleCollectionMetadataEdit;
    const staleReplay = manifest.outcomes.staleCollectionMetadataEditReplay;
    expect(metadataEdit.response.status).toBe(200);
    expect(metadataReplay.response.status).toBe(200);
    expect(metadataReplay.command.retainedCommandKey).toBe(metadataEdit.command.retainedCommandKey);
    expect(metadataReplay.command.inputBodyText).toBe(metadataEdit.command.inputBodyText);
    expect(metadataReplay.response.body).toEqual(metadataEdit.response.body);
    expect(metadataEdit.command.observedRevision).toBe(
      (collection(manifest.outcomes.collectionOwnerReadAfterCreate, 'Collection before CAS').revision as number),
    );
    expect(staleEdit.response.status).toBe(409);
    expect(staleReplay.response.status).toBe(409);
    expect(staleReplay.command.retainedCommandKey).toBe(staleEdit.command.retainedCommandKey);
    expect(staleReplay.command.inputBodyText).toBe(staleEdit.command.inputBodyText);
    expect(collection(manifest.outcomes.collectionAfterCas, 'Collection after stale CAS')).toMatchObject({
      id: manifest.ids.collectionId,
      title: collection(metadataEdit, 'Successful metadata edit').title,
      revision: collection(metadataEdit, 'Successful metadata edit').revision,
    });
    expect(collection(manifest.outcomes.collectionAfterCas, 'Collection after stale CAS').title).not.toBe(
      JSON.parse(staleEdit.command.inputBodyText!).title,
    );

    const noteEdit = manifest.outcomes.memberNoteEdit;
    const noteReplay = manifest.outcomes.memberNoteEditReplay;
    expect(noteEdit.response.status).toBe(200);
    expect(noteReplay.response.status).toBe(200);
    expect(noteReplay.command.retainedCommandKey).toBe(noteEdit.command.retainedCommandKey);
    expect(noteReplay.command.inputBodyText).toBe(noteEdit.command.inputBodyText);
    expect(noteReplay.response.body).toEqual(noteEdit.response.body);
    expect(member(noteEdit, 'Occurrence note edit')).toMatchObject({
      id: manifest.ids.duplicateOccurrenceId,
      subjectId: manifest.ids.firstSubjectId,
      note: 'Edited duplicate occurrence note',
      addedAt: duplicateCreated.addedAt,
    });
    const editedRows = allRows(manifest, 'ownerMembersAfterEditPage1', 'ownerMembersAfterEditPage2');
    expect(editedRows.map((row) => row.id)).toEqual(manifest.observations.initialOrder);
    expect(rowById(editedRows, manifest.ids.duplicateOccurrenceId)).toMatchObject({
      note: 'Edited duplicate occurrence note',
      addedAt: duplicateCreated.addedAt,
    });
    expect(rowById(editedRows, manifest.ids.firstOccurrenceId)).toMatchObject({
      note: 'First occurrence note',
      addedAt: firstCreated.addedAt,
    });
    expect(manifest.outcomes.ownerMembersAfterEditPage1.response.body).toMatchObject({
      next: manifest.observations.afterEditPageCursor,
    });
    expect(new URLSearchParams(manifest.outcomes.ownerMembersAfterEditPage2.command.path.split('?')[1]).get('cursor')).toBe(
      manifest.observations.afterEditPageCursor,
    );

    const move = manifest.outcomes.memberMove;
    const moveReplay = manifest.outcomes.memberMoveReplay;
    expect(move.command.path).toContain(`${manifest.ids.duplicateOccurrenceId}:move`);
    expect(JSON.parse(move.command.inputBodyText!)).toEqual({ after: null });
    expect(move.response.status).toBe(200);
    expect(moveReplay.response.status).toBe(200);
    expect(moveReplay.command.retainedCommandKey).toBe(move.command.retainedCommandKey);
    expect(moveReplay.response.body).toEqual(move.response.body);
    expect(member(move, 'Occurrence move')).toMatchObject({
      id: manifest.ids.duplicateOccurrenceId,
      subjectId: manifest.ids.firstSubjectId,
      note: 'Edited duplicate occurrence note',
      addedAt: duplicateCreated.addedAt,
    });
    const movedRows = allRows(manifest, 'ownerMembersAfterMovePage1', 'ownerMembersAfterMovePage2');
    const expectedMovedOrder = [manifest.ids.duplicateOccurrenceId, ...manifest.observations.initialOrder.filter((id) => id !== manifest.ids.duplicateOccurrenceId)];
    expect(manifest.observations.orderAfterMove).toEqual(expectedMovedOrder);
    expect(movedRows.map((row) => row.id)).toEqual(manifest.observations.orderAfterMove);
    expect(new Map(editedRows.map((row) => [row.id, { subjectId: row.subjectId, note: row.note, addedAt: row.addedAt }]))).toEqual(
      new Map(movedRows.map((row) => [row.id, { subjectId: row.subjectId, note: row.note, addedAt: row.addedAt }])),
    );
    expect(new URLSearchParams(manifest.outcomes.ownerMembersAfterMovePage2.command.path.split('?')[1]).get('cursor')).toBe(
      manifest.observations.afterMovePageCursor,
    );

    for (const [visibility, roles] of Object.entries(nativeCuratedAccessExports) as [
      keyof typeof nativeCuratedAccessExports,
      (typeof nativeCuratedAccessExports)[keyof typeof nativeCuratedAccessExports],
    ][]) {
      for (const role of ['owner', 'other', 'anonymous'] as const) {
        const names = roles[role];
        const collectionRead = manifest.outcomes[names.collection];
        const memberRead = manifest.outcomes[names.members];
        const expectedPersona = role === 'owner' ? 'alice' : role === 'other' ? 'bob' : 'anonymous';
        expect(collectionRead.response.persona, `${visibility} ${role} Collection persona`).toBe(expectedPersona);
        expect(memberRead.response.persona, `${visibility} ${role} members persona`).toBe(expectedPersona);
        expect(collectionRead.command.path).toBe(`/v1/collections/${manifest.ids.collectionId}`);
        expect(memberRead.command.path).toContain(`/v1/collections/${manifest.ids.collectionId}/members?`);
        expect(memberRead.command.path).toContain('view=FULL');
      }
    }

    const privateOwner = manifest.outcomes.privateOwnerCollection;
    const privateOther = manifest.outcomes.privateOtherCollection;
    const privateAnonymous = manifest.outcomes.privateAnonymousCollection;
    expect(privateOwner.response.status).toBe(200);
    expect(privateOther.response.status).toBe(404);
    expect(privateAnonymous.response.status).toBe(404);
    expect(withoutRequestId(privateOther.response.body)).toEqual(withoutRequestId(privateAnonymous.response.body));
    expect(bodyObject(manifest.outcomes.privateOtherMembers, 'Private other member read')).not.toHaveProperty('members');
    expect(bodyObject(manifest.outcomes.privateAnonymousMembers, 'Private anonymous member read')).not.toHaveProperty('members');
    expect(manifest.outcomes.privateOtherMembers.response.status).toBe(404);
    expect(manifest.outcomes.privateAnonymousMembers.response.status).toBe(404);
    const privateOwnerRows = rows(manifest.outcomes.privateOwnerMembers, 'Private owner member read');
    expect(privateOwnerRows.map((row) => row.id)).toEqual(manifest.observations.orderAfterMove);

    for (const role of ['owner', 'other', 'anonymous'] as const) {
      const names = nativeCuratedAccessExports.unlisted[role];
      expect(manifest.outcomes[names.collection].response.status).toBe(200);
      expect(manifest.outcomes[names.members].response.status).toBe(200);
      expect(manifest.outcomes[names.collection].response.headers['cache-control']).toContain('private, no-store');
    }
    expect(rows(manifest.outcomes.unlistedOwnerMembers, 'Unlisted owner member read').map((row) => row.id)).toEqual(
      manifest.observations.orderAfterMove,
    );
    expect(rows(manifest.outcomes.unlistedOtherMembers, 'Unlisted other member read')).toEqual([]);
    expect(rows(manifest.outcomes.unlistedAnonymousMembers, 'Unlisted anonymous member read')).toEqual([]);

    expect(manifest.outcomes.hiddenSubjectDisclosure.response.status).toBe(200);
    expect(manifest.outcomes.hiddenSubjectDisclosure.command.persona).toBe('steward');
    for (const role of ['owner', 'other', 'anonymous'] as const) {
      const names = nativeCuratedAccessExports.public[role];
      expect(manifest.outcomes[names.collection].response.status).toBe(200);
      expect(manifest.outcomes[names.members].response.status).toBe(200);
      expect(collection(manifest.outcomes[names.collection], `Public ${role} Collection`).visibility).toBe('public');
    }
    const publicOwnerRows = rows(manifest.outcomes.publicOwnerMembers, 'Public owner member read');
    expect(publicOwnerRows.map((row) => row.id)).toEqual(manifest.observations.orderAfterMove);
    expect(publicOwnerRows.map((row) => row.subjectId)).toContain(manifest.ids.otherSubjectId);
    for (const role of ['other', 'anonymous'] as const) {
      const publicRows = rows(manifest.outcomes[nativeCuratedAccessExports.public[role].members], `Public ${role} member read`);
      expect(publicRows.map((row) => row.subjectId)).not.toContain(manifest.ids.otherSubjectId);
      expect(publicRows.map((row) => row.id)).toEqual(
        publicOwnerRows.filter((row) => row.subjectId !== manifest.ids.otherSubjectId).map((row) => row.id),
      );
    }
    expect(collection(manifest.outcomes.privateFinalOwnerCollection, 'Private owner before removal').visibility).toBe('private');
    const finalOwnerRows = rows(manifest.outcomes.privateFinalOwnerMembers, 'Private owner before removal');
    expect(finalOwnerRows.map((row) => row.id)).toEqual(manifest.observations.orderAfterMove);

    const removal = manifest.outcomes.memberRemove;
    const removalReplay = manifest.outcomes.memberRemoveReplay;
    expect(removal.response.status).toBe(204);
    expect(removal.response.bodyText).toBe('');
    expect(removalReplay.response.status).toBe(204);
    expect(removalReplay.response.bodyText).toBe('');
    expect(removalReplay.command.retainedCommandKey).toBe(removal.command.retainedCommandKey);
    expect(removalReplay.command.path).toBe(removal.command.path);
    expect(removalReplay.response.headers).toEqual(removal.response.headers);
    expect(removal.response.headers['library-collection-member-deletion-id']).toBe(
      manifest.observations.removedOccurrence.deletionId,
    );
    expect(Number(removal.response.headers['library-collection-member-deletion-revision'])).toBe(
      manifest.observations.removedOccurrence.deletionRevision,
    );
    expect(manifest.observations.removedOccurrence.id).toBe(manifest.ids.duplicateOccurrenceId);
    const undo = manifest.outcomes.memberUndo;
    expect(undo.response.status).toBe(200);
    expect(member(undo, 'Exact occurrence Undo')).toMatchObject({
      id: manifest.ids.duplicateOccurrenceId,
      subjectId: manifest.ids.firstSubjectId,
      note: 'Edited duplicate occurrence note',
      addedAt: duplicateCreated.addedAt,
    });
    const afterUndoRows = allRows(manifest, 'ownerMembersAfterUndoPage1', 'ownerMembersAfterUndoPage2');
    expect(manifest.observations.orderAfterUndo).toEqual(manifest.observations.orderAfterMove);
    expect(afterUndoRows.map((row) => row.id)).toEqual(manifest.observations.orderAfterMove);
    expect(afterUndoRows).toEqual(movedRows);

    const dynamicMembers = manifest.outcomes.dynamicMembersRead;
    if (dynamicMembers.response.status === 202) {
      expect(dynamicMembers.availability).toBe('unavailable');
      expect(dynamicMembers.response.body).toEqual({ preparing: true });
      expect(dynamicMembers.response.headers['retry-after']).toBe('1');
      expect(bodyObject(dynamicMembers, 'Preparing dynamic member page')).not.toHaveProperty('members');
    } else {
      expect(dynamicMembers.response.status).toBe(503);
      expect(dynamicMembers.availability).toBe('unavailable');
      expect(dynamicMembers.response.body).toMatchObject({ code: 'dependency_unavailable' });
      expect(bodyObject(dynamicMembers, 'Unavailable dynamic member page')).not.toHaveProperty('members');
    }
    const selectedPublication = manifest.outcomes.selectedPublicationUnavailable;
    expect(selectedPublication.availability).toBe('unavailable');
    expect(selectedPublication).toHaveProperty('binding', 'dependency_unavailable');
    expect(selectedPublication.response.status).toBe(503);
    expect(selectedPublication.response.body).toMatchObject({ code: 'dependency_unavailable' });
    expect(selectedPublication.response.body).not.toHaveProperty('publication');
    expect(selectedPublication.command.path).toBe(`/v1/collections/${manifest.ids.dynamicCollectionId}:publishSelected`);
    expect(selectedPublication.command.persona).toBe('alice');

    const responseCommands = manifest.sequence.filter((step) => step.kind === 'response');
    expect(responseCommands.map((step) => step.name)).toEqual(manifest.routeMap.map((entry) => entry.exportName));
  } finally {
    await fixture.close();
  }
});
