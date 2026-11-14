import type { AccessClient, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { snapshot, ContentNotFoundError } from './reads.ts';
import {
  observeHostedChapterAttachments,
  type HostedChapterAttachmentObservation,
} from './hosted-chapters-attachments.ts';
import { pageHostedLanguageBindings } from './hosted-chapter-language-store.ts';
import type { HostedLanguageSnapshotRow } from './hosted-chapter-languages.ts';
import { readHostedDraftPointSnapshot } from './hosted-version-draft-write.ts';
import { readVersionedHostedPlacement } from './hosted-chapters-version-reads.ts';
import {
  createHostedLanguageNamespace,
  appendHostedLanguageNamespaceRows,
  sealHostedLanguageNamespace,
} from './hosted-chapter-language-namespace.ts';
import type {
  HostedChapterLanguages,
  HostedChapterTarget,
  HostedDependencies,
  OrderedHostedPlacement,
} from './hosted-chapters-model.ts';
import { HostedPublicationStagingConflictError } from './hosted-publication-staging-model.ts';

type Cursor = Readonly<{
  afterSourceOrder: string;
  afterLanguageVersion: string | null;
  afterLanguage: string | null;
  complete: boolean;
}>;
const initial: Cursor = { afterSourceOrder: '-1', afterLanguageVersion: null, afterLanguage: null, complete: false };
type Locator = Readonly<{ catalogueId: string; stageId: string }>;
type Member = Readonly<{ occurrenceId: string; target: HostedChapterTarget }>;
export type HostedPublicationLanguagePreparation = Readonly<{
  locator: Locator;
  expected: Cursor;
  next: Cursor;
  processed: number;
  members: readonly Member[];
  rows: readonly HostedLanguageSnapshotRow[];
  observations: readonly HostedChapterAttachmentObservation[];
  unavailable: boolean;
}>;

async function cursor(tx: AccessClient, locator: Locator, lock = false): Promise<Cursor> {
  return (
    (
      await tx.query<Cursor>(
        `SELECT after_source_order::text AS "afterSourceOrder",after_language_version::text AS "afterLanguageVersion",
       after_language AS "afterLanguage",complete FROM content.hosted_publication_language_progress
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3${lock ? ' FOR UPDATE' : ''}`,
        [routeOf(locator.catalogueId), locator.catalogueId, locator.stageId],
      )
    ).rows[0] ?? initial
  );
}

/** Extend existing preparation with at most 20 indexed language keys/targets per advance. Source occurrence
 * and language frontiers are durable; no earlier key is replayed or copied into an accumulated result. */
export async function prepareHostedPublicationLanguageTargets(
  deps: HostedDependencies,
  actor: Actor,
  locator: Locator,
  deadline: number,
): Promise<HostedPublicationLanguagePreparation> {
  const plan = (
    await snapshot(deps, locator.catalogueId, { deadline }, async (tx) => {
      const expected = await cursor(tx, locator);
      if (expected.complete)
        return {
          expected,
          next: expected,
          processed: 0,
          members: [] as Member[],
          placements: [] as OrderedHostedPlacement[],
          rows: [] as HostedLanguageSnapshotRow[],
        };
      const candidates = (
        await tx.query<{
          source_order: string;
          occurrence_id: string;
          body_languages: HostedChapterLanguages;
          source_revision_id: string;
        }>(
          `SELECT candidate.source_order::text,candidate.occurrence_id,candidate.body_languages,stage.source_revision_id
         FROM content.hosted_publication_staging_candidate candidate
         JOIN content.hosted_publication_staging stage USING(route,catalogue_id,stage_id)
       WHERE candidate.route=$1 AND candidate.catalogue_id=$2 AND candidate.stage_id=$3 AND candidate.body_languages IS NOT NULL
         AND (candidate.source_order>$4::bigint OR ($5::boolean AND candidate.source_order=$4::bigint))
       ORDER BY candidate.source_order LIMIT 21`,
          [
            routeOf(locator.catalogueId),
            locator.catalogueId,
            locator.stageId,
            expected.afterSourceOrder,
            expected.afterLanguage !== null,
          ],
        )
      ).rows;
      let next: Cursor = { ...expected };
      let processed = 0;
      let finishedOccurrences = 0;
      const members: Member[] = [];
      const placements: OrderedHostedPlacement[] = [];
      const snapshots: HostedLanguageSnapshotRow[] = [];
      for (const candidate of candidates.slice(0, 20)) {
        const after =
          candidate.source_order === expected.afterSourceOrder && expected.afterLanguage !== null
            ? { firstVersion: expected.afterLanguageVersion!, language: expected.afterLanguage }
            : null;
        const rows = await pageHostedLanguageBindings(
          tx,
          locator.catalogueId,
          candidate.occurrence_id,
          candidate.body_languages.version,
          after,
          21 - processed,
        );
        const admitted = rows.slice(0, 20 - processed);
        processed += admitted.length;
        let canonical: OrderedHostedPlacement | null = null;
        if (admitted.some((row) => row.language === candidate.body_languages.defaultLanguage)) {
          const version = await readHostedDraftPointSnapshot(tx, locator.catalogueId, candidate.source_revision_id);
          if (!version) throw new HostedPublicationStagingConflictError('The draft has no canonical ordered selection');
          canonical = await readVersionedHostedPlacement(tx, version, candidate.occurrence_id);
          if (canonical?.kind !== 'chapter')
            throw new HostedPublicationStagingConflictError('The declared default chapter is unavailable');
        }
        for (const row of admitted) {
          if (row.title === null || row.target === null) continue;
          const isDefault = row.language === candidate.body_languages.defaultLanguage;
          const selected =
            isDefault && canonical?.kind === 'chapter' ? { title: canonical.title, target: canonical.target } : row;
          snapshots.push({
            occurrenceId: candidate.occurrence_id,
            language: row.language,
            firstVersion: row.firstVersion,
            title: selected.title!,
            target: selected.target!,
          });
          if (isDefault) continue;
          members.push({ occurrenceId: candidate.occurrence_id, target: row.target });
          placements.push({
            occurrenceId: candidate.occurrence_id,
            parentId: null,
            position: 0,
            ordinal: 0,
            kind: 'chapter',
            title: row.title,
            target: row.target,
          });
        }
        const last = admitted.at(-1);
        if (rows.length > admitted.length) {
          next = {
            afterSourceOrder: candidate.source_order,
            afterLanguageVersion: last!.firstVersion,
            afterLanguage: last!.language,
            complete: false,
          };
          break;
        }
        next = {
          afterSourceOrder: candidate.source_order,
          afterLanguageVersion: null,
          afterLanguage: null,
          complete: false,
        };
        finishedOccurrences++;
        if (processed === 20) break;
      }
      if (finishedOccurrences === candidates.length) next = { ...next, complete: true };
      return { expected, next, processed, members, placements, rows: snapshots };
    })
  ).value;
  let observations: readonly HostedChapterAttachmentObservation[] = [];
  let unavailable = false;
  try {
    observations = await observeHostedChapterAttachments(deps, plan.placements, { actor, deadline });
  } catch (error) {
    if (!(error instanceof ContentNotFoundError)) throw error;
    unavailable = true;
  }
  return {
    locator,
    expected: plan.expected,
    next: plan.next,
    processed: plan.processed,
    members: plan.members,
    rows: plan.rows,
    observations,
    unavailable,
  };
}

/** The catalogue's existing command transaction owns receipt/current authority and this exact checkpoint CAS. */
export async function applyHostedPublicationLanguageTargets(
  tx: AccessClient,
  preparation: HostedPublicationLanguagePreparation,
  insertObservations: (observations: readonly HostedChapterAttachmentObservation[]) => Promise<number>,
): Promise<Readonly<{ changed: boolean; complete: boolean; processed: number }>> {
  const { locator } = preparation;
  const values = [routeOf(locator.catalogueId), locator.catalogueId, locator.stageId];
  await tx.query(
    `INSERT INTO content.hosted_publication_language_progress(route,catalogue_id,stage_id)
    VALUES ($1,$2,$3) ON CONFLICT (route,catalogue_id,stage_id) DO NOTHING`,
    values,
  );
  const current = await cursor(tx, locator, true);
  if (JSON.stringify(current) !== JSON.stringify(preparation.expected))
    throw new HostedPublicationStagingConflictError('Language preparation frontier changed');
  if (current.complete) return { changed: false, complete: true, processed: 0 };
  if (preparation.unavailable)
    throw new HostedPublicationStagingConflictError('A selected language source is unavailable');
  await createHostedLanguageNamespace(tx, locator.catalogueId, locator.stageId, locator.stageId);
  if (preparation.rows.length)
    await appendHostedLanguageNamespaceRows(tx, locator.catalogueId, locator.stageId, preparation.rows);
  const inserted = await insertObservations(preparation.observations);
  if (preparation.members.length)
    await tx.query(
      `INSERT INTO content.hosted_publication_language_target
       (route,catalogue_id,stage_id,thread_id,post_id,target_revision_id,body_sha256,occurrence_id)
     SELECT $1,$2,$3,x.thread_id,x.post_id,x.revision_id,decode(x.sha256,'hex'),x.occurrence_id
     FROM jsonb_to_recordset($4::jsonb) AS x(thread_id uuid,post_id uuid,revision_id uuid,sha256 text,occurrence_id uuid)
     ON CONFLICT DO NOTHING`,
      [
        ...values,
        JSON.stringify(
          preparation.members.map(({ occurrenceId, target }) => ({
            occurrence_id: occurrenceId,
            thread_id: target.threadId,
            post_id: target.postId,
            revision_id: target.revisionId,
            sha256: target.sha256,
          })),
        ),
      ],
    );
  const next = preparation.next;
  if (next.complete) await sealHostedLanguageNamespace(tx, locator.catalogueId, locator.stageId);
  await tx.query(
    `UPDATE content.hosted_publication_language_progress
    SET after_source_order=$4::bigint,after_language_version=$5::bigint,after_language=$6,complete=$7
    WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [...values, next.afterSourceOrder, next.afterLanguageVersion, next.afterLanguage, next.complete],
  );
  await tx.query(
    `UPDATE content.hosted_publication_staging SET target_observation_count=target_observation_count+$4
    WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [...values, inserted],
  );
  return { changed: true, complete: next.complete, processed: preparation.processed };
}
