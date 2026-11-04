import type { AccountActor } from '../request/access.ts';
import { createHash } from 'node:crypto';
import type { ShelfOwner } from './shelf-maintenance-ops-contract.ts';
import { SHELF_TITLE_KEY_POLICY } from './shelf-title-key.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';

/** Content must cover title, identity disclosure, redirects and source-owner changes in this version. */
export type ShelfTitleBasis = { status: 'current'; version: string } | { status: 'unavailable' };
export type ShelfTitleLabels = {
  subjectId: string;
  sourceId: string;
  sourceBasis: string;
  /** Missing labels are allowed; an undisclosed identity is not a missing label. */
  labels: Readonly<Record<string, string>>;
  originalLanguage?: string | null;
};

/**
 * Released, complete-input Content port. Neither method may hold a Library transaction.
 * basis is a bounded whole-source version, including current owner disclosure, never a page digest.
 * labels batches exact original subjects under that basis; denied/hidden/unknown identities return unavailable.
 * Implementations must not acquire one Subject per Entry or manufacture currentness from cached labels.
 */
export interface ShelfTitleSource {
  basis(owner: ShelfOwner, languages: readonly string[], viewer: AccountActor): Promise<ShelfTitleBasis>;
  labels(
    owner: ShelfOwner,
    languages: readonly string[],
    basis: string,
    subjectIds: readonly string[],
    viewer: AccountActor,
  ): Promise<{ status: 'current'; entries: readonly ShelfTitleLabels[] } | { status: 'unavailable' }>;
}

export function titleLanguages(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some(
      (tag) => typeof tag !== 'string' || tag.length > 128 || !/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$(?![\s\S])/i.test(tag),
    )
  )
    throw new TypeError('Invalid shelf title languages');
  return value.map((tag: string) => tag.toLowerCase());
}

export function shelfTitlePolicy(languages: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([SHELF_TITLE_KEY_POLICY, titleLanguages(languages)]))
    .digest('hex');
}

export async function currentShelfTitleBasis(
  source: ShelfTitleSource | undefined,
  owner: ShelfOwner,
  languages: readonly string[],
  viewer: AccountActor,
): Promise<string> {
  if (!source)
    throw new ShelfReadUnavailableError('Content shelfTitleInputs.observe complete-source producer installation');
  const current = await source.basis(owner, languages, viewer);
  if (
    current.status !== 'current' ||
    typeof current.version !== 'string' ||
    !current.version ||
    current.version.length > 256
  )
    throw new ShelfReadUnavailableError(
      'Content complete whole-source title/disclosure/redirect/identity/source-owner observation',
    );
  return current.version;
}
