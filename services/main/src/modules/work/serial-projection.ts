import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { logWorkerFault } from '@rezics/observability/log';
import { withWorkerTelemetry } from '@rezics/observability/runtime';
import { runWorkerTick } from '../../worker-tick.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { PUBLIC_SEARCH_GRAPH } from './select-main.ts';
import { publicWork } from './public-patterns.ts';
import { discloseInventory, hasDisclosure, type DisclosureTarget } from '../disclosure/read.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';

const SOURCE = 'https://rezics.com/services/main';
const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const CONTENT_REVISION = /^urn:rezics:content:revision:[0-9a-f-]{36}$/;
export const SERIAL_COST = {
  sourceBatches: 1,
  maxChapters: 1000,
  maxVariants: 2000,
  maxAffectedWorks: 20,
  maxBodyCharacters: 1_000_000,
  summaryBatch: 512,
  disclosureChildren: 1024,
  cleanupRows: 500,
  pollMs: 500,
} as const;
export class SerialProjectionUnavailable extends Error {}
interface Chapter {
  occurrence: string;
  resource: string;
  variant: string | null;
  revision: string | null;
}
interface StructureSnapshot {
  structure: string;
  work: string;
  chapters: Chapter[] | null;
}
interface RelayEvent {
  type: string;
  data?: { receipt?: Record<string, unknown> };
}

/** Intl word segmentation handles both space-delimited and CJK text. */
export function countSerialWords(value: string): number {
  if (value.length > SERIAL_COST.maxBodyCharacters)
    throw new SerialProjectionUnavailable('Chapter text exceeds word budget');
  const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
  let count = 0;
  for (const item of segmenter.segment(value)) if (item.isWordLike) count++;
  return count;
}

/** Bounded relay consumer. Source rows are immutable and one Access transaction
 * writes chapter membership, Content words, summary and checkpoint together. */
export class SerialStatisticsProjection {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;
  constructor(
    private readonly access: Pool,
    private readonly relay: Pool,
    private readonly content: Pool,
    private readonly env: WorkActivationEnvironment,
  ) {}

