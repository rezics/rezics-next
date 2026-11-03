import {
  SUBJECT_COLLECTION_CURSOR_MAX_LENGTH,
  SUBJECT_COLLECTION_PAGE_LIMIT,
  type BoundCollectionPage,
  type CapturedChooserTarget,
} from './model';

export const SUBJECT_COLLECTION_VISIT_COMPONENTS = {
  list: 1,
  add: 1,
  refresh: 1,
} as const;

export type SubjectCollectionWork = {
  nativeRequests: number;
  projectedRows: number;
  retainedRows: number;
  copiedBytes: number;
  pageLimit: number;
  cursorBytes: number;
  components: typeof SUBJECT_COLLECTION_VISIT_COMPONENTS;
};

export function retainedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function emptyCollectionWork(): SubjectCollectionWork {
  return {
    nativeRequests: 0,
    projectedRows: 0,
    retainedRows: 0,
    copiedBytes: 0,
    pageLimit: SUBJECT_COLLECTION_PAGE_LIMIT,
    cursorBytes: 0,
    components: SUBJECT_COLLECTION_VISIT_COMPONENTS,
  };
}

export function collectionPageWork<T>(
  page: BoundCollectionPage<T>,
  nativeRequests: number,
  extra?: { selected?: CapturedChooserTarget | null; command?: unknown },
): SubjectCollectionWork {
  const retained = {
    rows: page.rows,
    next: page.next,
    visit: page.visit,
    ...(page.count ? { count: page.count } : {}),
    ...(extra?.selected ? { selected: extra.selected } : {}),
    ...(extra?.command ? { command: extra.command } : {}),
  };
  return {
    nativeRequests,
    projectedRows: page.rows.length,
    retainedRows: page.rows.length,
    copiedBytes: retainedBytes(retained),
    pageLimit: SUBJECT_COLLECTION_PAGE_LIMIT,
    cursorBytes: (page.visit.cursor?.length ?? 0) + (page.next?.length ?? 0),
    components: SUBJECT_COLLECTION_VISIT_COMPONENTS,
  };
}

/** One list request and at most one current page, independent of catalogue size N. */
export function collectionWorkWithinBound(work: SubjectCollectionWork, catalogueSize: number): boolean {
  return (
    work.nativeRequests === SUBJECT_COLLECTION_VISIT_COMPONENTS.list &&
    work.projectedRows <= SUBJECT_COLLECTION_PAGE_LIMIT &&
    work.retainedRows <= SUBJECT_COLLECTION_PAGE_LIMIT &&
    work.pageLimit === SUBJECT_COLLECTION_PAGE_LIMIT &&
    work.cursorBytes <= SUBJECT_COLLECTION_CURSOR_MAX_LENGTH * 2 &&
    work.components.list === 1 &&
    catalogueSize >= 0
  );
}
