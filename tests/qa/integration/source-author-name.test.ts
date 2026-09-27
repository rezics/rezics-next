import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { SourceAuthorNameStore } from '../../../services/main/src/modules/source/author-name.ts';
import { SourceIntakeStore, SourceIntakeConflict, SourceIntakeInvalid, SourceIntakeUnavailable }
  from '../../../services/main/src/modules/source/intake.ts';
import { OpenLibraryAcquisitionUnavailable } from '../../../services/main/src/modules/source/open-library.ts';

test('author refresh preserves provenance through lost capture responses, failures, missing names, removal and stale provider revisions', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) throw new Error('Run through QA integration');
  const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  try {
    await migrateContent(pool);
    const intake = new SourceIntakeStore(pool), principal = randomUUID();
    intake.reserveOpenLibrarySlot = async () => {};
    const key = `/authors/OL${Number(String(Date.now()).slice(-10))}A`;
    let count = 0, revision = 10, displayName: string | undefined = 'A factual name';
    let status = 200, malformed = false;
    const store = new SourceAuthorNameStore(pool, intake, (async () => {
      count++;
      return Response.json({ key: malformed ? '/authors/OL9A' : key, revision, name: displayName,
        type: { key: '/type/author' }, bio: 'Retained evidence, never a displayed name' }, { status });
    }) as typeof fetch);
    const submit = intake.submit.bind(intake);
    let lost = false;
    intake.submit = async (...args) => {
      const result = await submit(...args);
      if (!lost) { lost = true; throw new SourceIntakeUnavailable('lost capture response'); }
      return result;
    };
    const idempotency = randomUUID(), input = { action: 'refresh' as const, expectedRevision: null };
    const before = await store.search('factual', false);
    expect(before.names.size).toBe(0);
    await expect(store.command(principal, idempotency, key, input)).rejects.toBeInstanceOf(SourceIntakeUnavailable);
    const first = await store.command(principal, idempotency, key, input);
    expect(count).toBe(1);
    expect(first.name?.displayName).toBe(displayName);
    expect(await store.searchGeneration()).not.toBe(before.generation);
    expect((await store.search('factual', false)).names.get(key)).toEqual(first.name!);
    expect((await store.command(principal, idempotency, key, input)).replayed).toBe(true);
    expect(count).toBe(1);
    expect((await intake.read(principal, first.name!.nameSource.observation.slice(-36)))?.capture)
      .toMatchObject({ profile: 'open-library-author-acquisition-v1', url: `https://openlibrary.org${key}.json` });
    const refresh = () => store.command(principal, randomUUID(), key, { action: 'refresh', expectedRevision: first.revision });
    for (const failureStatus of [404, 429, 503, 302]) {
      status = failureStatus;
      await expect(refresh()).rejects.toBeInstanceOf(OpenLibraryAcquisitionUnavailable);
      expect((await store.batch([key])).get(key)).toEqual(first.name!);
    }
    status = 200;
    malformed = true;
    await expect(refresh()).rejects.toBeInstanceOf(OpenLibraryAcquisitionUnavailable);
    malformed = false;
    intake.setRawRetentionGate(async () => false);
    await expect(refresh()).rejects.toBeInstanceOf(SourceIntakeInvalid);
    expect((await store.batch([key])).get(key)).toEqual(first.name!);
    intake.setRawRetentionGate(async () => true);
    revision = 9;
    await expect(refresh()).rejects.toBeInstanceOf(SourceIntakeConflict);
    revision = 11;
    displayName = undefined;
    const missing = await refresh();
    expect(missing.state).toBe('removed');
    expect((await store.batch([key])).has(key)).toBe(false);
    const removed = await store.command(principal, randomUUID(), key,
      { action: 'remove', expectedRevision: missing.revision, reason: 'Explicit scoped removal' });
    revision = 10;
    displayName = 'Old provider response';
    await expect(store.command(principal, randomUUID(), key, { action: 'refresh', expectedRevision: removed.revision }))
      .rejects.toBeInstanceOf(SourceIntakeConflict);
    expect((await store.batch([key])).has(key)).toBe(false);
    expect(await pool.query('UPDATE source.author_name_revision SET display_name = $2 WHERE id = $1',
      [first.revision, 'tampered']).then(() => false, () => true)).toBe(true);
  } finally { await pool.end(); }
}, 30_000);
