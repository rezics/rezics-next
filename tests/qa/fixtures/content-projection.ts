import { Pool } from 'pg';
import { resolve } from 'node:path';
import { applyQaSqlMigrations } from '../../../scripts/qa/bootstrap.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import type { ContentCore } from '../../../services/content/src/core.ts';
import type { ContentProjectionCursor } from '../../../services/content/src/projection-cursor.ts';
import { contentRebuildDelivery } from '../../../services/main/src/modules/content-publication/rebuild-preflight.ts';
import { relayContentProjectionOnce } from '../../../services/main/src/modules/content-publication/relay.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const migrated = new Set<string>();

/** Exercise the production Main handoff before taking a Content source cut.
 * A graph approval alone cannot authorize the Content projection worker. */
export async function deliverFixtureContentEligibility(env: WorkActivationEnvironment,
  content: ContentCore, relayUrl = Bun.env.MAIN_RELAY_DATABASE_URL) {
  if (!relayUrl) throw new Error('Content fixture requires the Main relay database');
  const pool = new Pool({ connectionString: relayUrl, max: 2 });
  try {
    if (!migrated.has(relayUrl)) {
      const exists = await pool.query("SELECT to_regclass('relay.checkpoint') IS NOT NULL AS ready");
      if (!exists.rows[0]?.ready) {
        const root = resolve(import.meta.dir, '../../..');
        await applyQaSqlMigrations(relayUrl, resolve(root, 'services/main/migrations/relay'), schemaFiles(root, 'relay'));
      }
      migrated.add(relayUrl);
    }
    const delivery = contentRebuildDelivery(env, content, pool, 'fixture-content-eligibility');
    let through = await delivery.relayPosition();
    for (let n = 0; ; n++) {
      if (n >= 10_000) throw new Error('Content fixture Main handoff exceeded its preparation bound');
      const next = await delivery.relayOnce();
      if (next === null) break;
      through = next;
    }
    while (await delivery.deliveryPosition() !== through) {
      if (await delivery.deliverOnce(through) === null) {
        throw new Error('Content fixture eligibility delivery stopped before Main handoff');
      }
    }
  } finally { await pool.end(); }
  await content.sequencePending();
}

export async function settleFixtureContentProjection(env: WorkActivationEnvironment,
  content: ContentCore, cursor: ContentProjectionCursor, consumer: string, relayUrl?: string) {
  await deliverFixtureContentEligibility(env, content, relayUrl);
  const cut = await content.ownerPosition();
  await cursor.initialize(consumer);
  for (let n = 0; (await cursor.read(consumer)).sequence !== cut.sequence; n++) {
    if (n >= 10_000 || !await relayContentProjectionOnce(env, content, cursor, consumer)) {
      throw new Error('Content fixture projection stopped before delivered source cut');
    }
  }
  return cut;
}
