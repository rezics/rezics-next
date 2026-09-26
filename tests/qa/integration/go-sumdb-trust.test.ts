import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { GoProxyCaptureStore }
  from '../../../services/main/src/modules/package/go-proxy-capture.ts';
import { type IncludedGoSumdbLookup }
  from '../../../services/main/src/modules/package/go-sumdb-lookup.ts';
import { verifyGoSumdbTreeNote }
  from '../../../services/main/src/modules/package/go-sumdb-note.ts';
import { GoSumdbTrustConflict, GoSumdbTrustStore,
  GoSumdbTrustUnavailable }
  from '../../../services/main/src/modules/package/go-sumdb-trust.ts';
import includedFixture from '../fixtures/go-sumdb-x-sync.json';
import latestFixture from '../fixtures/go-sumdb-latest.json';
import pseudoFixture from '../fixtures/go-sumdb-rsc-markdown.json';

test('PKG05/PKG14: PostgreSQL Go trust head and private capture proof survive exact read',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) {
      throw new Error('Run through the isolated QA integration tier');
    }
    const pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
    const owner = randomUUID();
    const other = randomUUID();
    const proxy = (async (value: RequestInfo | URL) => {
      const url = String(value);
      if (url.endsWith('/@v/list')) return new Response('v0.1.0\n');
      if (url.endsWith('.info')) return new Response(JSON.stringify({
        Version: 'v0.1.0', Time: '2022-10-01T00:00:00Z' }));
      if (url.endsWith('.mod')) return new Response('module golang.org/x/sync\n');
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const captures = new GoProxyCaptureStore(pool, proxy);
    const included = includedFixture as IncludedGoSumdbLookup;
    const latestNote = 'go.sum database tree\n65209736\n'
      + '5+uGFjx6xBZG8ip1+wi77v+grwbhhukIrxEUS8PXvRo=\n\n'
      + '— sum.golang.org Az3grnbssgK7ubgFX36gVETtNv0U23qxyAhAMai2QUfeGa3nB/akvkMdlUErfcZz7l/R3cVtYspg3dxXABkGZZKdsQ8=\n';
    const latest = { tree: verifyGoSumdbTreeNote(Buffer.from(latestNote)),
      signedNoteBase64: Buffer.from(latestNote).toString('base64') };
    let lookups = 0;
    const lookup = (async () => { lookups++; return included; }) as
      ConstructorParameters<typeof GoSumdbTrustStore>[2];
    const consistency = (async () => []) as
      ConstructorParameters<typeof GoSumdbTrustStore>[3];
    const latestFetch = (async () => latest) as
      ConstructorParameters<typeof GoSumdbTrustStore>[4];
    const store = new GoSumdbTrustStore(pool, captures, lookup,
      consistency, latestFetch);
    try {
      await migrateContent(pool);
      const captured = await captures.capture(owner, `go-sumdb-capture-${randomUUID()}`,
        { profile: 'go-module-proxy-capture-v1',
          path: 'golang.org/x/sync', version: 'v0.1.0' });
      const captureId = captured.capture.capture.split('/').at(-1)!;
      expect(captured.capture.manifest.goModH1).toBe(included.goModH1);
      expect(await store.verify(other, `go-sumdb-${randomUUID()}`, captureId))
        .toBeNull();
      const key = `go-sumdb-${randomUUID()}`;
      const created = await store.verify(owner, key, captureId);
      expect(created?.replayed).toBe(false);
      expect(created?.verification).toMatchObject({
        profile: 'go-sumdb-capture-verification-v1',
        path: 'golang.org/x/sync', version: 'v0.1.0',
        manifestSha256: captured.capture.manifest.rawSha256,
        goModH1: included.goModH1,
        recordIndex: 13544323,
        includedTree: included.tree, trustedTree: latest.tree,
      });
      const id = created!.verification.verification.split('/').at(-1)!;
      expect(await new GoSumdbTrustStore(pool, captures, lookup,
        consistency, latestFetch).read(owner, id)).toEqual(created!.verification);
      expect(await store.read(other, id)).toBeNull();
      expect(await store.verify(owner, key, captureId))
        .toEqual({ verification: created!.verification, replayed: true });
      expect(lookups).toBe(1);
      await expect(store.verify(owner, key, randomUUID()))
        .rejects.toThrow(GoSumdbTrustConflict);
      const head = (await pool.query<{ tree_size: string; root_hash: string }>(
        `SELECT tree_size, root_hash FROM pkg.go_sumdb_head
         WHERE server = 'sum.golang.org'`)).rows[0]!;
      expect(Number(head.tree_size)).toBe(latest.tree.size);
      expect(head.root_hash).toBe(latest.tree.rootHash);
      const newer = latestFixture;
      expect(verifyGoSumdbTreeNote(Buffer.from(newer.signedNoteBase64,
        'base64'))).toEqual(newer.tree);
      const failAdvance = new GoSumdbTrustStore(pool, captures, lookup,
        (async () => { throw new Error('inconsistent tree'); }) as
          ConstructorParameters<typeof GoSumdbTrustStore>[3],
        (async () => newer) as ConstructorParameters<typeof GoSumdbTrustStore>[4]);
      await expect(failAdvance.verify(owner, `go-sumdb-${randomUUID()}`,
        captureId)).rejects.toThrow(GoSumdbTrustUnavailable);
      const advanced = new GoSumdbTrustStore(pool, captures, lookup,
        consistency, (async () => newer) as
          ConstructorParameters<typeof GoSumdbTrustStore>[4]);
      const advancedReceipt = await advanced.verify(owner,
        `go-sumdb-${randomUUID()}`, captureId);
      expect(advancedReceipt?.verification.trustedTree).toEqual(newer.tree);
      expect((await pool.query(`SELECT id FROM pkg.go_sumdb_head_history`)).rowCount)
        .toBe(2);
      expect(await store.read(owner, id)).toEqual(created!.verification);
      const racingKey = `go-sumdb-${randomUUID()}`;
      const racing = await Promise.all([
        advanced.verify(owner, racingKey, captureId),
        advanced.verify(owner, racingKey, captureId),
      ]);
      expect(racing.map(item => item?.verification.verification))
        .toEqual([racing[0]?.verification.verification,
          racing[0]?.verification.verification]);
      expect(racing.filter(item => item?.replayed)).toHaveLength(1);
      const pseudoVersion = pseudoFixture.source.version;
      const pseudoProxy = (async (value: RequestInfo | URL) => {
        const url = String(value);
        if (url.endsWith('.info')) return new Response(JSON.stringify({
          Version: pseudoVersion, Time: '2024-03-06T14:43:22Z' }));
        if (url.endsWith('.mod')) return new Response(
          'module rsc.io/markdown\n\ngo 1.20\n\nrequire (\n'
          + '\tgithub.com/yuin/goldmark v1.6.0 // for testing only\n'
          + '\tgolang.org/x/text v0.3.7\n\tgolang.org/x/tools v0.1.5\n)\n');
        return new Response('', { status: 404 });
      }) as typeof fetch;
      const pseudoCaptures = new GoProxyCaptureStore(pool, pseudoProxy);
      const pseudoCapture = await pseudoCaptures.capture(owner,
        `go-pseudo-${randomUUID()}`, { profile: 'go-module-proxy-capture-v2',
          path: pseudoFixture.source.path, version: pseudoVersion });
      expect(pseudoCapture.capture.manifest.rawSha256)
        .toBe(pseudoFixture.source.capturedManifestSha256);
      const pseudoIncluded = pseudoFixture.includedLookup as IncludedGoSumdbLookup;
      const timeline: string[] = [];
      const pseudoStore = new GoSumdbTrustStore(pool, pseudoCaptures,
        (async () => pseudoIncluded) as ConstructorParameters<typeof GoSumdbTrustStore>[2],
        (async (old, next) => { timeline.push(`${old.size}->${next.size}`); return []; }) as
          ConstructorParameters<typeof GoSumdbTrustStore>[3],
        (async () => latestFixture) as ConstructorParameters<typeof GoSumdbTrustStore>[4]);
      const pseudoCaptureId = pseudoCapture.capture.capture.split('/').at(-1)!;
      const pseudoVerified = await pseudoStore.verify(owner,
        `go-pseudo-verification-${randomUUID()}`, pseudoCaptureId);
      expect(pseudoVerified?.verification).toMatchObject({
        path: pseudoFixture.source.path, version: pseudoVersion,
        goModH1: pseudoFixture.source.officialGoModH1,
        includedTree: pseudoIncluded.tree, trustedTree: pseudoIncluded.tree });
      expect(timeline).toContain(`${latestFixture.tree.size}->${pseudoIncluded.tree.size}`);
      const pseudoId = pseudoVerified!.verification.verification.split('/').at(-1)!;
      expect(await pseudoStore.read(owner, pseudoId)).toEqual(pseudoVerified!.verification);
      const badPseudo = new GoSumdbTrustStore(pool, pseudoCaptures,
        (async () => ({ ...pseudoIncluded, recordSha256: '0'.repeat(64) })) as
          ConstructorParameters<typeof GoSumdbTrustStore>[2],
        (async () => []) as ConstructorParameters<typeof GoSumdbTrustStore>[3],
        (async () => latestFixture) as ConstructorParameters<typeof GoSumdbTrustStore>[4]);
      await expect(badPseudo.verify(owner, `go-pseudo-bad-${randomUUID()}`,
        pseudoCaptureId)).rejects.toThrow(GoSumdbTrustUnavailable);
      const forkedPseudo = new GoSumdbTrustStore(pool, pseudoCaptures,
        (async () => pseudoIncluded) as ConstructorParameters<typeof GoSumdbTrustStore>[2],
        (async () => { throw new Error('tree prefix differs'); }) as
          ConstructorParameters<typeof GoSumdbTrustStore>[3],
        (async () => latestFixture) as ConstructorParameters<typeof GoSumdbTrustStore>[4]);
      await expect(forkedPseudo.verify(owner, `go-pseudo-fork-${randomUUID()}`,
        pseudoCaptureId)).rejects.toThrow(GoSumdbTrustUnavailable);
      expect(await pseudoStore.read(owner, pseudoId)).toEqual(pseudoVerified!.verification);
      await expect(pool.query(`UPDATE pkg.go_sumdb_head SET tree_size = 1
        WHERE server = 'sum.golang.org'`)).rejects.toThrow();
      await expect(pool.query(`UPDATE pkg.go_sumdb_verification
        SET capture_mod_sha256 = $2 WHERE id = $1`,
      [id, '0'.repeat(64)])).rejects.toThrow();
      const bad = new GoSumdbTrustStore(pool, captures,
        (async () => ({ ...included,
          goModH1: `h1:${Buffer.alloc(32).toString('base64')}` })) as
          ConstructorParameters<typeof GoSumdbTrustStore>[2],
        consistency, latestFetch);
      await expect(bad.verify(owner, `go-sumdb-${randomUUID()}`, captureId))
        .rejects.toThrow(GoSumdbTrustUnavailable);
    } finally { await pool.end(); }
  });
