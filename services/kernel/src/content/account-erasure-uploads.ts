import { memoizedValue } from '../memoized.ts';
import type { Pool } from 'pg';
import { createAccess } from '../access/index.ts';
import { withConnection } from '../database/pool.ts';
import { runCommand, noEffect } from '../command/command.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { recordLateErasureItem, resolveLateErasureItem } from '../access/erasure.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readDocument } from './document-read.ts';
import type { MediaStorage } from './media-storage.ts';
import type { MediaId } from './model.ts';
import erase from './erase-content.sql';
import eraseField from './erase-authored-field.sql';
import page from './account-erasure-uploads-page.sql';
import add from './account-erasure-uploads-add.sql';
import remove from './account-erasure-uploads-remove.sql';
import readMedia from './account-erasure-uploads-media.sql';
import readPost from './account-erasure-uploads-post.sql';
import { purgeObject } from './erasure-job.ts';
import { lockErasureFence } from './erasure-fence.ts';
import { markAccountErasureFound, noteAccountErasureFound } from './account-erasure-progress.ts';

export type UploadErasureCursor = Readonly<{ phase: 'media' | 'fields'; after: string | null }>;
const pageSize = 50;
const first = '00000000-0000-0000-0000-000000000000';
function access() {
  return memoizedValue(access, () => createAccess({ actions: new Map([['subject:read', { anonymous: true }]]) }));
}

function route(id: string): number {
  const result = routeOf(id);
  if (result === null) throw new TypeError('Invalid account upload erasure identity');
  return result;
}

type UploadDisposition = 'absent' | 'erased' | 'retained' | 'pending';

/** Apply one upload locator's disposition. The caller removes its locator only after
 * the disposition is complete; an erased media prefix is therefore the delivery proof.
 */
export async function eraseAccountUploadItem(
  deps: { pool: Pool; storage: MediaStorage },
  accountId: string,
  phase: 'media' | 'fields',
  id: string,
): Promise<UploadDisposition> {
  const sourceRoute = route(id);
  if (phase === 'media') {
    const source = await withConnection(deps.pool, async (client) => {
      const anchor = await readPartition(client, partitionOf(sourceRoute));
      if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
      return readMedia.run(client, { route: sourceRoute, id });
    });
    if (!source || source.uploader_id !== accountId) return 'absent';
    if (source.erased) {
      await purgeObject(deps.pool, deps.storage, id as MediaId);
      return 'erased';
    }
    if (source.collection_pending) return 'pending';
    // A native permanent Realm claim uses the existing retained-upload disposition.
    // The locator remains available to the ordinary account-erasure proof pass.
    if (source.claimed_realm_id) return 'retained';
    if (source.claimed_item_id) {
      const post = await withConnection(deps.pool, async (client) => {
        const anchor = await readPartition(client, partitionOf(sourceRoute));
        if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
        return readPost.run(client, { route: sourceRoute, id: source.claimed_item_id! });
      });
      if (post?.availability === 'available' && post.visibility === 'published') return 'retained';
      if (post?.availability !== 'erased') return 'pending';
    }
    await runCommand(deps.pool, { partition: partitionOf(sourceRoute) }, async (tx) => {
      const parameters = { kind: 'media', route: sourceRoute, id, deleted_at: null };
      await tx.query(
        erase.sql,
        erase.params.map((name) => parameters[name as keyof typeof parameters]),
      );
      return noEffect(null);
    });
    await purgeObject(deps.pool, deps.storage, id as MediaId);
    return 'erased';
  }

  const visible = await readDocument({ pool: deps.pool, access: access(), routeKey: new Uint8Array() }, id, {
    actor: { kind: 'anonymous' },
    deadline: Date.now() + 30_000,
  });
  if (visible) return 'retained';
  await runCommand(deps.pool, { partition: partitionOf(sourceRoute) }, async (tx) => {
    await eraseField.run(tx, { route: sourceRoute, id, author_id: accountId });
    return noEffect(null);
  });
  return 'erased';
}

