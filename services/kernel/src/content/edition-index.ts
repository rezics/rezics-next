import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { noEffect, runCommand } from '../command/command.ts';
import { receiptKeysFor } from '../command/receipt-key.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { ContentEditionView } from './edition-model.ts';
import { readCreatorContentEdition, prepareEditionIdentities } from './edition-reads.ts';
import { editionRow, editionSnapshot } from './edition-store.ts';
import { CONTENT_EVENTS } from '../events/contracts/content.ts';
import { lockErasureFence } from './erasure-fence.ts';
import { ContentNotFoundError } from './reads.ts';
import page from './edition-index-page.sql';
import insert from './edition-index-upsert.sql';

export type CreatorEditionPage = Readonly<{
  editions: readonly ContentEditionView[];
  next: string | null;
}>;

type Dependencies = Readonly<{ pool: Pool; access: Access; clock?: () => Date }>;
const created = 'com.rezics.content.edition.created.v1';
export class InvalidCreatorEditionCursorError extends Error {}

/** Candidate homes contain immutable IDs only. All disclosure belongs to the native metadata reader. */
export async function readCreatorEditions(
  deps: Dependencies,
  actor: Actor,
  input: Readonly<{ accountId: string; cursor?: string; limit?: number; identity?: boolean }>,
  context: Readonly<{ deadline: number }>,
): Promise<CreatorEditionPage> {
  const route = routeOf(input.accountId);
  if (actor.kind !== 'account' || actor.accountId !== input.accountId || route === null)
    throw new ContentNotFoundError();
  const requested = input.limit ?? 20;
  if (!Number.isSafeInteger(requested) || requested < 1) throw new RangeError('Invalid edition page limit');
  const limit = Math.min(requested, 20);
  const now = deps.clock?.() ?? new Date();
  // The exact producer interface needs no additional configuration. Derive a dedicated
  // cursor key from the existing pool-bound native key ring, never reuse receipt MACs.
  const native = receiptKeysFor(deps.pool);
  const ring = {
    current: native.current,
    keys: new Map(
      [...native.keys].map(([version, key]) => [
        version,
        createHmac('sha256', key).update('content.creator-editions.list-cursor.v1').digest(),
      ]),
    ),
  };
  const binding = {
    route: 'GET /v1/accounts/{accountId}/editions',
    viewer: actor.accountId,
    query: { accountId: input.accountId, limit },
  };
  const decoded = input.cursor === undefined ? null : await decodeListCursor(ring, binding, input.cursor, now);
  if (
    decoded &&
    (!decoded.ok ||
      decoded.after.length !== 1 ||
      typeof decoded.after[0] !== 'string' ||
      routeOf(decoded.after[0]) === null)
  )
    throw new InvalidCreatorEditionCursorError('Invalid edition cursor');
  const candidates = await editionSnapshot(deps, input.accountId, context, async (client) => {
    const partition = await readPartition(client, partitionOf(route));
    if (!partition || (decoded?.ok && decoded.epoch !== partition.epoch))
      throw new InvalidCreatorEditionCursorError('Stale edition cursor');
    return page.run(client, {
      route,
      creator_account_id: input.accountId,
      after: decoded?.ok ? (decoded.after[0] as string) : '00000000-0000-0000-0000-000000000000',
      limit,
    });
  });
  // Release the home checkout before any source/Access preparation. Never refill
  // skipped rows; continuation advances by the last EXAMINED immutable key.
  const readable: ContentEditionView[] = [];
  const read = async (id: string) => {
    try {
      const result = await readCreatorContentEdition(deps, id, { actor, deadline: context.deadline }, false);
      return result.value.creatorAccountId === input.accountId ? result.value : null;
    } catch (error) {
      if (error instanceof ContentNotFoundError) return null;
      throw error;
    }
  };
  for (const candidate of candidates.value) {
    const current = await read(candidate.edition_id);
    if (current) readable.push(current);
  }
  const identities = input.identity
    ? await prepareEditionIdentities(deps, readable, { actor, deadline: context.deadline })
    : null;
  // Keep the existing final native pass after composition. A fresh refusal drops
  // both edition metadata and its independently authorized identity; never refill.
  const editions: ContentEditionView[] = [];
  for (const candidate of readable) {
    const current = await read(candidate.editionId);
    if (current) editions.push(current);
  }
  const labels = identities ? await identities() : null;
  const last = candidates.value.at(-1);
  return {
    editions: labels ? editions.map((edition) => ({ ...edition, identity: labels.get(edition.editionId)! })) : editions,
    next:
      last && candidates.value.length === limit
        ? await encodeListCursor(ring, binding, { epoch: candidates.anchor.epoch, after: [last.edition_id] }, now)
        : null,
  };
}

