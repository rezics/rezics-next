'use server';

import { readContents } from './read.ts';
import { parseContentsQuery } from './route.ts';
import type { ContentsPage } from './types.ts';

/**
 * One group's first page of chapters, for a volume opened in Contents. It reads
 * as the page does: as the session Agent when it is eligible, else publicly, so
 * the browser never sends a bearer without the Agent it reads as.
 */
export async function readContentsGroup(work: string, parent: string, language: string | undefined):
  Promise<ContentsPage | null> {
  const query = parseContentsQuery({ parent, language });
  if (!query?.parent || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(work)) return null;
  const loaded = await readContents(work, { parent: query.parent, language: query.language });
  return loaded.ok ? loaded.data : null;
}
