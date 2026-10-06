import { cache } from 'react';
import { readPlatformAccess } from '../api/main.ts';
import { operationOpen } from '../api/platform-access.ts';
import { settle } from '../feed/types.ts';
import { shellReader } from '../shell/communities-read.ts';
import { splitFilters } from './tabs.ts';
import type { SavedFilters } from './types.ts';

/**
 * The reader's Saved Filters for Home's tabs, followed Concepts named in the
 * page's language. Null signed out, without an acting Agent, while the platform
 * has not opened Saved Filters for the reader, or when Main cannot read them, so
 * Home still shows Following and All.
 */
export const readSavedFilters = cache(async (locale: string): Promise<SavedFilters | null> => {
  const reader = await shellReader();
  if (!reader.actingSubject) return null;
  if (!operationOpen('getV1MeSaved-filters', await readPlatformAccess())) return null;
  const read = await settle(() => reader.main.v1.me['saved-filters'].get({ query: {
    actingSubject: reader.actingSubject!, language: locale } }));
  return read.ok ? splitFilters(read.data) : null;
});