/** Platform cleanup under the committed account-erasure obligation. Locator reads and
 * source writes are separate partition commands; no connection crosses that boundary. */
export async function eraseAccountUploadsPage(
  deps: { pool: Pool; storage: MediaStorage },
  accountId: string,
  cursor: UploadErasureCursor | null,
): Promise<{ next: UploadErasureCursor | null; found: number; pending: number }> {
  const home = route(accountId);
  if (cursor && cursor.phase !== 'media' && cursor.phase !== 'fields') throw new TypeError('Invalid upload cursor');
  if (cursor?.after) route(cursor.after);
  const phase = cursor?.phase ?? 'media';
  const after = cursor?.after ?? first;
  const rows = await runCommand(deps.pool, { partition: partitionOf(home) }, async (tx) =>
    noEffect(await page.run(tx, { route: home, account_id: accountId, phase, after, limit: pageSize })),
  );
  const keys = rows.value;
  if (keys.length) await noteAccountErasureFound(deps, accountId, phase === 'media' ? 'delivery' : 'content');
  let pending = 0;
  const pendingIds = new Set<string>();
  const retained = new Set<string>();
  for (const key of keys) {
    if (phase === 'media') {
      const disposition = await eraseAccountUploadItem(deps, accountId, phase, key.id);
      if (disposition === 'retained') retained.add(key.id);
      if (disposition === 'pending') {
        pending++;
        pendingIds.add(key.id);
      }
    } else {
      if ((await eraseAccountUploadItem(deps, accountId, phase, key.id)) === 'retained') retained.add(key.id);
    }
  }
  const found = keys.length;
  let next: UploadErasureCursor | null = null;
  if (found === pageSize) next = { phase, after: keys.at(-1)!.id };
  else if (phase === 'media') next = { phase: 'fields', after: null };
  if (phase === 'media' || phase === 'fields') {
    await runCommand(deps.pool, { partition: partitionOf(home) }, async (tx) => {
      await remove.run(tx, {
        route: home,
        account_id: accountId,
        phase,
        ids: keys.filter((r) => !retained.has(r.id) && !pendingIds.has(r.id)).map((r) => r.id),
      });
      return noEffect(null);
    });
  }
  return { next, found, pending };
}

/** Event projection keeps account-home ownership seeks independent of source-partition growth. */
export function createAccountUploadIndexEffect(pool: Pool, storage?: MediaStorage): Effect {
  const types = ['com.rezics.content.media.reserved.v1', 'com.rezics.content.authored-field.created.v1'];
  return {
    name: 'content_account_upload_index',
    types,
    async run(event: CloudEvent) {
      const data = event.data as Record<string, unknown>;
      const id = (data.mediaId ?? data.id) as string;
      const accountId = (data.actorId ?? data.authorId) as string;
      route(id);
      const accountRoute = route(accountId);
      const phase = event.type === types[0] ? 'media' : 'fields';
      const locator = `${phase}:${id}`;
      const result = await runCommand(pool, { partition: partitionOf(accountRoute) }, async (tx) => {
        if (await lockErasureFence(tx, accountId)) {
          await recordLateErasureItem(tx, { accountId, participant: 'content', locator });
          await markAccountErasureFound(tx, accountId, phase === 'media' ? 'delivery' : 'content');
          return {
            value: true,
            events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
          };
        }
        await add.run(tx, { route: accountRoute, account_id: accountId, phase, id });
        return noEffect(false);
      });
      if (result.value) {
        if (!storage) throw new Error('Late account upload erasure requires media storage');
        for (;;) {
          const disposition = await eraseAccountUploadItem({ pool, storage }, accountId, phase, id);
          if (disposition !== 'pending') break;
          await DBOS.sleep(600_000);
        }
        await resolveLateErasureItem({ pool }, { accountId, participant: 'content', locator });
      }
    },
  };
}
