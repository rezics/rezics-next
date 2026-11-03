import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  createNativePublishedLogResponseFixture,
  nativePublishedLogResponseHeaderAllowlist,
  nativePublishedLogResponseScenarioManifest,
  type NativePublishedLogCall,
  type NativePublishedLogResponse,
  type NativePublishedLogResponseFixture,
  type NativePublishedLogResponseScenario,
} from './native-published-log-responses-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativePublishedLogResponseFixture;

beforeAll(async () => {
  fixture = await createNativePublishedLogResponseFixture();
}, 600_000);

afterAll(async () => fixture?.close(), 180_000);

function callFor(scenario: NativePublishedLogResponseScenario): NativePublishedLogCall {
  const result = fixture.manifest.scenarios[scenario];
  if (result.availability !== 'available') throw new Error(`${scenario} is unavailable: ${result.binding}`);
  const call = fixture.manifest.calls.find(({ sequence }) => sequence === result.callSequence);
  if (!call) throw new Error(`${scenario} has no response at command sequence ${result.callSequence}`);
  return call;
}

function callByKey(keyName: string): NativePublishedLogCall {
  const key = fixture.manifest.commandKeys[keyName];
  if (!key) throw new Error(`Missing native command key ${keyName}`);
  const call = fixture.manifest.calls.find(({ command }) => command.input.idempotencyKey === key);
  if (!call) throw new Error(`Native command key ${keyName} has no captured command`);
  return call;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} was not an object`);
  return value as Record<string, unknown>;
}

function nested(value: unknown, key: string, label: string): Record<string, unknown> {
  return object(object(value, label)[key], `${label}.${key}`);
}

function items(response: NativePublishedLogResponse, label: string): Record<string, unknown>[] {
  const value = object(response.body, label).publishedLogs;
  if (!Array.isArray(value)) throw new Error(`${label}.publishedLogs was not an array`);
  return value.map((item, index) => object(item, `${label}.publishedLogs[${index}]`));
}

function ids(response: NativePublishedLogResponse, label: string): string[] {
  return items(response, label).map((item, index) => {
    if (typeof item.id !== 'string') throw new Error(`${label}.publishedLogs[${index}].id was absent`);
    return item.id;
  });
}

function rawJson(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function assertNoPrivateSourceFields(response: NativePublishedLogResponse): void {
  const publishedLog = nested(response.body, 'publishedLog', 'Public log response');
  for (const field of ['amount', 'completedUnitCount', 'locator', 'position', 'progressSession', 'sessionId', 'total', 'unit'])
    expect(publishedLog).not.toHaveProperty(field);
}

describe('native published-log response bindings', () => {
  test('binds the closed reviewer map to unmodified native responses and a clean source build', () => {
    const { identity, calls, scenarios } = fixture.manifest;
    expect(identity.source.repository).toBe('rezics');
    expect(identity.source.revision).toMatch(/^[0-9a-f]{40}$/i);
    expect(identity.source.clean).toBe(true);
    expect(identity.build.id).toContain(identity.source.revision!);
    expect(identity.build.id).toContain(identity.build.definitionsDigest);
    expect(identity.build.runtime).toBe('Bun');
    expect(identity.build.runtimeVersion).toBe(Bun.version);
    expect(identity.build.definitionsDigest).toMatch(/^[0-9a-f]{64}$/i);

    expect(Object.keys(scenarios).sort()).toEqual(Object.keys(nativePublishedLogResponseScenarioManifest).sort());
    for (const [name, descriptor] of Object.entries(nativePublishedLogResponseScenarioManifest)) {
      const result = scenarios[name as NativePublishedLogResponseScenario];
      expect(result.availability).toBe(descriptor.availability);
      if (descriptor.availability === 'unavailable') {
        expect(result).toMatchObject({ availability: 'unavailable', binding: descriptor.binding });
        continue;
      }
      expect(result.availability).toBe('available');
      if (result.availability !== 'available') continue;
      const call = calls.find(({ sequence }) => sequence === result.callSequence);
      expect(call).toBeDefined();
      expect(call!.response.persona).toBe(descriptor.persona);
      expect(call!.command.persona).toBe(descriptor.persona);
    }

    for (const [index, call] of calls.entries()) {
      expect(call.sequence).toBe(index);
      expect(call.command.sequence).toBe(index);
      expect(call.response.method).toBe(call.command.method);
      expect(call.response.path).toBe(call.command.path);
      expect(call.response.persona).toBe(call.command.persona);
      expect(call.response.body).toEqual(rawJson(call.response.bodyText));
      expect(Object.keys(call.response.headers).every((name) =>
        (nativePublishedLogResponseHeaderAllowlist as readonly string[]).includes(name),
      )).toBe(true);
      expect(Object.keys(call.command.input).sort()).toEqual(
        call.command.input.bodyText === null
          ? ['bodyText', 'idempotencyKey']
          : ['body', 'bodyText', 'idempotencyKey'],
      );
      if (call.command.input.bodyText !== null)
        expect(JSON.stringify(call.command.input.body)).toBe(call.command.input.bodyText);
    }

    for (const name of ['publish', 'delete', 'restore', 'occupiedRestore', 'deleteAgain', 'staleRestore', 'finalRestore']) {
      expect(fixture.manifest.commandKeys[name]).toMatch(/^"[0-9a-f-]{36}"$/i);
    }
    expect(new Set(Object.values(fixture.manifest.commandKeys)).size).toBe(Object.keys(fixture.manifest.commandKeys).length);
  });

  test('keeps the current private source separate from public readers through delete and restore', () => {
    const { ids: fixtureIds } = fixture.manifest;
    const sourceBefore = callFor('sourceOwnerBeforeDelete');
    const privateSession = nested(sourceBefore.response.body, 'progressSession', 'Owner private source response');
    expect(sourceBefore.response.status).toBe(200);
    expect(privateSession).toMatchObject({
      id: fixtureIds.sourceSessionId,
      amount: '150',
      total: '300',
      unit: 'page',
    });

    const publication = callFor('explicitPublicationResult');
    expect(publication.response.status).toBe(201);
    expect(nested(publication.response.body, 'publishedLog', 'Explicit publication response')).toMatchObject({
      id: fixtureIds.publishedLogId,
      note: 'N'.repeat(1000),
    });

    const privateScenarios = [
      'sourceOwnerBeforeDelete', 'sourceOtherBeforeDelete', 'sourceAnonymousBeforeDelete',
      'sourceOwnerWhileHidden', 'sourceOtherWhileHidden', 'sourceAnonymousWhileHidden',
      'sourceOwnerAfterRestore', 'sourceOtherAfterRestore', 'sourceAnonymousAfterRestore',
    ] as const;
    for (const scenario of privateScenarios) {
      const call = callFor(scenario);
      if (scenario.includes('Owner')) {
        expect(call.response.status).toBe(200);
        expect(nested(call.response.body, 'progressSession', scenario)).toMatchObject({
          id: fixtureIds.sourceSessionId,
          amount: '150',
          total: '300',
        });
      } else if (scenario.includes('Other')) {
        expect(call.response.status).toBe(404);
      } else {
        expect(call.response.status).toBe(401);
      }
    }

    const publicScenarios = [
      'publicOwnerBeforeDelete', 'publicOtherBeforeDelete', 'publicAnonymousBeforeDelete',
      'publicOwnerAfterRestore', 'publicOtherAfterRestore', 'publicAnonymousAfterRestore',
    ] as const;
    for (const scenario of publicScenarios) {
      const call = callFor(scenario);
      expect(call.response.status).toBe(200);
      expect(nested(call.response.body, 'publishedLog', scenario)).toMatchObject({
        id: fixtureIds.publishedLogId,
        note: 'N'.repeat(1000),
      });
      expect(object(call.response.body, scenario)).not.toHaveProperty('next');
      assertNoPrivateSourceFields(call.response);
    }

    for (const scenario of ['publicOwnerWhileHidden', 'publicOtherWhileHidden', 'publicAnonymousWhileHidden'] as const) {
      const call = callFor(scenario);
      expect(call.response.status).toBe(200);
      const hidden = nested(call.response.body, 'publishedLog', scenario);
      expect(hidden).toMatchObject({ id: fixtureIds.publishedLogId, deleted: true });
      expect(hidden).not.toHaveProperty('note');
    }

    const before = nested(callFor('publicOwnerBeforeDelete').response.body, 'publishedLog', 'Before-delete public log');
    const after = nested(callFor('publicOwnerAfterRestore').response.body, 'publishedLog', 'Restored public log');
    expect(after).toMatchObject({ id: before.id, note: before.note });
  });

  test('preserves native owner page order and only reuses the owner cursor for its continuation', () => {
    const { ids: fixtureIds, aliceAccountId, bobAccountId } = fixture.manifest;
    const initial = callFor('ownerHistoryBeforePublication');
    expect(initial.response.status).toBe(200);
    expect(items(initial.response, 'Owner history before explicit publication')).toEqual([]);
    expect(object(initial.response.body, 'Owner history before explicit publication').next).toBeNull();

    const otherEmpty = callFor('otherHistoryEmpty');
    expect(otherEmpty.response.status).toBe(200);
    expect(items(otherEmpty.response, 'Other owner empty history')).toEqual([]);
    expect(new URL(otherEmpty.command.path, 'https://kernel.invalid').searchParams.get('accountId')).toBe(bobAccountId);

    const firstBefore = callFor('ownerHistoryFirstBeforeDelete');
    const finalBefore = callFor('ownerHistoryFinalBeforeDelete');
    const firstBeforeIds = ids(firstBefore.response, 'Owner history first page before delete');
    const finalBeforeIds = ids(finalBefore.response, 'Owner history final page before delete');
    const beforeCursor = object(firstBefore.response.body, 'Owner history first page before delete').next;
    expect(firstBeforeIds).toHaveLength(100);
    expect(typeof beforeCursor).toBe('string');
    expect(finalBeforeIds).toHaveLength(1);
    expect(object(finalBefore.response.body, 'Owner history final page before delete').next).toBeNull();
    expect(finalBefore.command.persona).toBe('alice');
    expect(new URL(firstBefore.command.path, 'https://kernel.invalid').searchParams.get('accountId')).toBe(aliceAccountId);
    expect(new URL(finalBefore.command.path, 'https://kernel.invalid').searchParams.get('accountId')).toBe(aliceAccountId);
    expect(new URL(finalBefore.command.path, 'https://kernel.invalid').searchParams.get('cursor')).toBe(beforeCursor);
    const beforeIds = [...firstBeforeIds, ...finalBeforeIds];
    expect(new Set(beforeIds).size).toBe(101);
    expect(beforeIds).toContain(fixtureIds.publishedLogId);
    for (const id of fixtureIds.generatedLogIds) expect(beforeIds).toContain(id);

    const hidden = callFor('ownerHistoryWhileHidden');
    const hiddenIds = ids(hidden.response, 'Owner history while log is hidden');
    expect(hidden.response.status).toBe(200);
    expect(hiddenIds).toHaveLength(100);
    expect(hiddenIds).toEqual(beforeIds.filter((id) => id !== fixtureIds.publishedLogId));
    expect(object(hidden.response.body, 'Owner history while log is hidden').next).toBeNull();

    const firstAfter = callFor('ownerHistoryFirstAfterRestore');
    const finalAfter = callFor('ownerHistoryFinalAfterRestore');
    const firstAfterIds = ids(firstAfter.response, 'Owner history first page after restore');
    const finalAfterIds = ids(finalAfter.response, 'Owner history final page after restore');
    const afterCursor = object(firstAfter.response.body, 'Owner history first page after restore').next;
    expect(firstAfterIds).toHaveLength(100);
    expect(typeof afterCursor).toBe('string');
    expect(finalAfterIds).toHaveLength(1);
    expect(object(finalAfter.response.body, 'Owner history final page after restore').next).toBeNull();
    expect(new URL(finalAfter.command.path, 'https://kernel.invalid').searchParams.get('cursor')).toBe(afterCursor);
    expect([...firstAfterIds, ...finalAfterIds]).toEqual(beforeIds);

    for (const call of fixture.manifest.calls.filter(({ command }) => command.method === 'GET' && command.path.startsWith('/v1/publishedLogs/'))) {
      expect(new URL(call.command.path, 'https://kernel.invalid').searchParams.has('cursor')).toBe(false);
      expect(object(call.response.body, 'Public log response')).not.toHaveProperty('next');
    }
  });

  test('uses each real deletion receipt and a distinct current restore command key', () => {
    const { commandKeys, observedRevisions, ids: fixtureIds } = fixture.manifest;
    const deletion = callByKey('delete');
    expect(deletion.command.method).toBe('DELETE');
    expect(deletion.command.persona).toBe('alice');
    expect(deletion.response.status).toBe(200);
    expect(new URL(deletion.command.path, 'https://kernel.invalid').searchParams.get('revision')).toBe(
      String(observedRevisions.published),
    );
    const deletionId = deletion.response.headers['library-published-log-deletion-id'];
    const deletionRevision = Number(deletion.response.headers['library-published-log-deletion-revision']);
    expect(deletionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(deletionRevision).toBe(observedRevisions.deleted);

    const restore = callFor('ordinaryRestoreResult');
    expect(restore.command.method).toBe('POST');
    expect(restore.command.path).toBe(`/v1/publishedLogs/${encodeURIComponent(fixtureIds.publishedLogId)}:restore`);
    expect(restore.command.persona).toBe('alice');
    expect(restore.response.status).toBe(200);
    expect(restore.command.input.body).toEqual({ deletionId, revision: deletionRevision });
    expect(restore.command.input.bodyText).toBe(JSON.stringify({ deletionId, revision: deletionRevision }));
    expect(restore.command.input.idempotencyKey).toBe(commandKeys.restore);
    expect(commandKeys.restore).not.toBe(commandKeys.delete);
    expect(Number(restore.response.headers['library-published-log-revision'])).toBe(observedRevisions.restored);

    const occupied = callFor('restoreOccupied');
    expect(occupied.response.status).toBe(409);
    expect(occupied.command.input.body).toEqual(restore.command.input.body);
    expect(occupied.command.input.idempotencyKey).toBe(commandKeys.occupiedRestore);
    expect(occupied.command.input.idempotencyKey).not.toBe(commandKeys.restore);

    const deleteAgain = callByKey('deleteAgain');
    expect(deleteAgain.response.status).toBe(200);
    const currentDeletionId = deleteAgain.response.headers['library-published-log-deletion-id'];
    const currentDeletionRevision = Number(deleteAgain.response.headers['library-published-log-deletion-revision']);
    expect(currentDeletionRevision).toBe(observedRevisions.deletedAgain);

    const stale = callFor('restoreStale');
    expect(stale.response.status).toBe(409);
    expect(stale.command.input.body).toEqual({ deletionId, revision: deletionRevision });
    expect(stale.command.input.idempotencyKey).toBe(commandKeys.staleRestore);
    expect(stale.command.input.idempotencyKey).not.toBe(commandKeys.restore);

    const finalRestore = callByKey('finalRestore');
    expect(finalRestore.response.status).toBe(200);
    expect(finalRestore.command.input.body).toEqual({
      deletionId: currentDeletionId,
      revision: currentDeletionRevision,
    });
    expect(finalRestore.command.input.idempotencyKey).toBe(commandKeys.finalRestore);
    expect(finalRestore.command.input.idempotencyKey).not.toBe(commandKeys.deleteAgain);

    for (const scenario of ['restoreExpired', 'restoreHistorical'] as const) {
      expect(fixture.manifest.scenarios[scenario]).toMatchObject({ availability: 'unavailable' });
      if (fixture.manifest.scenarios[scenario].availability === 'unavailable')
        expect(fixture.manifest.scenarios[scenario].binding.length).toBeGreaterThan(0);
    }
  });
});
