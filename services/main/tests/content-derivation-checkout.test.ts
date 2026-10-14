import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ContentCore } from '../../content/src/core.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode }
  from '../src/infrastructure/pg-pool.ts';
import { publicDomainRevisionCurrent } from '../src/modules/content-publication/public-domain-read.ts';
import { MediaStore } from '../src/modules/media/store.ts';
import { RightsStore } from '../src/modules/rights/store.ts';

test('derivation proofs share one Content client with Media references and public-domain rights on creation and replay', async () => {
  const cluster = await startPostgresCluster();
  const previousMode = nestedPoolCheckoutMode(); setNestedPoolCheckoutMode('throw');
  const pool = boundedPool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  try {
    await migrateContent(pool);
    const content = new ContentCore(pool), media = new MediaStore(pool, content), rights = new RightsStore(pool, pool);
    const target = `https://rezics.com/id/${randomUUID()}`, variantId = `urn:rezics:variant:${randomUUID()}`;
    const saved = await content.saveDraft({ operationId: randomUUID(),
      variant: { id: variantId, resourceId: target, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null, provenance: {},
      serializedJson: JSON.stringify({ body: 'Exact source' }) });
    const revision = saved.revisionId!;
    const selected = { target, selector: { grain: 'content' as const, variantId, revision } };
    const asset = randomUUID(), representation = randomUUID(), assessment = randomUUID();
    const record = () => content.derivations.record('shared-owner-proof', {
      output: selected, inputs: [selected], activity: { kind: 'transformation' }, expectedOutputHead: revision,
      responsibleAgent: target,
    }, 'human', async client => {
      await expect(media.readAsset(asset)).rejects.toBeInstanceOf(NestedPoolCheckoutError);
      await media.withSummaryClient(client, async () => {
        expect(await media.readAsset(asset)).toBeNull();
        expect(await media.referenceSelection(asset, revision, representation)).toBeNull();
      });
      const exact = (await content.readExactBatch([revision], async ids => new Set(ids), client))[0];
      if (exact?.status !== 'available') throw new Error('fixture Content revision is unavailable');
      expect(await publicDomainRevisionCurrent({ ...exact.reference,
        provenance: { kind: 'admitted-public-domain-v1', rightsAssessmentId: assessment } }, rights, client)).toBe(false);
    });
    expect((await record()).replayed).toBe(false);
    expect((await record()).replayed).toBe(true);
  } finally { await pool.end(); cluster.remove(); setNestedPoolCheckoutMode(previousMode); }
}, 60_000);
