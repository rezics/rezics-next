export type CollectionPositionScope = 'first' | 'continued' | 'filtered-first' | 'filtered-continued';

export type CollectionPositionPage = {
  firstPage: boolean;
  cursor?: string;
  filterActive?: boolean;
  filter?: unknown;
  filterStatus?: string;
  filterIgnored?: readonly unknown[];
};

export function collectionPageIsFiltered(
  page: CollectionPositionPage,
  search: Record<string, string | string[]> | undefined,
): boolean {
  if (page.filterActive || page.filter !== undefined || page.filterStatus || page.filterIgnored?.length) return true;
  return Object.keys(search ?? {}).some((key) => key === 'type' || /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key));
}

export function collectionPositionScope(
  page: Pick<CollectionPositionPage, 'firstPage' | 'cursor'>,
  filtered: boolean,
): CollectionPositionScope {
  const first = page.firstPage && page.cursor === undefined;
  return filtered ? (first ? 'filtered-first' : 'filtered-continued') : first ? 'first' : 'continued';
}

type PageKeyMember = { id?: string; subjectId?: string; subject?: { id: string } | null };

/** Layout is a view choice; note expansion belongs to the admitted page, filter and cursor. */
export function collectionReadingPageKey(
  address: string | undefined,
  fallbackAddress: string,
  revision: number,
  members: readonly PageKeyMember[],
): string {
  let pageAddress = fallbackAddress;
  try {
    const url = new URL(address ?? fallbackAddress, 'https://rezics.invalid');
    url.searchParams.delete('layout');
    url.hash = '';
    url.searchParams.sort();
    pageAddress = `${url.pathname}${url.search}`;
  } catch {
    // The caller's bounded Collection address remains a stable local fallback.
  }
  const renderedMembers = members.map((member, index) =>
    member.id ? `occurrence:${member.id}` : `display-only:${member.subjectId ?? member.subject?.id ?? 'unknown'}:${index}`,
  );
  return JSON.stringify([pageAddress, revision, renderedMembers]);
}
