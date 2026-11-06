import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { routeOf } from '../route/route.ts';
import {
  CREDIT_SEARCH_LIMITS,
  currentCreditSearchMatch,
  projectCreditSearch,
  type CreditSearchEntry,
  type CreditSearchPage,
  type CreditSearchProjection,
  type CreditSearchSource,
  type CreditSearchWitness,
} from '../search/credit-search.ts';
import { canonicalCreators, type PublicCreator } from './credit-search-creators.ts';
import {
  digestOf,
  installedLimits,
  readCursor,
  selectedCursorOf,
  sortQualifiers,
  utf8Bytes,
} from './credit-search-cut.ts';
import {
  creditPlan,
  currentObservation,
  discloseCredits,
  exactCredit,
  observationOf,
  parsePage,
  publicWorkCut,
  resumeSelection,
  selectedCredits,
  workCut,
  type ParsedCredit,
} from './credit-search-selection.ts';

export type CreditSearchReceipt =
  | Readonly<{ state: 'preparing' | 'unsupported' | 'unavailable' | 'incomplete' | 'changed' }>
  | Readonly<{
      state: 'complete';
      workId: string;
      observation: string;
      names: readonly CreditSearchWitness[];
    }>;
export type CreditSearchMatch = 'current' | 'changed' | 'unavailable';

function entriesOf(
  parsed: readonly ParsedCredit[],
  creators: ReadonlyMap<string, PublicCreator>,
  workId: string,
): CreditSearchEntry[] {
  const entries: CreditSearchEntry[] = [];
  for (const credit of parsed) {
    if (credit.overflowQualifiers) {
      entries.push({
        witness: {
          workId,
          statementId: credit.row.candidate_id,
          revision: credit.row.revision,
          release: credit.row.release,
          property: credit.row.property,
          targetId: credit.targetId,
          direction: 'outgoing',
          qualifiers: credit.qualifiers,
          nameRevision: digestOf(['overflow', credit.row.candidate_id]),
        },
        names: [],
        namesComplete: false,
      });
      continue;
    }
    const creator = creators.get(credit.targetId);
    if (!creator) continue;
    entries.push({
      witness: {
        workId,
        statementId: credit.row.candidate_id,
        revision: credit.row.revision,
        release: credit.row.release,
        property: credit.row.property,
        targetId: credit.targetId,
        direction: 'outgoing',
        qualifiers: credit.qualifiers,
        nameRevision: creator.nameRevision,
      },
      names: creator.names,
      namesComplete: creator.namesComplete,
    });
  }
  return entries;
}

async function expandCreators(pool: Pool, parsed: readonly ParsedCredit[], limits: ReturnType<typeof installedLimits>) {
  return canonicalCreators(
    pool,
    parsed.filter((credit) => !credit.overflowQualifiers).map((credit) => credit.targetId),
    limits,
  );
}