  private async sourceTime(
    receipt: Record<string, unknown>,
    kind: 'structure' | 'content',
  ): Promise<Date> {
    const stage = receipt.stageId;
    const epoch = receipt.ownerDataEpoch,
      sequence = receipt.ownerSequence;
    if (
      (kind === 'structure' && (typeof stage !== 'string' || !/^[0-9a-f-]{36}$/.test(stage))) ||
      (kind === 'content' &&
        (typeof epoch !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(epoch) ||
          typeof sequence !== 'string' ||
          !/^[1-9][0-9]*$/.test(sequence)))
    ) {
      throw new SerialProjectionUnavailable('Serial event has no stable owner time');
    }
    const row =
      kind === 'structure'
        ? (
            await this.content.query<{ created_at: Date }>(
              `SELECT created_at FROM structure.stage_job WHERE id = $1::uuid`,
              [stage],
            )
          ).rows[0]
        : (
            await this.content.query<{ created_at: Date }>(
              `SELECT created_at FROM content.receipt WHERE data_epoch = $1::uuid AND sequence = $2::bigint`,
              [epoch, sequence],
            )
          ).rows[0];
    if (!row?.created_at)
      throw new SerialProjectionUnavailable('Serial source time is unavailable');
    return row.created_at;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = runWorkerTick('main.serial.projection', () => withWorkerTelemetry('main.serial.projection', () => this.tick(), count => ({
        outcome: count ? 'worked' : 'idle', processed: count, unit: 'batch',
      })))
        .catch((error) => {
          logWorkerFault('main.serial.projection', error);
        })
        .finally(() => {
          this.running = undefined;
        });
    }, SERIAL_COST.pollMs);
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async structure(structure: string): Promise<StructureSnapshot | null> {
    if (!ID.test(structure)) throw new SerialProjectionUnavailable('Invalid Structure event');
    const rows =
      (
        await this.env.fuseki.query(
          `PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/> SELECT ?work ?occurrence ?chapter ?variant ?revision WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(this.env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(this.env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(structure)} a rv:Structure ; rv:structureOf ?main ; rv:selectedGeneration ?generation .
        ?main rv:work ?work .
        OPTIONAL { ?placement a rv:OccurrencePlacement ; rv:generation ?generation ;
          rv:occurrence ?occurrence ; rv:occurrenceRole rv:ChapterRole ; schema:item ?chapter .
          FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
          OPTIONAL { ?variant a rv:ContentVariant ; rv:resource ?chapter ;
            rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility .
            GRAPH ${iri(GRAPHS.revisions)} {
              ?eligibility a rv:ContentSearchEligibilityDecision ;
                rv:publicationDecision ?publication ; rv:disclosure rv:Public .
              ?publication rv:contentRevision ?revision .
              FILTER NOT EXISTS { ?revision a rv:ErasedRevision } } }
          FILTER(BOUND(?variant) || EXISTS { ${publicWork('?chapter', '?chapterMain')} }) }
      }
    } LIMIT ${SERIAL_COST.maxVariants + 1}`,
          512 * 1024,
        )
      ).results?.bindings ?? [];
    if (!rows.length) return null;
    const work = rows[0]?.work?.value;
    if (!work || !ID.test(work) || rows.some((row) => row.work?.value !== work)) {
      throw new SerialProjectionUnavailable('Structure Work relation is ambiguous');
    }
    if (rows.length > SERIAL_COST.maxVariants) return { structure, work, chapters: null };
    const chapters = new Map<string, Chapter>();
    for (const row of rows) {
      if (!row.occurrence) continue;
      const occurrence = row.occurrence.value,
        resource = row.chapter?.value;
      const variant = row.variant?.value ?? null,
        revision = row.revision?.value ?? null;
      if (
        !ID.test(occurrence) ||
        !resource ||
        !ID.test(resource) ||
        (variant !== null && !variant.startsWith('urn:rezics:variant:')) ||
        (revision !== null && !CONTENT_REVISION.test(revision))
      ) {
        throw new SerialProjectionUnavailable('Chapter relation is incomplete');
      }
      const prior = chapters.get(occurrence);
      if (prior && prior.resource !== resource)
        throw new SerialProjectionUnavailable('Occurrence has two targets');
      if (!prior || (variant !== null && (prior.variant === null || variant < prior.variant))) {
        chapters.set(occurrence, { occurrence, resource, variant, revision });
      }
    }
    return {
      structure,
      work,
      chapters: chapters.size > SERIAL_COST.maxChapters ? null : [...chapters.values()],
    };
  }

  private async contentWord(
    receipt: Record<string, unknown>,
  ): Promise<{ resource: string; variant: string; revision: string; words: number } | null> {
    const { resource, variant, contentRevision, matchUnit } = receipt;
    if (
      typeof resource !== 'string' ||
      !ID.test(resource) ||
      typeof variant !== 'string' ||
      !variant.startsWith('urn:rezics:variant:') ||
      typeof contentRevision !== 'string' ||
      !CONTENT_REVISION.test(contentRevision) ||
      typeof matchUnit !== 'string' ||
      !matchUnit.startsWith('urn:rezics:content:match-unit:')
    ) {
      throw new SerialProjectionUnavailable('Content event is incomplete');
    }
    const rows =
      (
        await this.env.fuseki.query(
          `PREFIX rv: <${RV}> SELECT ?body WHERE {
      GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ${iri(matchUnit)} a rv:MatchUnit ;
        rv:resource ${iri(resource)} ; rv:variant ${iri(variant)} ;
        rv:revision ${iri(contentRevision)} ; rv:searchBody ?body . }
    } LIMIT 2`,
          SERIAL_COST.maxBodyCharacters * 4,
        )
      ).results?.bindings ?? [];
    if (!rows.length) return null; // The publication was superseded before this relay pass.
    if (rows.length !== 1 || !rows[0]?.body)
      throw new SerialProjectionUnavailable('Content match unit is ambiguous');
    return {
      resource,
      variant,
      revision: contentRevision,
      words: countSerialWords(rows[0].body.value),
    };
  }

  private async recompute(client: PoolClient, generation: string, work: string) {
    await client.query(
      `INSERT INTO access.serial_summary
      (generation, work, chapter_count, word_count, last_updated_at)
      SELECT $1, $2, count(c.occurrence)::integer,
        CASE WHEN count(c.occurrence) = count(w.word_count) THEN coalesce(sum(w.word_count),0)
          ELSE NULL END,
        greatest(max(s.structure_updated_at), max(w.updated_at))
      FROM access.serial_summary s
      LEFT JOIN access.serial_chapter c ON c.generation = s.generation AND c.work = s.work
      LEFT JOIN access.serial_content_words w ON w.generation = c.generation
        AND w.variant = c.variant AND w.revision = c.revision
      WHERE s.generation = $1 AND s.work = $2
      GROUP BY s.generation, s.work
      ON CONFLICT (generation, work) DO UPDATE SET
        chapter_count = EXCLUDED.chapter_count, word_count = EXCLUDED.word_count,
        last_updated_at = EXCLUDED.last_updated_at`,
      [generation, work],
    );
  }

  async tick(): Promise<number> {
    const head = (
      await this.relay.query<{ sequence: string }>(
        `SELECT coalesce(max(sequence),0)::text AS sequence FROM relay.delivered_batch WHERE data_epoch = $1`,
        [this.env.lineage.dataEpoch],
      )
    ).rows[0]!.sequence;
    const prior = (
      await this.access.query<{ generation: string; graph_epoch: string; sequence: string }>(
        `SELECT generation, graph_epoch, sequence::text FROM access.serial_stats_checkpoint WHERE singleton`,
      )
    ).rows[0];
    const reset =
      !prior ||
      prior.graph_epoch !== this.env.lineage.dataEpoch ||
      BigInt(prior.sequence) > BigInt(head);
    const after = reset ? '0' : prior.sequence;
    const batch = (
      await this.relay.query<{ sequence: string; event_count: number }>(
        `SELECT batch.sequence::text, event_count FROM relay.delivered_batch AS batch
        WHERE data_epoch = $1 AND batch.sequence > $2::numeric ORDER BY batch.sequence LIMIT 1`,
        [this.env.lineage.dataEpoch, after],
      )
    ).rows[0];
    if (
      (batch && BigInt(batch.sequence) !== BigInt(after) + 1n) ||
      (!batch && BigInt(after) < BigInt(head))
    ) {
      throw new SerialProjectionUnavailable('Graph relay has a source gap');
    }
    const events = batch
      ? (
          await this.relay.query<{ envelope: RelayEvent }>(
            `SELECT envelope FROM relay.delivered_event WHERE source = $1
        AND data_epoch = $2 AND sequence = $3::numeric ORDER BY event_id`,
            [SOURCE, this.env.lineage.dataEpoch, batch.sequence],
          )
        ).rows
      : [];
    if (batch && events.length !== batch.event_count) {
      throw new SerialProjectionUnavailable('Graph relay batch is incomplete');
    }
    const prepared: Array<
      | { kind: 'structure'; value: StructureSnapshot | null; at: Date | null }
      | {
          kind: 'content';
          value: Awaited<ReturnType<SerialStatisticsProjection['contentWord']>>;
          at: Date;
        }
    > = [];
    const refresh = new Set<string>();
    for (const event of events) {
      const receipt = event.envelope.data?.receipt ?? {};
      if (
        event.envelope.type === 'com.rezics.structure.projected.v1' &&
        receipt.action === 'structure.project' &&
        receipt.outcome === 'succeeded'
      ) {
        prepared.push({
          kind: 'structure',
          value: await this.structure(String(receipt.structure)),
          at: await this.sourceTime(receipt, 'structure'),
        });
      } else if (
        event.envelope.type === 'com.rezics.content.projected.v1' &&
        receipt.action === 'content.project' &&
        receipt.outcome === 'succeeded'
      ) {
        prepared.push({
          kind: 'content',
          value: await this.contentWord(receipt),
          at: await this.sourceTime(receipt, 'content'),
        });
      } else if (
        ['com.rezics.content.published.v1', 'com.rezics.content.search-eligible.v1'].includes(
          event.envelope.type,
        ) &&
        receipt.outcome === 'succeeded' &&
        typeof receipt.resource === 'string' &&
        ID.test(receipt.resource) &&
        prior &&
        !reset
      ) {
        const rows = (
          await this.access.query<{ structure: string }>(
            `SELECT DISTINCT s.structure
          FROM access.serial_chapter c JOIN access.serial_summary s
            ON s.generation = c.generation AND s.work = c.work
          WHERE c.generation = $1 AND c.resource = $2 AND s.structure IS NOT NULL
          LIMIT $3`,
            [prior.generation, receipt.resource, SERIAL_COST.maxAffectedWorks + 1],
          )
        ).rows;
        if (rows.length > SERIAL_COST.maxAffectedWorks) {
          throw new SerialProjectionUnavailable('Content resource belongs to too many serials');
        }
        for (const row of rows) refresh.add(row.structure);
      }
    }
    for (const structure of refresh)
      prepared.push({ kind: 'structure', value: await this.structure(structure), at: null });
    const client = await this.access.connect();
    try {
      await client.query('BEGIN');
      const latest = (
        await client.query<{ generation: string; graph_epoch: string; sequence: string }>(
          `SELECT generation, graph_epoch, sequence::text FROM access.serial_stats_checkpoint
         WHERE singleton FOR UPDATE`,
        )
      ).rows[0];
      if (
        latest?.generation !== prior?.generation ||
        latest?.graph_epoch !== prior?.graph_epoch ||
        latest?.sequence !== prior?.sequence
      ) {
        if (latest || prior)
          throw new SerialProjectionUnavailable('Serial checkpoint changed concurrently');
      }
      const generation = reset ? randomUUID() : latest!.generation;
      if (reset)
        await client.query(
          `INSERT INTO access.serial_stats_checkpoint
        (singleton, generation, graph_epoch, sequence) VALUES (true,$1,$2,0)
        ON CONFLICT (singleton) DO UPDATE SET generation = EXCLUDED.generation,
          graph_epoch = EXCLUDED.graph_epoch, sequence = 0, updated_at = clock_timestamp()`,
          [generation, this.env.lineage.dataEpoch],
        );
      const affected = new Set<string>();
      for (const item of prepared) {
        if (item.kind === 'structure' && item.value) {
          const { work, chapters } = item.value;
          await client.query(
            `DELETE FROM access.serial_chapter WHERE generation = $1 AND work = $2`,
            [generation, work],
          );
          if (chapters)
            for (const chapter of chapters) {
              await client.query(
                `INSERT INTO access.serial_chapter
              (generation, work, occurrence, resource, variant, revision) VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                  generation,
                  work,
                  chapter.occurrence,
                  chapter.resource,
                  chapter.variant,
                  chapter.revision,
                ],
              );
            }
          await client.query(
            `INSERT INTO access.serial_summary
            (generation, work, structure, chapter_count, word_count, structure_updated_at, last_updated_at)
            VALUES ($1,$2,$3,$4,NULL,$5,$5) ON CONFLICT (generation, work)
            DO UPDATE SET chapter_count = EXCLUDED.chapter_count, word_count = NULL,
              structure = EXCLUDED.structure,
              structure_updated_at = coalesce(EXCLUDED.structure_updated_at,
                access.serial_summary.structure_updated_at),
              last_updated_at = coalesce(EXCLUDED.last_updated_at,
                access.serial_summary.last_updated_at)`,
            [generation, work, item.value.structure, chapters?.length ?? null, item.at],
          );
          if (chapters) affected.add(work);
        } else if (item.kind === 'content' && item.value) {
          const { resource, variant, revision, words } = item.value;
          await client.query(
            `INSERT INTO access.serial_content_words
            (generation, variant, revision, word_count, updated_at) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (generation, variant) DO UPDATE SET
              revision = EXCLUDED.revision, word_count = EXCLUDED.word_count,
              updated_at = EXCLUDED.updated_at`,
            [generation, variant, revision, words, item.at],
          );
          await client.query(
            `UPDATE access.serial_chapter SET variant = $3, revision = $4
            WHERE generation = $1 AND resource = $2 AND (variant IS NULL OR variant >= $3)`,
            [generation, resource, variant, revision],
          );
          const rows = (
            await client.query<{ work: string }>(
              `SELECT DISTINCT work FROM access.serial_chapter
            WHERE generation = $1 AND resource = $2 LIMIT $3`,
              [generation, resource, SERIAL_COST.maxAffectedWorks + 1],
            )
          ).rows;
          if (rows.length > SERIAL_COST.maxAffectedWorks) {
            throw new SerialProjectionUnavailable('Content resource belongs to too many serials');
          }
          for (const row of rows) affected.add(row.work);
        }
      }
      for (const work of affected) await this.recompute(client, generation, work);
      if (batch)
        await client.query(
          `UPDATE access.serial_stats_checkpoint
        SET sequence = $1::numeric, updated_at = clock_timestamp() WHERE singleton`,
          [batch.sequence],
        );
      for (const table of ['serial_chapter', 'serial_summary', 'serial_content_words'] as const) {
        await client.query(
          `DELETE FROM access.${table} WHERE ctid IN (
          SELECT ctid FROM access.${table} WHERE generation <> $1 LIMIT $2)`,
          [generation, SERIAL_COST.cleanupRows],
        );
      }
      await client.query('COMMIT');
      return batch ? 1 : 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async batch(works: readonly string[], graphSequence?: string) {
    if (
      works.length > SERIAL_COST.summaryBatch ||
      new Set(works).size !== works.length ||
      works.some((work) => !ID.test(work))
    )
      throw new SerialProjectionUnavailable('Serial summary batch is invalid');
    if (!works.length)
      return new Map<
        string,
        { chapterCount: number | null; wordCount: number | null; lastUpdatedAt: string | null }
      >();
    const head = (
      await this.relay.query<{ sequence: string }>(
        `SELECT coalesce(max(sequence),0)::text AS sequence FROM relay.delivered_batch WHERE data_epoch = $1`,
        [this.env.lineage.dataEpoch],
      )
    ).rows[0]!.sequence;
    const result = await this.access.query<{
      generation: string;
      graph_epoch: string;
      sequence: string;
      work: string | null;
      chapter_count: number | null;
      word_count: string | null;
      last_updated_at: Date | null;
    }>(
      `SELECT c.generation, c.graph_epoch,
      c.sequence::text, s.work, s.chapter_count, s.word_count::text, s.last_updated_at
      FROM access.serial_stats_checkpoint c LEFT JOIN access.serial_summary s
        ON s.generation = c.generation AND s.work = ANY($1::text[]) WHERE c.singleton`,
      [works],
    );
    const first = result.rows[0];
    if (
      !first ||
      first.graph_epoch !== this.env.lineage.dataEpoch ||
      first.sequence !== head ||
      (graphSequence !== undefined && first.sequence !== graphSequence)
    ) {
      return new Map(); // Unknown until both source and materialization are at one cut.
    }
    const summaries = new Map(
      result.rows.flatMap((row) =>
        row.work
          ? [
              [
                row.work,
                {
                  chapterCount: row.chapter_count,
                  wordCount: row.word_count === null ? null : Number(row.word_count),
                  lastUpdatedAt: row.last_updated_at?.toISOString() ?? null,
                },
              ] as const,
            ]
          : [],
      ),
    );
    if (!hasDisclosure(this.env)) return summaries;
    // Suitability heads can change without a relay event. A checkpoint alone
    // cannot certify aggregates today. Fence the materialized facts against
    // current child/occurrence/body admission; unknown means no derived count
    // or timestamp. One bounded membership read, at most 56 owner batches.
    const children = (
      await this.access.query<{
        work: string;
        occurrence: string;
        resource: string;
        revision: string | null;
      }>(
        `SELECT work, occurrence, resource, revision
      FROM access.serial_chapter WHERE generation = $1 AND work = ANY($2::text[])
      ORDER BY work, occurrence LIMIT $3`,
        [first.generation, works, SERIAL_COST.disclosureChildren + 1],
      )
    ).rows;
    const hidden = new Set<string>();
    if (children.length > SERIAL_COST.disclosureChildren) works.forEach((work) => hidden.add(work));
    else {
      const targets: DisclosureTarget[] = [
        ...works.map((resource) => ({
          owner: 'graph' as const,
          resource,
          work: resource,
          component: 'name' as const,
        })),
        ...children.flatMap(
          (child) =>
            [
              { owner: 'graph', resource: child.resource, component: 'name' },
              { owner: 'graph', resource: child.occurrence, component: 'record', work: child.work },
              {
                owner: 'content',
                resource: child.resource,
                component: 'body',
                revision: child.revision,
                work: child.work,
              },
            ] as DisclosureTarget[],
        ),
      ];
      const decisions = await discloseInventory(
        this.env,
        targets,
        currentDisclosureViewer(),
        'count',
      );
      works.forEach((work, index) => {
        if (decisions[index] !== 'visible') hidden.add(work);
      });
      children.forEach((child, index) => {
        const offset = works.length + index * 3;
        if (decisions.slice(offset, offset + 3).some((decision) => decision !== 'visible'))
          hidden.add(child.work);
      });
    }
    for (const work of hidden)
      if (summaries.has(work))
        summaries.set(work, { chapterCount: null, wordCount: null, lastUpdatedAt: null });
    return summaries;
  }

  /**
   * When the Content owner recorded each publication: the receipt at its owner
   * position, the same source time the projection records. One unique-index read
   * for at most 20 positions, independent of the projection's own progress.
   */
  async publicationTimes(
    positions: readonly { epoch: string; sequence: string }[],
  ): Promise<Map<string, string>> {
    if (
      positions.length > 20 ||
      positions.some(
        (position) =>
          !/^[0-9a-f-]{36}$/.test(position.epoch) || !/^[1-9][0-9]{0,18}$/.test(position.sequence),
      )
    )
      throw new SerialProjectionUnavailable('Publication time batch is invalid');
    if (!positions.length) return new Map();
    const rows = (
      await this.content.query<{ data_epoch: string; sequence: string; created_at: Date }>(
        `SELECT r.data_epoch::text, r.sequence::text, r.created_at FROM content.receipt r
       JOIN unnest($1::uuid[], $2::bigint[]) AS p(data_epoch, sequence)
         ON r.data_epoch = p.data_epoch AND r.sequence = p.sequence`,
        [
          positions.map((position) => position.epoch),
          positions.map((position) => position.sequence),
        ],
      )
    ).rows;
    return new Map(
      rows.map((row) => [`${row.data_epoch}:${row.sequence}`, row.created_at.toISOString()]),
    );
  }
}
