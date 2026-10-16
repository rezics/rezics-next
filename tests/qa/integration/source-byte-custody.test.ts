import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { Pool } from 'pg';
import { personaSessions, type PersonaSessions } from '../support/personas.ts';
import { grantPersonaFixtureAuthority } from '../support/persona-fixture-authority.ts';
import { startPostgresCluster } from '../support/postgres-cluster.ts';
import { assertReplayedCommentSourcesTerminal } from '../../../services/main/src/modules/work/content-recovery-coverage.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import type { RecipeCollectionOutcome } from '../../../services/main/src/modules/recipe/collection-import.ts';

let sessions: PersonaSessions;
let content: Pool;
let access: Pool;
let image: string;
beforeAll(async () => {
  sessions = await personaSessions('public'); // Starts the real composeMain composition.
  content = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  image = (await sharp(randomBytes(640 * 480 * 3), { raw: { width: 640, height: 480, channels: 3 } }).png().toBuffer()).toString('base64');
}, 240_000);
afterAll(async () => { await content?.end(); await access?.end(); await sessions?.close(); });
const short = (value: string) => value.slice(-36);
async function json<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

for (const provider of ['paprika', 'mela'] as const) {
  test(`${provider}: private imported bytes follow the exact Content erasure and its restored absence proof`, async () => {
    const owner = sessions.owner;
    const marker = `PRIVATE-SOURCE-${randomUUID()}`;
    const original = provider === 'paprika'
      ? { uid: randomUUID(), name: marker, ingredients: '1 cup water', directions: 'Boil.', notes: marker, photo_data: image }
      : { id: randomUUID(), title: marker, ingredients: '1 cup water', instructions: 'Boil.', notes: marker, images: [image] };
    const bytes = Buffer.from(JSON.stringify(original));
    const format = provider === 'paprika' ? 'paprikarecipes' : 'melarecipe';
    const upload = () => owner.main('POST', `/v1/recipes/file-imports?actingSubject=${encodeURIComponent(owner.actingSubject!)}&format=${format}`,
      undefined, randomUUID(), { bytes: provider === 'paprika'
        ? zipSync({ 'recipe.paprikarecipe': gzipSync(bytes) }) : bytes,
      headers: { 'content-type': 'application/octet-stream' } });
    const imported = (await json<{ items: RecipeCollectionOutcome[] }>(upload())).items[0]!;
    expect(imported.status).toBe('imported');
    expect(imported.photos[0]?.use).toBeTruthy();
    expect((await json<{ items: RecipeCollectionOutcome[] }>(upload())).items[0]).toEqual({ ...imported, replayed: true });
    const observation = short(imported.sourceObservation), revisionId = imported.content.revisionId;
    const read = (pool: Pool) => pool.query(`SELECT retention, raw_bytes, byte_digest, rights_evidence
      FROM source.observation WHERE id = $1`, [observation]).then(result => result.rows[0]);
    const before = await read(content);
    expect(before.raw_bytes.toString()).toContain(marker);
    expect(before.rights_evidence.basis).toBe('unknown');
    expect((await sessions.stranger.main('GET', `/v1/sources/observations/${observation}`)).status).toBe(404);
    await grantPersonaFixtureAuthority(owner, [{ scope: `erasure:${imported.content.post}`, action: 'erasure.request' }]);
    const request = { profile: 'content-revision-erasure-v1', resourceId: imported.content.post,
      revisionIds: [revisionId], actingSubject: owner.actingSubject };
    expect((await sessions.stranger.main('POST', '/v1/erasures', request)).status).toBe(403);

    // Keep an ordinary pre-erasure owner backup, then restore it in isolation.
    const directory = resolve('.temp', `source-custody-${randomUUID()}`);
    mkdirSync(directory, { recursive: true });
    const dump = `${directory}/before.sql`;
    execFileSync('pg_dump', ['--dbname', Bun.env.CONTENT_DATABASE_URL!, '--no-owner', '--no-privileges', '-f', dump]);
    const restored = await startPostgresCluster();
    const restoredPool = new Pool({ ...restored.connection, max: 2 });
    try {
      const key = randomUUID();
      const erased = await json<{ erasureId: string; erasureEpoch: string; suppression: string }>(
        owner.main('POST', '/v1/erasures', request, key));
      expect(erased.suppression).toBe('suppressed');
      expect(await read(content)).toEqual({ retention: 'not-retained', raw_bytes: null, byte_digest: null,
        rights_evidence: before.rights_evidence });
      expect(await json(owner.main('POST', '/v1/erasures', request, key))).toMatchObject({
        erasureId: erased.erasureId, replayed: true });
      execFileSync('psql', ['-h', '127.0.0.1', '-p', String(restored.port), '-U', restored.user,
        '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', dump], { stdio: 'pipe' });
      expect((await read(restoredPool)).raw_bytes.toString()).toContain(marker);
      // The restore reader must detect the retained bytes before replay, even
      // when the Content tombstone itself survived a partial restore.
      await restoredPool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL WHERE id = $1`, [revisionId]);
      await restoredPool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch) VALUES ($1,$2,$3)`,
        [revisionId, erased.erasureId, erased.erasureEpoch]);
      const open = () => restoredPool.query(`SELECT revision_id::text FROM verification.open_evidence_source_revisions($1::uuid[])`, [[revisionId]]);
      expect((await open()).rows).toEqual([{ revision_id: revisionId }]);
      const terminal = () => assertReplayedCommentSourcesTerminal(restoredPool, [revisionId], erased.erasureId, erased.erasureEpoch);
      await expect(terminal()).rejects.toThrow('erased source selectors remain');
      const replay = () => applyContentErasure(restoredPool, { preservationAccess: access, resourceId: imported.content.post,
        revisionIds: [revisionId], erasureId: erased.erasureId, erasureEpoch: erased.erasureEpoch });
      await replay();
      expect((await open()).rows).toEqual([]);
      expect(await read(restoredPool)).toEqual(await read(content));
      await terminal();
      await replay();
      expect((await open()).rows).toEqual([]);
      await terminal();
    } finally {
      await restoredPool.end(); restored.remove(); rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
}
