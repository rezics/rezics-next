import type { Pool } from 'pg';
import { ContentCore } from '../../services/content/src/core.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../services/main/src/infrastructure/immutable-objects.ts';
import type { WorkActivationEnvironment } from '../../services/main/src/modules/work/activate.ts';
import { readExactMainRevision, readExactWorkRevision } from '../../services/main/src/modules/work/history.ts';
import { assertPublicTextReady } from '../../services/main/src/modules/work/search-readiness.ts';
import { assertGraphAdmissionOpen } from '../../services/main/src/modules/work/restore-lineage.ts';
import { IMPORT_SEQUENCE, stable } from './corpus.ts';
import type { FixtureManifestCore } from './manifest.ts';
import { WORK_OBJECT_PREFIX } from './owners/objects.ts';

export function workEnvironment(apps: Record<string, string>,
  lineage: FixtureManifestCore['lineage']): WorkActivationEnvironment & { workObjects: S3ImmutableObjects } {
  return { fuseki: new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN, apps.FUSEKI_COMMAND_TOKEN),
    lineage, objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
    workObjects: new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!, bucket: apps.MAIN_S3_BUCKET!,
      region: apps.MAIN_S3_REGION!, accessKeyId: apps.MAIN_S3_ACCESS_KEY!,
      secretAccessKey: apps.MAIN_S3_SECRET_KEY!, prefix: WORK_OBJECT_PREFIX }) };
}

/** Public text readiness through Main's own probe: lineage, control row and Lucene query. */
export async function assertGraphReady(apps: Record<string, string>,
  manifest: Pick<FixtureManifestCore, 'lineage'>): Promise<{ generation: string; sequence: string }> {
  const env = workEnvironment(apps, manifest.lineage);
  await assertGraphAdmissionOpen(env.fuseki, manifest.lineage);
  const index = await assertPublicTextReady(env.fuseki, manifest.lineage);
  await env.workObjects.initialize();
  return { generation: index.generation, sequence: index.sequence };
}

function same(label: string, actual: unknown, expected: unknown): void {
  if (stable(actual) !== stable(expected)) {
    throw new Error(`${label} differs: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

/** Keyed exact reads of the manifest samples through Main, Access and Content owners; no scan. */
export async function checkSamples(apps: Record<string, string>, manifest: FixtureManifestCore,
  pools: { access: Pool; content: Pool }): Promise<number> {
  const env = workEnvironment(apps, manifest.lineage);
  const content = new ContentCore(pools.content);
  const position = { datasetId: 'product', dataEpoch: manifest.lineage.dataEpoch, sequence: IMPORT_SEQUENCE };
  for (const sample of manifest.samples) {
    const work = await readExactWorkRevision(env, sample.workRevision, async id => id === sample.work);
    same(`sample ${sample.index} Work revision`, work, { revision: sample.workRevision, work: sample.work,
      operation: manifest.importOperation, mainVersion: sample.mainVersion, title: sample.title,
      language: 'en', semanticTypes: sample.semanticTypes, sourcePosition: position });
    const main = await readExactMainRevision(env, sample.mainVersion, sample.mainRevision,
      async id => id === sample.work);
    same(`sample ${sample.index} MainVersion revision`, main, { revision: sample.mainRevision,
      mainVersion: sample.mainVersion, work: sample.work, operation: manifest.importOperation,
      hostingPolicy: 'metadata-only', defaultSelection: null, defaultSelections: {}, sourcePosition: position });
    const grant = await pools.access.query(`SELECT 1 FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = 'work.read' AND active
        AND valid_until > clock_timestamp()`, [sample.agent, `work:read:${sample.work}`]);
    if (grant.rowCount !== 1) throw new Error(`sample ${sample.index} Agent read grant is missing`);
    const [exact] = await content.readExactBatch([sample.contentRevision], async ids => new Set(ids));
    if (exact?.status !== 'available') throw new Error(`sample ${sample.index} Content revision is ${exact?.status}`);
    same(`sample ${sample.index} Content revision`, { resource: exact.reference.resourceId,
      variant: exact.reference.variantId, body: exact.body }, { resource: sample.work,
      variant: sample.variant, body: { body: sample.contentBody } });
  }
  return manifest.samples.length;
}