/** Native CreditSearchSource. Pages admit selected outgoing credits before nested creator expansion. */
export function createCreditSearchSource(pool: Pool, routeKey?: Uint8Array): CreditSearchSource {
  const source: CreditSearchSource = {
    async page(input) {
      const workId = input.workId;
      if (typeof workId !== 'string' || routeOf(workId) === null) return { state: 'unavailable' };
      const limits = installedLimits(input.limits);
      const after = readCursor(input.after);
      if (after === 'invalid') return { state: 'unavailable' };
      const cut = await workCut(pool, workId);
      if (cut === 'moved' || cut === 'unavailable') return { state: 'unavailable' };
      if (cut.work.visibility !== 'visible' || cut.work.redirect) return { state: 'unavailable' };
      if (!cut.ready) {
        await resumeSelection(pool, cut.work);
        return { state: 'preparing' };
      }
      const plan = await creditPlan(pool, cut.work);
      if (plan === 'unsupported') return { state: 'unsupported' };
      const observation = observationOf(cut);
      if (input.observation !== null && input.observation !== observation)
        return { state: 'current', workId, observation, entries: [], next: null };
      const seek = await selectedCredits(pool, cut.work, plan.properties, after, limits.creditsPerPage + 1);
      const pageRows = seek.slice(0, limits.creditsPerPage);
      // The lookahead row only proves another page exists. The cursor is the last row returned, because the next
      // seek is strictly after it; a cursor on the lookahead row would skip that credit.
      const next =
        seek.length > limits.creditsPerPage ? selectedCursorOf(pageRows[pageRows.length - 1]!) : null;
      const visible = await discloseCredits(pool, routeKey, pageRows);
      const parsed = await parsePage(pool, cut.work, visible, plan, limits);
      const creators = await expandCreators(pool, parsed, limits);
      if (creators.state === 'preparing') return { state: 'preparing' };
      if (creators.state === 'unavailable') return { state: 'unavailable' };
      const entries = entriesOf(parsed, creators.creators, workId);
      const page: Extract<CreditSearchPage, { state: 'current' }> = {
        state: 'current',
        workId,
        observation,
        entries,
        next,
      };
      if (utf8Bytes(page) > limits.pageBytes)
        return {
          state: 'current',
          workId,
          observation,
          entries: entries.map((entry) => ({ ...entry, names: [], namesComplete: false })),
          next,
        };
      return page;
    },

    async current(witness, observation) {
      if (witness.direction !== 'outgoing') return 'unavailable';
      const cut = await workCut(pool, witness.workId);
      if (cut === 'moved' || cut === 'unavailable') return 'unavailable';
      if (!currentObservation(cut, observation)) return false;
      const plan = await creditPlan(pool, cut.work);
      if (plan === 'unsupported' || !plan.properties.includes(witness.property)) return false;
      const row = await exactCredit(pool, cut.work, witness.property, witness.statementId);
      if (!row) return false;
      const visible = await discloseCredits(pool, routeKey, [row]);
      if (visible.length !== 1) return false;
      const parsed = await parsePage(pool, cut.work, visible, plan, installedLimits(CREDIT_SEARCH_LIMITS));
      const credit = parsed[0];
      if (!credit || credit.overflowQualifiers) return false;
      if (
        credit.row.revision !== witness.revision ||
        credit.row.release !== witness.release ||
        credit.row.property !== witness.property ||
        credit.targetId !== witness.targetId ||
        !isDeepStrictEqual(sortQualifiers(credit.qualifiers), sortQualifiers(witness.qualifiers))
      )
        return false;
      const creators = await canonicalCreators(pool, [credit.targetId], installedLimits(CREDIT_SEARCH_LIMITS));
      if (creators.state === 'preparing' || creators.state === 'unavailable') return 'unavailable';
      const creator = creators.creators.get(credit.targetId);
      if (!creator || creator.nameRevision !== witness.nameRevision) return false;
      return creator.names.some((name) => isDeepStrictEqual(name, witness.name));
    },

    async unchanged(workId, observation) {
      const cut = await workCut(pool, workId);
      if (cut === 'moved' || cut === 'unavailable' || !currentObservation(cut, observation)) return false;
      const plan = await creditPlan(pool, cut.work);
      if (plan === 'unsupported') return false;
      const limits = installedLimits(CREDIT_SEARCH_LIMITS);
      const seek = await selectedCredits(
        pool,
        cut.work,
        plan.properties,
        null,
        limits.pages * limits.creditsPerPage + 1,
      );
      const window = seek.slice(0, limits.pages * limits.creditsPerPage);
      const visible = await discloseCredits(pool, routeKey, window);
      const parsed = await parsePage(pool, cut.work, visible, plan, limits);
      const creators = await expandCreators(pool, parsed, limits);
      if (creators.state !== 'current') return false;
      const later = await workCut(pool, workId);
      return (
        later !== 'moved' && later !== 'unavailable' && observationOf(later) === observation && publicWorkCut(later)
      );
    },
  };
  return source;
}

/** Search paging stays the owner; this maps restart onto changed for native receiving. */
export async function receiveCreditSearch(source: CreditSearchSource, workId: string): Promise<CreditSearchReceipt> {
  const projection = await projectCreditSearch(source, workId);
  if (projection.state === 'restart') return { state: 'changed' };
  if (projection.state === 'complete') return projection;
  return { state: projection.state };
}

export async function receiveCreditSearchMatch(
  source: CreditSearchSource,
  projection: CreditSearchProjection,
  matched: CreditSearchWitness,
): Promise<CreditSearchMatch> {
  const result = await currentCreditSearchMatch(source, projection, matched);
  return result === 'restart' ? 'changed' : result;
}
