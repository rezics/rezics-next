import { readConsentTarget, type ConsentIdentity } from './candidate-consent-identity.ts';
import type { Source, BatchReference } from '@rezics/definitions/bulk';
import type { Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import type { KeyRing } from '../tokens/seal.ts';
import { fencedIds } from './fences.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { statementAudience } from './statement-disclosure.ts';
import { readRelease } from './definition-release-read.ts';
import { GLOBAL_SUBJECT_CONTEXT as GLOBAL_CONTEXT } from './contract/subject-values.ts';
import { factDataTypes, resolveItem, type Statement } from './item.ts';
import {
  candidateFact,
  resolveSlot,
  slotId,
  slotView,
  type Candidate,
} from './slots.ts';
import readCandidatePage from './candidates-read-candidate-page.sql';
import readCandidateLifecycle from './candidates-read-lifecycle.sql';
import readCandidateOwners from './candidates-read-owners.sql';
import readHiddenIds from './candidates-read-hidden-ids.sql';
import readProvenance from './candidates-read-provenance.sql';
import readRevisions from './candidates-read-revisions.sql';
import { readLabels } from './subject.ts';
import { contextSnapshot } from './context.ts';
import { page } from './candidate-pagination.ts';
import type {
  CandidatePageOptions,
  PageOptions,
} from './candidate-contract.ts';
import { SubjectNotFoundError } from './contract/subject-errors.ts';

const listed = <T>(result: T[] | T | null): T[] => result == null ? [] : Array.isArray(result) ? result : [result];

export function listRevisions(pool: Pool, ring: KeyRing, options: PageOptions) {
  return page(
    pool,
    ring,
    options,
    { operation: 'subject.list_revisions', parameters: { subject: options.subject } },
    (after) => after.length === 1 && Number.isSafeInteger(after[0]) && Number(after[0]) >= 1,
    async (client, after) => {
      const result = listed(
        await readRevisions.run(client, {
          route: routeOf(options.subject)!,
          subject_id: options.subject,
          before: Number(after?.[0] ?? 2147483647),
          page_limit: options.limit + 1,
        }),
      ) as { revision: number; kind: string; release: string; source: Source | null }[];
      const revisions = result.slice(0, options.limit);
      return { value: { revisions }, after: result.length > options.limit ? [revisions.at(-1)!.revision] : null };
    },
  );
}
async function candidatePage(pool: Pool, ring: KeyRing, options: CandidatePageOptions) {
  const contextRecord = options.context === GLOBAL_CONTEXT ? null : await contextSnapshot(pool, options.context);
  if (options.context !== GLOBAL_CONTEXT && !contextRecord) throw new SubjectNotFoundError();
  const defaults = contextRecord?.defaults ?? {};
  return page(
    pool,
    ring,
    options,
    {
      operation: 'subject.list_candidates',
      parameters: {
        subject: options.subject,
        property: options.property,
        slot: options.slot ?? slotId(options.subject, options.property),
        context: options.context,
      },
    },
    (after) =>
      after.length === 3 &&
      Number.isSafeInteger(after[0]) &&
      Number(after[0]) >= 1 &&
      Number.isInteger(after[1]) &&
      Number(after[1]) >= 0 &&
      Number(after[1]) <= 32 &&
      typeof after[2] === 'string' &&
      routeOf(after[2]) === routeOf(options.subject),
    async (client, after) => {
      const identityAdmitted =
        options.identity?.actor.kind === 'account' &&
        (await readPartition(client, partitionOf(routeOf(options.subject)!)))?.writeState === 'active';
      const slot = options.slot ?? slotId(options.subject, options.property);
      const state = await resolveSlot(client, options.subject, options.property, options.context, slot);
      type Decided = Candidate & { verdict: 'accept' | 'reject' | 'abstain' | null; head: number | null };
      let rows: Decided[];
      if (state.expanded) {
        rows = listed(
          await readCandidatePage.run(client, {
            route: routeOf(options.subject)!,
            subject_id: options.subject,
            slot_id: slot,
            context_id: options.context,
            after_revision: Number(after?.[0] ?? 0),
            after_view_order: Number(after?.[1] ?? 0),
            after_candidate_id: String(after?.[2] ?? '00000000-0000-0000-0000-000000000000'),
            page_limit: options.limit + 1,
          }),
        );
      } else {
        rows = state.compact
          .filter(
            (row) =>
              !after ||
              row.revision > Number(after[0]) ||
              (row.revision === after[0] && row.view_order > Number(after[1])),
          )
          .sort((a, b) => a.revision - b.revision || a.view_order - b.view_order)
          .slice(0, options.limit + 1)
          .map((row) => ({
            ...row,
            verdict: options.context === GLOBAL_CONTEXT ? 'accept' : null,
            head: options.context === GLOBAL_CONTEXT ? 1 : null,
          }));
      }
      const window = rows.slice(0, options.limit);
      const lifecycleRows = window.length
        ? listed(
            await readCandidateLifecycle.run(client, {
              route: routeOf(options.subject)!,
              subject_id: options.subject,
              candidate_ids: window.map((row) => row.candidate_id),
            }),
          )
        : [];
      const lifecycle = new Map(lifecycleRows.map((row) => [row.candidate_id, row.state]));
      const hidden = new Set<string>();
      if (window.length) {
        const owners = listed(
          await readCandidateOwners.run(client, {
            route: routeOf(options.subject)!,
            subject_id: options.subject,
            candidate_ids: window.map((row) => row.candidate_id),
          }),
        ) as {
          candidate_id: string;
          principal_kind: 'account' | 'anonymous' | 'erased';
          principal_id: string;
          account_state: string | null;
          account_fenced: boolean | null;
        }[];
        const located = new Set(owners.map((owner) => owner.candidate_id));
        for (const row of window) if (!located.has(row.candidate_id)) hidden.add(row.candidate_id);
        for (const owner of owners) {
          if (
            owner.principal_kind === 'account' &&
            (owner.account_state !== 'active' || owner.account_fenced !== false)
          )
            hidden.add(owner.candidate_id);
        }
        const concealed = await readHiddenIds.run(client, {
          route: routeOf(options.subject)!,
          subject_id: options.subject,
          candidate_ids: window.map((row) => row.candidate_id),
          ...(await statementAudience(client)),
        });
        for (const row of listed(concealed)) hidden.add(row.candidate_id);
      }
      // Hidden rows leave this page short. next stays set until the candidate sequence ends.
      const shown = window.filter((row) => !hidden.has(row.candidate_id));
      const releases = new Map<string, Release>();
      for (const row of shown.filter(
        (row) => !['deleted', 'purging', 'purged'].includes(lifecycle.get(row.candidate_id) ?? 'active'),
      )) {
        if (releases.has(row.release)) continue;
        const release = await readRelease(client, row.release);
        if (!release) throw new Error('Candidate release is missing');
        releases.set(row.release, release);
      }
      const view = await slotView(client, options.subject, options.property, options.context, defaults, slot);
      const ranks = new Map(
        view.facts.map((fact) => [
          fact.statement_id!,
          (fact.body as { rank?: 'normal' | 'preferred' | 'deprecated' }).rank ?? null,
        ]),
      );
      let subjectIdentity: ConsentIdentity['subject'] | undefined;
      let candidates: (
        | { id: string; deleted: true }
        | {
            consentIdentity?: ConsentIdentity;
            source: Source | null;
            retracted: number | null;
            retraction: { source: Source; references: BatchReference[] } | null;
            id: string;
            statement: Statement;
            release: string;
            revision: number;
            decision: 'accepted' | 'rejected' | 'abstained' | null;
            head: number | null;
            rank: 'normal' | 'preferred' | 'deprecated' | null;
          }
      )[] = [];
      for (const row of shown) {
        const provenance = listed(
          await readProvenance.run(client, {
            route: routeOf(options.subject)!,
            subject_id: options.subject,
            revision: row.revision,
            candidate_id: row.candidate_id,
          }),
        )[0] as
          | {
              source: Source | null;
              retracted: number | null;
              retraction: { source: Source; references: BatchReference[] } | null;
            }
          | undefined;
        if (['deleted', 'purging', 'purged'].includes(lifecycle.get(row.candidate_id) ?? 'active')) {
          if (options.routeKey && provenance?.source) {
            const fenced = await fencedIds(client, options.routeKey, [
              { id: row.candidate_id, source: provenance.source },
            ]);
            if (fenced.has(row.candidate_id)) continue;
          }
          candidates.push({ id: row.candidate_id, deleted: true });
          continue;
        }
        const fact = candidateFact(options.property, row);
        const dataTypes = factDataTypes(releases.get(row.release)!, [fact]);
        const statement = resolveItem(options.subject, [fact], '', dataTypes, {
          revision: row.revision,
          release: row.release,
          context: options.context,
        }).statements[options.property]![0]!;
        let identity: ConsentIdentity | undefined;
        if (
          identityAdmitted &&
          provenance?.retracted === null &&
          releases.get(row.release)?.properties[options.property]?.disclosure === 'sourceOrConsent' &&
          statement.property.data_type === 'wikibase-item' &&
          statement.value.type === 'value' &&
          typeof statement.value.content === 'string'
        ) {
          subjectIdentity ??= {
            id: options.subject,
            labels: (await readLabels(client, [options.subject])).get(options.subject) ?? {},
          };
          identity = { subject: subjectIdentity, target: null };
        }
        candidates.push({
          ...provenance!,
          ...(identity ? { consentIdentity: identity } : {}),
          id: row.candidate_id,
          statement,
          release: row.release,
          revision: row.revision,
          decision:
            row.verdict === 'accept'
              ? 'accepted'
              : row.verdict === 'reject'
                ? 'rejected'
                : row.verdict === 'abstain'
                  ? 'abstained'
                  : null,
          head: row.head,
          rank: ranks.get(row.candidate_id) ?? null,
        });
      }
      if (options.routeKey && candidates.length) {
        const gone = await fencedIds(
          client,
          options.routeKey,
          candidates.flatMap((row) => ('deleted' in row ? [] : [{ id: row.id, source: row.source }])),
        );
        candidates = candidates.filter((row) => 'deleted' in row || !gone.has(row.id));
      }
      const last = window.at(-1);
      return {
        value: {
          candidates,
          adoption: state.adoption ? { mode: state.adoption.mode, head: state.adoption.head } : null,
        },
        after: rows.length > options.limit && last ? [last.revision, last.view_order, last.candidate_id] : null,
      };
    },
  );
}
/** Stage only the page's admitted main item targets, then re-read source admission,
 * audience, disclosure, candidate lifecycle and tuple fences before disclosing labels.
 */
export async function listCandidates(
  pool: Pool,
  ring: KeyRing,
  options: CandidatePageOptions,
) {
  const first = await candidatePage(pool, ring, options);
  if (
    !options.identity ||
    !first.candidates.some((candidate) => 'consentIdentity' in candidate && candidate.consentIdentity)
  )
    return first;
  const targets = new Map<string, ConsentIdentity['target']>();
  for (const candidate of first.candidates) {
    if ('deleted' in candidate || !candidate.consentIdentity) continue;
    if (candidate.statement.value.type !== 'value' || typeof candidate.statement.value.content !== 'string') continue;
    const target = candidate.statement.value.content;
    if (!targets.has(target)) targets.set(target, await readConsentTarget(pool, options.identity, target));
  }
  await options.identity.refreshAudience();
  const authorize = await options.identity.prepareSource();
  const current = await candidatePage(pool, ring, { ...options, authorize });
  for (const candidate of current.candidates) {
    if ('deleted' in candidate || !candidate.consentIdentity) continue;
    const prior = first.candidates.find((row) => row.id === candidate.id);
    if (
      !prior ||
      'deleted' in prior ||
      prior.release !== candidate.release ||
      JSON.stringify(prior.statement) !== JSON.stringify(candidate.statement)
    ) {
      delete candidate.consentIdentity;
      continue;
    }
    candidate.consentIdentity.target =
      candidate.statement.value.type === 'value' && typeof candidate.statement.value.content === 'string'
        ? (targets.get(candidate.statement.value.content) ?? null)
        : null;
  }
  return current;
}
