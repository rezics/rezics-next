import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  executeHostedLifecyclePage,
  type HostedLifecycleAnchor,
  type HostedLifecycleContext,
} from './hosted-append-lifecycle.ts';
import type { HostedDispositionStep } from './account-erasure-authored-hosted.ts';
import generations from './hosted-ordered-title-generations.sql';
import occurrences from './hosted-ordered-title-occurrences.sql';
import nodes from './hosted-ordered-title-nodes.sql';
import builder from './hosted-ordered-title-builder.sql';

type GenerationCursor = Readonly<{ afterGeneration: string | null }>;
type TitleCursor = Readonly<{
  generationId: string;
  storage: 'occurrence' | 'node';
  afterIndex: string | null;
  afterId: string | null;
  afterSequence: string | null;
}>;
type GenerationRow = { generation_id: string; retained_public: boolean };
type TitleRow = { index_kind?: string; row_id: string; sequence: string; changed: boolean };
type BuilderCursor = Readonly<{ afterInput: string | null; afterOrdinal: string | null }>;

export function pageHostedOrderedTitleGenerations(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  cursor: GenerationCursor,
  context: HostedLifecycleContext,
) {
  anchor = structuredClone(anchor);
  cursor = structuredClone(cursor);
  return executeHostedLifecyclePage(
    pool,
    anchor,
    { kind: 'ordered-generations', cursor },
    context,
    async (tx, route) => {
      const parameters = { route, catalogue_id: anchor.catalogueId, after_generation: cursor.afterGeneration };
      const rows = (
        await tx.query<GenerationRow>(
          generations.sql,
          generations.params.map((name) => parameters[name as keyof typeof parameters]),
        )
      ).rows;
      return {
        changed: false,
        value: {
          items: rows.map((row) => ({ generationId: row.generation_id, retainedPublic: row.retained_public })),
          next: rows.length === 100 ? { afterGeneration: rows.at(-1)!.generation_id } : null,
        },
      };
    },
  );
}

export function redactHostedOrderedTitlePage(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  cursor: TitleCursor,
  context: HostedLifecycleContext,
) {
  anchor = structuredClone(anchor);
  cursor = structuredClone(cursor);
  return executeHostedLifecyclePage(pool, anchor, { kind: 'ordered-titles', cursor }, context, async (tx, route) => {
    const query = cursor.storage === 'occurrence' ? occurrences : nodes;
    const parameters = {
      route,
      catalogue_id: anchor.catalogueId,
      generation_id: cursor.generationId,
      after_index: cursor.afterIndex,
      after_id: cursor.afterId,
      after_sequence: cursor.afterSequence,
    };
    const rows = (
      await tx.query<TitleRow>(
        query.sql,
        query.params.map((name) => parameters[name as keyof typeof parameters]),
      )
    ).rows;
    const last = rows.at(-1);
    return {
      changed: rows.some((row) => row.changed),
      value: {
        items: rows.map((row) => ({ id: row.row_id, sequence: row.sequence, changed: row.changed })),
        next:
          rows.length === 100 && last
            ? { ...cursor, afterIndex: last.index_kind ?? null, afterId: last.row_id, afterSequence: last.sequence }
            : null,
      },
    };
  });
}

export function redactHostedBuilderTitlePage(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  cursor: BuilderCursor,
  context: HostedLifecycleContext,
) {
  anchor = structuredClone(anchor);
  cursor = structuredClone(cursor);
  return executeHostedLifecyclePage(
    pool,
    anchor,
    { kind: 'ordered-titles', cursor: { storage: 'builder', ...cursor } },
    context,
    async (tx, route) => {
      const parameters = {
        route,
        catalogue_id: anchor.catalogueId,
        after_input: cursor.afterInput,
        after_ordinal: cursor.afterOrdinal,
      };
      const rows = (
        await tx.query<{ input_id: string; source_ordinal: string; changed: boolean }>(
          builder.sql,
          builder.params.map((name) => parameters[name as keyof typeof parameters]),
        )
      ).rows;
      const last = rows.at(-1);
      return {
        changed: rows.some((row) => row.changed),
        value: {
          items: rows.map((row) => ({ inputId: row.input_id, ordinal: row.source_ordinal, changed: row.changed })),
          next: rows.length === 100 && last ? { afterInput: last.input_id, afterOrdinal: last.source_ordinal } : null,
        },
      };
    },
  );
}

/** Each range has the existing terminal admission and exact native command receipt. */
export async function disposeHostedOrderedTitles(
  pool: Pool,
  anchor: HostedLifecycleAnchor,
  deadline: () => number,
  step: HostedDispositionStep = (_name, action) => action(),
): Promise<void> {
  anchor = structuredClone(anchor);
  const page = <T>(kind: string, cursor: unknown, run: (context: HostedLifecycleContext) => Promise<T>) => {
    const key = createHash('sha256')
      .update(JSON.stringify([anchor.catalogueId, anchor.authorAccountId, kind, cursor]))
      .digest('hex');
    return step(`hosted:${anchor.catalogueId}:${kind}:${key}`, () =>
      run({ deadline: deadline(), idempotencyKey: key }),
    );
  };
  let cursor: GenerationCursor = { afterGeneration: null };
  for (;;) {
    const inventory = await page('ordered-generations', cursor, (context) =>
      pageHostedOrderedTitleGenerations(pool, anchor, cursor, context),
    );
    for (const generation of inventory.value.items) {
      if (generation.retainedPublic) continue;
      for (const storage of ['occurrence', 'node'] as const) {
        let titles: TitleCursor = {
          generationId: generation.generationId,
          storage,
          afterIndex: null,
          afterId: null,
          afterSequence: null,
        };
        for (;;) {
          const result = await page('ordered-titles', titles, (context) =>
            redactHostedOrderedTitlePage(pool, anchor, titles, context),
          );
          if (!result.value.next) break;
          titles = result.value.next;
        }
      }
    }
    if (!inventory.value.next) break;
    cursor = inventory.value.next;
  }
  let receiving: BuilderCursor = { afterInput: null, afterOrdinal: null };
  for (;;) {
    const result = await page('ordered-titles', { storage: 'builder', ...receiving }, (context) =>
      redactHostedBuilderTitlePage(pool, anchor, receiving, context),
    );
    if (!result.value.next) break;
    receiving = result.value.next;
  }
}
