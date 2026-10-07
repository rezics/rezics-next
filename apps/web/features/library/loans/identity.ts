import { workHref } from '../../work-page/route.ts';
import type { CopyRecord, LoanRecord, ReleaseChoice } from './types.ts';

// A loan names a copy. The copy names its Work and its release. Titles come
// from those two references, one read each, for the copies on this page only.

export interface CopyLabel {
  work: { id: string; href: string; title: string } | null;
  edition: string | null;
  format: string | null;
}

export interface IdentitySource {
  copy(id: string): Promise<CopyRecord | null>;
  work(id: string): Promise<{ id: string; href: string; title: string } | null>;
  release(work: string, release: string): Promise<ReleaseChoice | null>;
}

/** Pages walked while collecting the copies named on one loan page. */
export const COPY_PAGE_BOUND = 400;

export interface CopyPage { copies: CopyRecord[]; nextCursor: string | null }

export function editionDetail(release: ReleaseChoice): string {
  const detail = [release.editionStatement, release.publicationYear, release.isbn13].filter(part => part != null)
    .join(' · ');
  return detail ? `${release.title} — ${detail}` : release.title;
}

async function pooled<T>(items: readonly T[], task: (item: T) => Promise<void>, limit: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index]!);
    }
  }));
}

/** Read copy pages until every wanted id is in hand, the list ends, or the bound is spent. */
export async function collectCopies(wanted: ReadonlySet<string>,
  read: (cursor: string | null) => Promise<CopyPage | null>, bound = COPY_PAGE_BOUND): Promise<Map<string, CopyRecord>> {
  const found = new Map<string, CopyRecord>();
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < bound && found.size < wanted.size; page++) {
    const readPage = await read(cursor);
    if (!readPage) break;
    for (const copy of readPage.copies) {
      if (wanted.has(copy.id)) found.set(copy.id, copy);
    }
    if (!readPage.nextCursor || seen.has(readPage.nextCursor)) break;
    seen.add(readPage.nextCursor);
    cursor = readPage.nextCursor;
  }
  return found;
}

function remember<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const pending = cache.get(key) ?? load();
  cache.set(key, pending);
  return pending;
}

/** The Work, edition and format of each loan's copy. A missing copy stays unlabeled. */
export async function loanLabels(loans: readonly LoanRecord[], source: IdentitySource): Promise<Map<string, CopyLabel>> {
  const labels = new Map<string, CopyLabel>();
  const works = new Map<string, Promise<{ id: string; href: string; title: string } | null>>();
  const releases = new Map<string, Promise<ReleaseChoice | null>>();
  await pooled([...new Set(loans.map(loan => loan.copy))], async id => {
    const copy = await source.copy(id);
    if (!copy) return;
    const [work, release] = await Promise.all([
      remember(works, copy.work, () => source.work(copy.work)),
      remember(releases, `${copy.work}\n${copy.release}`, () => source.release(copy.work, copy.release)),
    ]);
    const title = work?.title ?? release?.title ?? null;
    labels.set(copy.id, {
      work: work ?? (title ? { id: copy.work, href: workHref(copy.work), title } : null),
      edition: release ? editionDetail(release) : null,
      format: copy.format,
    });
  }, 6);
  return labels;
}
