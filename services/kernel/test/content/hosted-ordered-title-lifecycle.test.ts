import { expect, setDefaultTimeout, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import markAuthorErased from '../../src/content/account-erasure-authored-mark.sql';
import { beginHostedVersionBuilder } from '../../src/content/hosted-version-builder.ts';
import {
  disposeHostedOrderedTitles,
  pageHostedOrderedTitleGenerations,
  redactHostedOrderedTitlePage,
  redactHostedBuilderTitlePage,
} from '../../src/content/hosted-ordered-title-lifecycle.ts';

setDefaultTimeout(360_000);
const context = (idempotencyKey = crypto.randomUUID()) => ({ deadline: Date.now() + 120_000, idempotencyKey });
type Row = Record<string, any>;
function decoded(value: any): any {
  if (value === null) return null;
  if (value.kind === 'object')
    return Object.fromEntries(value.value.map(([key, item]: [string, any]) => [key, decoded(item)]));
  if (value.kind === 'array') return value.value.map(decoded);
  return value.value;
}

test('ordered terminal disposition clears private occurrence and index titles with bounded receipts and retains public generations', async () => {
  const f = await hostedChaptersFixture();
  try {
    const source = await f.native.thread();
    const placements = Array.from({ length: 101 }, (_, index) => ({
      occurrenceId: f.newOccurrenceId(),
      parentId: null,
      position: index,
      title: `Authored title ${index}`,
      ...(index === 100 ? { kind: 'chapter', target: f.target(source) } : { kind: 'part' }),
    }));
    const created = await f.native.call('POST', '/v1/hostedCatalogues', {
      postId: f.catalogueId,
      threadId: f.threadId,
      placements,
    });
    expect(created.status, JSON.stringify(created.value)).toBe(201);
    const published = await f.native.call('POST', `/v1/hostedCatalogues/${f.catalogueId}:publish`, {
      expectedRevisionId: created.value.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [placements[100]!.occurrenceId],
    });
    expect(published.status, JSON.stringify(published.value)).toBe(200);
    const pool = f.native.pool;
    const route = routeOf(f.catalogueId)!;
    const anchor = { catalogueId: f.catalogueId, authorAccountId: f.native.author.actor.accountId };
    const inputId = f.newOccurrenceId();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Seed retained receiving metadata, never publication authority, from these authored fixture points.
      await client.query(
        `INSERT INTO content.hosted_migration_input
         (route,catalogue_id,input_id,owner_account_id,source_revision_id,source_kind,base_revision_id,
          base_placement_count,base_root_count,source_high_water,expected_placement_count,frontier_segment,
          state,expires_at,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,'snapshot',$5,101,101,-1,101,'base','open',
                clock_timestamp()+interval '30 days',clock_timestamp(),clock_timestamp())`,
        [route, f.catalogueId, inputId, anchor.authorAccountId, created.value.revisionId],
      );
      await beginHostedVersionBuilder(client as Parameters<typeof beginHostedVersionBuilder>[0], {
        inputId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        source: {
          catalogueId: f.catalogueId,
          revisionId: created.value.revisionId,
          kind: 'snapshot',
          baseRevisionId: created.value.revisionId,
          basePlacementCount: '101',
          baseRootCount: '101',
          highWater: '-1',
          expectedPlacementCount: '101',
        },
        frontier: { segment: 'base', afterOrdinal: -1 },
      });
      await client.query(
        `INSERT INTO content.hosted_version_builder_point
         (route,catalogue_id,input_id,source_ordinal,address_segment,source_revision_id,source_address_ordinal,
          occurrence_id,parent_id,position,kind,title,target_thread_id,target_post_id,target_revision_id,target_sha256)
         SELECT $1,$2,$3,point.ordinal,'base',$4,point.ordinal,point.occurrence_id,NULL,point.ordinal,
                point.kind,point.title,point.thread_id,point.post_id,point.revision_id,
                CASE WHEN point.sha256 IS NULL THEN NULL ELSE decode(point.sha256,'hex') END
         FROM jsonb_to_recordset($5::jsonb) point
           (ordinal bigint,occurrence_id uuid,kind text,title text,thread_id uuid,post_id uuid,revision_id uuid,sha256 text)`,
        [
          route,
          f.catalogueId,
          inputId,
          created.value.revisionId,
          JSON.stringify(
            placements.map((point, ordinal) => ({
              ordinal,
              occurrence_id: point.occurrenceId,
              kind: point.kind,
              title: point.title,
              ...(point.kind === 'chapter'
                ? {
                    thread_id: source.id,
                    post_id: source.firstPost.id,
                    revision_id: source.firstPost.revisionId,
                    sha256: f.target(source).sha256,
                  }
                : {}),
            })),
          ),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const beforeBuilder = (
      await pool.query<Row>(
        'SELECT * FROM content.hosted_version_builder_point WHERE route=$1 AND catalogue_id=$2 ORDER BY input_id,source_ordinal',
        [route, f.catalogueId],
      )
    ).rows;
    const rows = async (table: 'hosted_occurrence_state_version' | 'hosted_order_node_version') =>
      (
        await pool.query<Row>(
          `SELECT * FROM content.${table} WHERE route=$1 AND catalogue_id=$2 ORDER BY 1,2,3,4,5,6`,
          [route, f.catalogueId],
        )
      ).rows;
    const beforeOccurrences = await rows('hosted_occurrence_state_version');
    const beforeNodes = await rows('hosted_order_node_version');
    expect(beforeOccurrences.length).toBeGreaterThan(100);
    expect(beforeNodes.length).toBeGreaterThan(100);
    await expect(pageHostedOrderedTitleGenerations(pool, anchor, { afterGeneration: null }, context())).rejects.toThrow(
      'terminal native authority',
    );
    await expect(
      redactHostedBuilderTitlePage(pool, anchor, { afterInput: null, afterOrdinal: null }, context()),
    ).rejects.toThrow('terminal native authority');
    const runtime = accountDeletionRuntime(f.native.system);
    await deletePersona(
      { version: 1, pool, auth: runtime.auth },
      { accountId: anchor.authorAccountId, bearer: f.native.author.bearer },
    );
    await markAuthorErased.run(pool, {
      route,
      account_id: anchor.authorAccountId,
      item_kind: 'post',
      item_id: f.catalogueId,
    });

    const inventory = await pageHostedOrderedTitleGenerations(pool, anchor, { afterGeneration: null }, context());
    const selectedGenerations = (
      await pool.query<{ revision_id: string; generation_id: string }>(
        `SELECT revision_id,generation_id FROM content.hosted_version_revision
       WHERE route=$1 AND catalogue_id=$2 AND revision_id=ANY($3::uuid[])`,
        [route, f.catalogueId, [created.value.revisionId, published.value.revisionId]],
      )
    ).rows;
    const draftId = selectedGenerations.find((row) => row.revision_id === created.value.revisionId)!.generation_id;
    const releaseId = selectedGenerations.find((row) => row.revision_id === published.value.revisionId)!.generation_id;
    const privateGeneration = inventory.value.items.find(
      (item) => item.generationId === draftId && !item.retainedPublic,
    )!;
    const publicGeneration = inventory.value.items.find(
      (item) => item.generationId === releaseId && item.retainedPublic,
    )!;
    expect(privateGeneration).toBeDefined();
    expect(publicGeneration).toBeDefined();
    const cursor = {
      generationId: privateGeneration.generationId,
      storage: 'occurrence' as const,
      afterIndex: null,
      afterId: null,
      afterSequence: null,
    };
    const firstContext = context();
    const first = await redactHostedOrderedTitlePage(pool, anchor, cursor, firstContext);
    expect(first.value.items).toHaveLength(100);
    expect(first.value.items.every((item) => item.changed)).toBe(true);
    expect(first.value.next).not.toBeNull();
    let interrupted = false;
    await expect(
      disposeHostedOrderedTitles(
        pool,
        anchor,
        () => Date.now() + 120_000,
        async (name, action) => {
          const result = await action();
          if (!interrupted && name.includes(':ordered-titles:')) {
            interrupted = true;
            throw new Error('Stopped after committed ordered page');
          }
          return result;
        },
      ),
    ).rejects.toThrow('Stopped after committed ordered page');
    await disposeHostedOrderedTitles(
      pool,
      anchor,
      () => Date.now() + 120_000,
      async (_name, action) => {
        const result = await action();
        const items = (result as { value: { items: readonly unknown[] } }).value.items;
        expect(items.length).toBeLessThanOrEqual(100);
        return result;
      },
    );
    expect(await redactHostedOrderedTitlePage(pool, anchor, cursor, firstContext)).toMatchObject({
      value: first.value,
    });
    const retained = await redactHostedOrderedTitlePage(
      pool,
      anchor,
      { ...cursor, generationId: publicGeneration.generationId },
      context(),
    );
    expect(retained.value.items.every((item) => !item.changed)).toBe(true);
    const afterBuilder = (
      await pool.query<Row>(
        'SELECT * FROM content.hosted_version_builder_point WHERE route=$1 AND catalogue_id=$2 ORDER BY input_id,source_ordinal',
        [route, f.catalogueId],
      )
    ).rows;
    expect(afterBuilder).toHaveLength(101);
    afterBuilder.forEach((row, index) =>
      expect(row).toEqual({ ...beforeBuilder[index], title: null, title_redacted: true }),
    );
    await expect(
      pool.query(
        `UPDATE content.hosted_version_builder_point SET title='Restored',title_redacted=false
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND source_ordinal=0`,
        [route, f.catalogueId, inputId],
      ),
    ).rejects.toThrow('one-way title redaction');
    await expect(
      pool.query(
        `UPDATE content.hosted_occurrence_state_version
       SET occurrence_state=content.redact_hosted_ordered_title(occurrence_state,false),title_redacted=true
       WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3`,
        [route, f.catalogueId, publicGeneration.generationId],
      ),
    ).rejects.toThrow('Published hosted ordered labels are immutable');

    const publicIds = new Set(
      inventory.value.items.filter((item) => item.retainedPublic).map((item) => item.generationId),
    );
    for (const [table, before, payload] of [
      ['hosted_occurrence_state_version', beforeOccurrences, 'occurrence_state'],
      ['hosted_order_node_version', beforeNodes, 'node_state'],
    ] as const) {
      const after = await rows(table);
      expect(after).toHaveLength(before.length);
      for (let index = 0; index < before.length; index++) {
        const old = before[index]!,
          current = after[index]!;
        if (publicIds.has(old.generation_id)) {
          expect(current).toEqual(old);
          continue;
        }
        const { [payload]: oldPayload, title_redacted: _oldFlag, ...oldIdentity } = old;
        const { [payload]: currentPayload, title_redacted: flag, ...currentIdentity } = current;
        expect(currentIdentity).toEqual(oldIdentity);
        const original = decoded(oldPayload),
          redacted = decoded(currentPayload);
        const originalValue = table === 'hosted_order_node_version' ? original?.value : original;
        const redactedValue = table === 'hosted_order_node_version' ? redacted?.value : redacted;
        if (typeof originalValue?.title === 'string') {
          expect(flag).toBe(true);
          expect(redactedValue).toEqual({ ...originalValue, title: null });
          if (table === 'hosted_order_node_version') expect(redacted).toEqual({ ...original, value: redactedValue });
        } else expect(currentPayload).toEqual(oldPayload);
      }
    }
    const privateRow = beforeOccurrences.find((row) => row.generation_id === privateGeneration.generationId)!;
    await expect(
      pool.query(
        `UPDATE content.hosted_occurrence_state_version SET occurrence_state=$5,title_redacted=false
       WHERE route=$1 AND catalogue_id=$2 AND generation_id=$3 AND occurrence_id=$4`,
        [route, f.catalogueId, privateGeneration.generationId, privateRow.occurrence_id, privateRow.occurrence_state],
      ),
    ).rejects.toThrow('one-way title redaction');
    await expect(
      pool.query(
        `INSERT INTO content.hosted_occurrence_state_version
       (route,catalogue_id,generation_id,occurrence_id,sequence,parent_occurrence_id,subtree_size,occurrence_state,is_deleted,subtree_height)
       VALUES($1,$2,$3,$4,1000000,$5,$6,$7,false,$8)`,
        [
          route,
          f.catalogueId,
          privateGeneration.generationId,
          privateRow.occurrence_id,
          privateRow.parent_occurrence_id,
          privateRow.subtree_size,
          privateRow.occurrence_state,
          privateRow.subtree_height,
        ],
      ),
    ).rejects.toThrow('cannot be inserted after terminal authority');
  } finally {
    await f.close();
  }
});
