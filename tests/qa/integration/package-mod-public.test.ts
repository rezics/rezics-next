import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ModResolutionConflict, ModResolutionStore }
  from '../../../services/main/src/modules/package/mod-resolution.ts';
import type { ModRequest } from '../../../services/main/src/modules/package/mod-profile.ts';

test('public mod binding owns its private receipt and returns only bounded card facts', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const content = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    await migrateContent(content);
    const owner = randomUUID(), other = randomUUID();
    await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,'https://local.example.test', $2), ($3,'https://local.example.test',$4)`,
    [owner, randomUUID(), other, randomUUID()]);
    const text = JSON.stringify({ schemaVersion: 1, id: 'samplemod', version: '1.3.0',
      environment: 'client', depends: {} });
    const bytes = Buffer.from(text);
    const request: ModRequest = { profile: 'mod-native-capture-v1', ecosystem: 'fabric',
      side: 'CLIENT', root: 'samplemod', runtime: { loaderVersion: '0.16.10', gameVersion: '1.21.1' },
      captures: [{ identity: 'samplemod', surface: 'manifest', status: 'observed',
        bytesBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }] };
    const store = new ModResolutionStore(content, access);
    const { resolution } = await store.resolve(owner, `public-${randomUUID()}`, request);
    const work = `https://rezics.com/id/${randomUUID()}`;
    const id = resolution.resolution.slice(-36);
    await expect(store.bind(other, id, work)).rejects.toThrow();
    const first = await store.bind(owner, id, work);
    expect(first).toMatchObject({ game: 'Minecraft', loaders: ['Fabric'],
      gameVersions: ['1.21.1'], latestRelease: '1.3.0' });
    expect(await store.bind(owner, id, work)).toEqual(first);
    await expect(store.bind(owner, id, `https://rezics.com/id/${randomUUID()}`)).rejects.toThrow();
    const otherResolution = await store.resolve(owner, `public-${randomUUID()}`, request);
    await expect(store.bind(owner, otherResolution.resolution.resolution.slice(-36), work))
      .rejects.toBeInstanceOf(ModResolutionConflict);
    expect([...await store.readCards([work])]).toEqual([[work, first]]);
    expect(JSON.stringify(first)).not.toContain('bytesBase64');
    expect(JSON.stringify(first)).not.toContain('sha256');
  } finally { await Promise.all([content.end(), access.end()]); }
});
