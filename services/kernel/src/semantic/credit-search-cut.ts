import { createHash } from 'node:crypto';
import { CREDIT_SEARCH_LIMITS } from '../search/credit-search.ts';

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
export const SELECTED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const encoder = new TextEncoder();

export type CreditSearchCeilings = {
  pages: number;
  creditsPerPage: number;
  namesPerCreator: number;
  qualifiersPerCredit: number;
  nameBytes: number;
  documentBytes: number;
  pageBytes: number;
};

export type CreditCursor = { property: string; slot: string; candidate: string };

export type WorkHeader = {
  id: string;
  route: number;
  type: string;
  visibility: string;
  redirect: string | null;
  currentRelease: string | null;
  securityRevision: string;
  current_revision: number | null;
  selection_ready: boolean;
};

export type WorkCut = Readonly<{
  work: WorkHeader;
  generation: string;
  ready: boolean;
}>;

/** Port ceilings apply before nested creator expansion. Callers may only tighten them. */
export function installedLimits(input: typeof CREDIT_SEARCH_LIMITS): CreditSearchCeilings {
  return {
    pages: Math.min(input.pages, CREDIT_SEARCH_LIMITS.pages),
    creditsPerPage: Math.min(input.creditsPerPage, CREDIT_SEARCH_LIMITS.creditsPerPage),
    namesPerCreator: Math.min(input.namesPerCreator, CREDIT_SEARCH_LIMITS.namesPerCreator),
    qualifiersPerCredit: Math.min(input.qualifiersPerCredit, CREDIT_SEARCH_LIMITS.qualifiersPerCredit),
    nameBytes: Math.min(input.nameBytes, CREDIT_SEARCH_LIMITS.nameBytes),
    documentBytes: Math.min(input.documentBytes, CREDIT_SEARCH_LIMITS.documentBytes),
    pageBytes: Math.min(input.pageBytes, CREDIT_SEARCH_LIMITS.pageBytes),
  };
}

export const utf8Bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function digestOf(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value, (_key, entry) => (typeof entry === 'bigint' ? entry.toString() : entry)))
    .digest('hex');
}

/** Work header plus search canonical generation. Creator names live in nameRevision; paging stays stable. */
export function observationOf(cut: WorkCut): string {
  return digestOf([
    cut.work.id,
    cut.work.type,
    cut.work.visibility,
    cut.work.redirect,
    cut.work.securityRevision,
    cut.work.currentRelease,
    cut.work.current_revision,
    cut.work.selection_ready,
    cut.generation,
  ]);
}

export function selectedCursorOf(row: { property: string; slot_id: string; candidate_id: string }): string {
  return JSON.stringify([row.property, row.slot_id, row.candidate_id]);
}

export function readCursor(after: string | null): CreditCursor | null | 'invalid' {
  if (after === null) return null;
  try {
    const value = JSON.parse(after) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      value.some((entry) => typeof entry !== 'string' || entry.length === 0 || !entry.isWellFormed())
    )
      return 'invalid';
    const [property, slot, candidate] = value as [string, string, string];
    if (!SELECTED_UUID.test(slot) || !SELECTED_UUID.test(candidate)) return 'invalid';
    return { property, slot, candidate };
  } catch {
    return 'invalid';
  }
}

export function sortQualifiers<T extends { property: string; value: string }>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) => left.property.localeCompare(right.property) || left.value.localeCompare(right.value),
  );
}
