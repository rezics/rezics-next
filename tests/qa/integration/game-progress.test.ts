import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';

const short = (resource: string) => resource.slice(-36);

async function json<T>(response: Response, status = 200): Promise<T> {
  if (response.status !== status) throw new Error(`${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('game play and completion preserve replay, device conflicts and recovery', async () => {
  const stack = await startMediaStack('game-progress', { profileCredits: true });
  try {
    const editor = await stack.member('game-editor');
    const reader = await stack.member('game-reader', { verified: true });
    const otherReader = await stack.member('game-other-reader', { verified: true });
    await editor.grant('work:create:root', 'work.create');

    const createGame = async (title: string) => {
      const response = await editor.send('POST', '/v1/works', {
        profile: 'metadata-only-v1', authoring: 'own-work', title, language: 'en',
        semanticTypes: ['https://schema.org/VideoGame'], actingSubject: editor.actor,
      });
      return json<{ work: string; mainVersion: string }>(response, 201);
    };
    const game = await createGame(`Game ${randomUUID()}`);
    const requiredRoute = await createGame(`Required route ${randomUUID()}`);
    const extraRoute = await createGame(`Extra route ${randomUUID()}`);
    const partlessGame = await createGame(`Partless game ${randomUUID()}`);
    const works = [game, requiredRoute, extraRoute, partlessGame];
    for (const work of works) {
      await editor.grant(`work:edit:${work.work}`, 'work.edit');
      await editor.grant(`work:read:${work.work}`, 'work.read');
      await reader.grant(`work:read:${work.work}`, 'work.read');
      await otherReader.grant(`work:read:${work.work}`, 'work.read');
    }

    const structureObjects = stack.objects('semantic/structure/');
    await structureObjects.initialize();
    Object.assign(stack.env, { structureObjects });

    const created = await json<{ structure: string; revision: string }>(await editor.send(
      'POST', '/v1/compositions', { profile: 'work-composition', work: game.work,
        mainVersion: game.mainVersion, actingSubject: editor.actor }), 201);
    const changed = await json<{ revision: string; occurrences: string[] }>(await editor.send('POST',
      `/v1/compositions/${short(created.structure)}/changes`, {
        profile: 'work-composition', expectedHead: created.revision, actingSubject: editor.actor,
        operations: [
          { op: 'insert', parent: created.structure, position: 'last', role: 'part',
            target: requiredRoute.work, displayLabel: 'Main story', inclusion: 'required' },
          { op: 'insert', parent: created.structure, position: 'last', role: 'part',
            target: extraRoute.work, displayLabel: 'Bonus route', inclusion: 'extra' },
        ],
      }));

    const parts = await json<{ structure: string; parts: Array<{
      occurrence: string; displayLabel?: string; inclusion?: string;
    }> }>(await editor.read(`/v1/resources/${short(game.work)}/parts?limit=20`));
    expect(parts.parts.map(part => [part.displayLabel, part.inclusion])).toEqual([
      ['Main story', 'required'], ['Bonus route', 'extra'],
    ]);
    expect(parts.structure).toBe(created.structure);
    expect(new Set(changed.occurrences)).toEqual(new Set(parts.parts.map(part => part.occurrence)));

    const parentProgressPath = `/v1/works/${short(game.work)}/progress`;
    expect(await json<{ work: string; parts: boolean }>(await reader.read(parentProgressPath)))
      .toEqual({ work: game.work, parts: true });
    const requiredPart = parts.parts.find(part => part.inclusion === 'required')!;
    const extraPart = parts.parts.find(part => part.inclusion === 'extra')!;
    const progressPath = `/v1/compositions/${short(created.structure)}/occurrences/${short(requiredPart.occurrence)}/progress`;
    const extraProgressPath = `/v1/compositions/${short(created.structure)}/occurrences/${short(extraPart.occurrence)}/progress`;
    const initial = await json<{ completed: boolean; position: string | null; version: number }>(
      await reader.read(progressPath));
    expect(initial).toMatchObject({ completed: false, position: null, version: 0 });

    const playedCommand = { actingSubject: reader.actor, expectedVersion: 0,
      completed: false, position: 'played' };
    const playedKey = `game-progress-${randomUUID()}`;
    const played = await json<{ completed: boolean; position: string | null; version: number }>(
      await reader.send('PUT', progressPath, playedCommand, playedKey));
    expect(played).toMatchObject({ completed: false, position: 'played', version: 1 });
    const replay = await json<{ completed: boolean; position: string | null; version: number; replayed: boolean }>(
      await reader.send('PUT', progressPath, playedCommand, playedKey));
    expect(replay).toMatchObject({ completed: false, position: 'played', version: 1, replayed: true });

    const isolated = await json<{ completed: boolean; position: string | null; version: number }>(
      await otherReader.read(progressPath));
    expect(isolated).toMatchObject({ completed: false, position: null, version: 0 });

    // This new request is the second device's cached version for the same reader.
    const stale = await reader.send('PUT', progressPath, { actingSubject: reader.actor,
      expectedVersion: 0, completed: true, position: 'completed' }, `stale-${randomUUID()}`);
    expect(stale.status).toBe(409);
    expect((await stale.json() as { code: string }).code).toBe('stale_progress');
    const recoveredBase = await json<{ completed: boolean; position: string | null; version: number }>(
      await reader.read(progressPath));
    expect(recoveredBase).toMatchObject({ completed: false, position: 'played', version: 1 });
    const completed = await json<{ completed: boolean; position: string | null; version: number }>(
      await reader.send('PUT', progressPath, { actingSubject: reader.actor,
        expectedVersion: recoveredBase.version, completed: true, position: 'completed' }, `complete-${randomUUID()}`));
    expect(completed).toMatchObject({ completed: true, position: 'completed', version: 2 });
    const undone = await json<{ completed: boolean; position: string | null; version: number }>(
      await reader.send('PUT', progressPath, { actingSubject: reader.actor,
        expectedVersion: completed.version, completed: false, position: null }, `undo-${randomUUID()}`));
    expect(undone).toMatchObject({ completed: false, position: null, version: 3 });

    const extra = await json<{ completed: boolean; position: string | null; version: number }>(
      await reader.send('PUT', extraProgressPath, { actingSubject: reader.actor,
        expectedVersion: 0, completed: true, position: 'completed' }, `extra-${randomUUID()}`));
    expect(extra).toMatchObject({ completed: true, position: 'completed', version: 1 });
    expect(await json<{ completed: boolean; position: string | null; version: number }>(
      await otherReader.read(progressPath))).toMatchObject({ completed: false, position: null, version: 0 });
    expect(await json<{ completed: boolean; position: string | null; version: number }>(
      await otherReader.read(extraProgressPath))).toMatchObject({ completed: false, position: null, version: 0 });

    const partlessPath = `/v1/works/${short(partlessGame.work)}/progress`;
    expect(await json<{ parts: boolean; standing: string; version: number }>(
      await reader.read(partlessPath))).toMatchObject({ parts: false, standing: 'not-started', version: 0 });
    const started = await json<{ standing: string; version: number }>(await reader.send('PUT', partlessPath,
      { actingSubject: reader.actor, expectedVersion: 0, standing: 'started' }, `partless-play-${randomUUID()}`));
    expect(started).toMatchObject({ standing: 'started', version: 1 });
    const partlessCompleted = await json<{ standing: string; version: number }>(await reader.send('PUT', partlessPath,
      { actingSubject: reader.actor, expectedVersion: 1, standing: 'completed' }, `partless-complete-${randomUUID()}`));
    expect(partlessCompleted).toMatchObject({ standing: 'completed', version: 2 });
    const partlessUndone = await json<{ standing: string; version: number }>(await reader.send('PUT', partlessPath,
      { actingSubject: reader.actor, expectedVersion: 2, standing: 'not-started' }, `partless-undo-${randomUUID()}`));
    expect(partlessUndone).toMatchObject({ standing: 'not-started', version: 3 });
  } finally {
    await stack.stop();
  }
}, 600_000);