/** Committed creation -> released original edition home -> one creator-home command.
 * The candidate confers no metadata, source, sale, delivery or erasure authority. */
export function createCreatorEditionIndexEffect(pool: Pool): Effect {
  return {
    name: 'content_creator_edition',
    types: [created],
    async run(event) {
      if (event.type !== created || !Value.Check(CONTENT_EVENTS[created], event.data))
        throw new TypeError('Invalid creator edition event');
      const data = event.data as { editionId: string; editionRevision: string };
      const route = routeOf(data.editionId);
      const source = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/.exec(event.source);
      const epoch = Number(source?.[2]);
      const position = /^\d{19}$/.test(event.sequence) ? BigInt(event.sequence) : 0n;
      if (
        route === null ||
        !source ||
        Number(source[1]) !== partitionOf(route) ||
        !Number.isSafeInteger(epoch) ||
        epoch > 2147483647 ||
        position <= 0n ||
        position > 9223372036854775807n ||
        event.subject !== data.editionId ||
        data.editionRevision !== '1'
      )
        throw new TypeError('Invalid creator edition event envelope');
      const original = await editionSnapshot(
        { pool },
        data.editionId,
        { deadline: Date.now() + 3000 },
        async (client) => {
          const partition = await readPartition(client, partitionOf(route));
          if (!partition || epoch > partition.epoch || (epoch === partition.epoch && position > partition.position))
            throw new Error('Edition source partition unavailable');
          const row = await editionRow(client, data.editionId);
          if (!row) throw new Error('Edition source missing');
          // Verify this exact committed creation, including its transaction, rather
          // than trusting a caller-supplied creator or an edition-shaped reference.
          const committed = await client.query(
            `SELECT id FROM core.outbox WHERE partition_no=$1 AND epoch=$2 AND position=$3
             AND id=$4 AND type=$5 AND subject=$6 AND data=$7::jsonb
             AND EXISTS (SELECT 1 FROM editorial.write_basis w
               WHERE w.partition_no=$1 AND w.transaction_id=$8 AND w.epoch=$2 AND w.position=$3
                 AND w.principal_kind='account' AND w.principal_id=$9)`,
            [
              partitionOf(route),
              epoch,
              position.toString(),
              event.id,
              created,
              data.editionId,
              JSON.stringify(data),
              row.recorded_transaction_id,
              row.creator_account_id,
            ],
          );
          if (committed.rowCount !== 1) throw new TypeError('Edition creation provenance mismatch');
          return row;
        },
      );
      const creator = original.value.creator_account_id;
      const home = routeOf(creator);
      if (home === null) throw new TypeError('Invalid edition creator');
      await runCommand(pool, { partition: partitionOf(home) }, async (tx) => {
        if (await lockErasureFence(tx, creator)) return noEffect(null);
        const parameters = { route: home, creator_account_id: creator, edition_id: data.editionId };
        const added = await tx.query(
          insert.sql,
          insert.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        if (added.rowCount === 0) return noEffect(null);
        return {
          value: null,
          events: [
            {
              type: 'com.rezics.content.edition.creator-indexed.v1',
              subject: data.editionId,
              data: { editionId: data.editionId, creatorAccountId: creator },
            },
          ],
        };
      });
    },
  };
}
