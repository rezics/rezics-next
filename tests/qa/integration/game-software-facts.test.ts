import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { FactsConflict, RevisionedFactsStore }
  from '../../../services/main/src/modules/game-facts/store.ts';
import type { GameFacts } from '../../../services/main/src/modules/game-facts/contract.ts';
import type { SoftwareFacts } from '../../../services/main/src/modules/software-facts/contract.ts';

const at = '2026-09-28T00:00:00.000Z';
const url = 'https://example.org/project';

test('game and app facts keep idempotent snapshots, reject stale editors and bound public reads', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    const principal = randomUUID(), actor = `https://rezics.com/id/${randomUUID()}`;
    await pool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,'https://local.example.test',$2)`, [principal, randomUUID()]);
    const gameWork = `https://rezics.com/id/${randomUUID()}`;
    const appWork = `https://rezics.com/id/${randomUUID()}`;
    const games = new RevisionedFactsStore<GameFacts>(pool, 'game');
    const apps = new RevisionedFactsStore<SoftwareFacts>(pool, 'software');
    const game: GameFacts = { profile: 'game-facts-v1', pitch: 'Explore a new world.', source: url,
      observedAt: at, status: 'upcoming', releaseDate: null, platforms: ['Windows'],
      languages: ['English'], tags: ['Exploration'], screenshots: [], modsZone: false, review: null };
    const app: SoftwareFacts = { profile: 'software-facts-v1', pitch: 'Make something.', project: url,
      source: `${url}/source`, maintainer: 'Example maintainers', license: null, observedAt: at,
      screenshots: [], releases: [{ platform: 'Linux', architecture: null, version: null,
        changes: null, destination: url, source: url, observedAt: at }],
      alternatives: [{ work: appWork, reason: 'A second way to do the task.', attributedTo: actor }] };
    const first = await games.write(principal, 'game-first', gameWork, null, game, actor);
    expect(first).toEqual({ work: gameWork, revision: 1, facts: game });
    expect(await games.write(principal, 'game-first', gameWork, null, game, actor)).toEqual(first);
    await expect(games.write(principal, 'game-first', gameWork, null,
      { ...game, pitch: 'Different' }, actor)).rejects.toBeInstanceOf(FactsConflict);
    await expect(games.write(principal, 'game-stale', gameWork, null, game, actor))
      .rejects.toBeInstanceOf(FactsConflict);
    const races = await Promise.allSettled([
      games.write(principal, 'game-a', gameWork, 1, { ...game, status: 'released' }, actor),
      games.write(principal, 'game-b', gameWork, 1, { ...game, status: 'released' }, actor),
    ]);
    expect(races.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(races.filter(item => item.status === 'rejected')).toHaveLength(1);
    expect((await games.read(gameWork))?.revision).toBe(2);
    // An old receipt remains replayable after a later revision.
    expect(await games.write(principal, 'game-first', gameWork, null, game, actor)).toEqual(first);
    const savedApp = await apps.write(principal, 'app-first', appWork, null, app, actor);
    expect((await apps.read(appWork))?.facts).toEqual(app);
    expect(savedApp.facts.releases[0]?.version).toBeNull();
    expect(await games.read(appWork)).toBeNull();
    const recoveryWork = `https://rezics.com/id/${randomUUID()}`;
    await expect(apps.write(principal, 'app-recovery', recoveryWork, null,
      { ...app, profile: 'invalid' } as unknown as SoftwareFacts, actor)).rejects.toThrow();
    expect(await apps.read(recoveryWork)).toBeNull();
    expect(await apps.write(principal, 'app-recovery', recoveryWork, null, app, actor))
      .toEqual({ work: recoveryWork, revision: 1, facts: app });
  } finally { await pool.end(); }
}, 120_000);
