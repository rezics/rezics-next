import { buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { cn } from '@rezics/ui/utils';
import { BookOpenIcon, ChevronRightIcon, FileTextIcon, ListTreeIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { localizedPath } from '../../i18n/locale.ts';
import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../discover/types.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { pickPositionLabel, type ReadingPositionPage } from '../wiki/position-picker.ts';
import { failureOf } from './failure.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure, RegionSkeleton } from './region.tsx';
import { chapterHref, idOf, shortId, type ContentsQuery, workHref } from './route.ts';
import type { Loaded, ReadFailure, WorkHeader } from './types.ts';

type InventoryGet = ReturnType<MainClient['v1']['reading-positions']>['get'];
type InventoryArgs = NonNullable<Parameters<InventoryGet>[0]>;
// These route adapters parse numeric input before constructing the Eden query.
export type BooksContentsInventoryQuery = NonNullable<InventoryArgs['query']> & { limit?: number };
export type BooksContentsInventoryAnswer = Awaited<ReturnType<InventoryGet>>;

/**
 * One proved inventory page. The chapter chooser reads 50 and stops; that
 * page is not the book. A cursor belongs to the limit that issued it.
 */
export const booksContentsInventoryLimit = 100;

type InventoryPosition = 'start' | 'all' | 'mine';

/** Query keys follow the recorded reading-position paths: position, language, q, limit, cursor, acting subject. */
export function booksContentsInventoryQuery(input: {
  position?: InventoryPosition;
  language?: string;
  q?: string;
  limit?: number;
  cursor?: string;
  actingSubject?: string;
}): BooksContentsInventoryQuery {
  return {
    position: input.position ?? 'start',
    ...(input.language ? { language: input.language } : {}),
    ...(input.q ? { q: input.q } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.actingSubject ? { actingSubject: input.actingSubject } : {}),
  };
}

/** The typed query for one recorded reading-position path, keeping that path's values. */
export function booksContentsInventoryQueryFromPath(path: string): { work: string; query: BooksContentsInventoryQuery } {
  const url = new URL(path, 'https://recorded.invalid');
  const position = url.searchParams.get('position');
  const limit = url.searchParams.get('limit');
  return {
    work: url.pathname.split('/').at(-1) ?? '',
    query: booksContentsInventoryQuery({
      position: position === 'all' || position === 'mine' || position === 'start' ? position : 'start',
      language: url.searchParams.get('language') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      limit: limit === null ? undefined : Number(limit),
      cursor: url.searchParams.get('cursor') ?? undefined,
      actingSubject: url.searchParams.get('actingSubject') ?? undefined,
    }),
  };
}

/**
 * Contents could not answer this view, so the page reads the chapter inventory.
 * A missing composition stays the empty contents state. A group page stays a group page.
 * A cursor Contents rejects can still be an inventory continuation.
 */
export function contentsReadsInventory(
  contents: Loaded<unknown>,
  query: ContentsQuery | null,
): boolean {
  if (!query || query.parent) return false;
  if (query.q || query.limit !== undefined) return true;
  if (contents.ok) return false;
  if (contents.failure === 'unavailable') return true;
  return Boolean(query.cursor) && (contents.failure === 'invalid' || contents.failure === 'moved');
}

export interface BooksContentsRecordedChapter {
  occurrence: string;
  readable?: boolean;
  label: string;
  language?: string;
  href: string | null;
}

export type BooksContentsRecordedView =
  | { kind: 'loading' }
  | {
    kind: 'refusal';
    /** The problem title Main recorded, when the answer carried one. */
    title: string | null;
    failure: ReadFailure;
    status?: number;
    problem?: unknown;
    workIri: string;
    restartHref: string;
    /** The contents path the label form posts to, without the current cursor. */
    searchHref: string;
    language?: string;
    q?: string;
    limit?: number;
  }
  | {
    kind: 'page';
    workIri: string;
    title: WorkHeader['title'] | null;
    /** Chapters on this page. Never a stand-in for the whole book. */
    count: number;
    complete: boolean;
    language?: string;
    /** The label this page searched for. First, restart and continuation links keep it. */
    q?: string;
    limit?: number;
    cursor?: string;
    nextHref: string | null;
    firstHref: string;
    searchHref: string;
    chapters: BooksContentsRecordedChapter[];
  };

function problemTitle(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('title' in value)) return null;
  const title = value.title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

/** A page that contradicts its own cursor is not a finished inventory and not a continuation. */
function inventoryAgrees(page: ReadingPositionPage, cursor: string | undefined): boolean {
  const indexing = page.search?.status === 'indexing';
  const stuck = !page.complete && (!page.nextCursor || page.nextCursor === cursor);
  const finishedButOpen = page.complete && (page.nextCursor !== null || indexing);
  return !stuck && !finishedButOpen;
}

function chapterOf(item: ReadingPositionPage['items'][number], locale: string, workRef: string, language: string | undefined):
  BooksContentsRecordedChapter {
  const named = pickPositionLabel(item.labels, locale);
  const id = idOf(item.occurrence);
  return {
    occurrence: item.occurrence,
    readable: item.role === 'chapter',
    label: named?.value ?? item.displayLabel ?? shortId(item.occurrence),
    language: named?.lang || undefined,
    href: item.role === 'chapter' && id ? chapterHref(workRef, id, language)
      : item.role === 'part' && item.target && idOf(item.target) ? workHref(idOf(item.target)!) : null,
  };
}

/** Contents address for one inventory page. A label search keeps `q` on the first page, a restart and a continuation. */
function contentsInventoryHref(workRef: string, language: string | undefined, q: string | undefined, cursor?: string, limit?: number): string {
  return workHref(workRef, 'contents', null, {
    language, ...(q ? { q } : {}), ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit: String(limit) } : {}),
  });
}

/**
 * What Contents renders for one reading-position answer. `complete` and the
 * next cursor come from that answer; a full page is not the whole inventory.
 */
export function mapBooksContentsRecordedPage(
  answer: Pick<BooksContentsInventoryAnswer, 'data' | 'error' | 'status'>,
  context: {
    workRef: string;
    workIri: string;
    locale: string;
    language?: string;
    /** Entered label. Omitted from the contents read; kept on every inventory link. */
    q?: string;
    limit?: number;
    cursor?: string;
    title?: WorkHeader['title'] | null;
  },
): BooksContentsRecordedView {
  const searchHref = workHref(context.workRef, 'contents');
  const firstHref = contentsInventoryHref(context.workRef, context.language, context.q, undefined, context.limit);
  const pending = answer.status === 202;
  if (pending || answer.error || !answer.data || !inventoryAgrees(answer.data, context.cursor)) {
    const status = pending ? 202 : answer.error?.status ?? 503;
    return {
      kind: 'refusal',
      title: answer.error ? problemTitle(answer.error.value) : null,
      failure: pending ? 'pending' : answer.error ? failureOf(status) : 'unavailable',
      status,
      ...(answer.error?.value !== undefined ? { problem: answer.error.value } : pending ? { problem: answer.data } : {}),
      workIri: answer.data?.work ?? context.workIri,
      restartHref: firstHref,
      searchHref,
      language: context.language,
      q: context.q,
      ...(context.limit !== undefined ? { limit: context.limit } : {}),
    };
  }
  const page = answer.data;
  return {
    kind: 'page',
    workIri: page.work,
    title: context.title ?? null,
    count: page.count.value,
    complete: page.complete,
    language: context.language,
    q: context.q,
      ...(context.limit !== undefined ? { limit: context.limit } : {}),
    cursor: context.cursor,
    nextHref: page.nextCursor
      ? contentsInventoryHref(context.workRef, context.language, context.q, page.nextCursor, context.limit) : null,
    firstHref,
    searchHref,
    chapters: page.items.map(item => chapterOf(item, context.locale, context.workRef, context.language)),
  };
}

/**
 * The contents page's inventory read. Production passes the request-cached host
 * from `reader()` after the Work and contents reads; a story passes the replaying
 * client. The page size stays the proved limit. A moved first page is read once
 * more; a cursor is not, because it belongs to the limit that issued it.
 * The label is `q` on this read only.
 */
export async function readContentsInventory(
  host: { main: MainClient; actingSubject?: string },
  input: {
    workId: string;
    workRef: string;
    workIri: string;
    locale: string;
    language?: string;
    q?: string;
    limit?: number;
    cursor?: string;
    title?: WorkHeader['title'] | null;
  },
): Promise<BooksContentsRecordedView> {
  const query = booksContentsInventoryQuery({
    language: input.language,
    q: input.q,
    cursor: input.cursor,
    actingSubject: host.actingSubject,
    limit: input.limit ?? booksContentsInventoryLimit,
  });
  const read = () => host.main.v1['reading-positions']({ work: input.workId }).get({ query });
  try {
    let answer = await read();
    if (answer.error?.status === 409 && !input.cursor) answer = await read();
    return mapBooksContentsRecordedPage(answer, input);
  } catch {
    return {
      kind: 'refusal', title: null, failure: 'unavailable', workIri: input.workIri,
      restartHref: contentsInventoryHref(input.workRef, input.language, input.q, undefined, input.limit),
      searchHref: workHref(input.workRef, 'contents'), language: input.language, q: input.q,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    };
  }
}

/** Label search for this contents page. The form drops the cursor so a new label starts at the first window. */
export function ContentsLabelSearch({ action, language, q, limit, locale, messages: t }: {
  action: string; language?: string; q?: string; limit?: number; locale: UiLocale; messages: WorkPageMessages;
}) {
  return <form action={localizedPath(action, locale)} method="get" role="search" aria-label={t.searchContents}
    className="flex min-w-0 flex-wrap items-end gap-3">
    <label className="grid min-w-0 flex-1 basis-48 gap-1 text-sm">{t.searchContents}
      <Input type="search" name="q" defaultValue={q ?? ''} maxLength={200} enterKeyHint="search" /></label>
    <label className="grid min-w-0 flex-1 basis-32 gap-1 text-sm">{t.language}
      <Input name="language" defaultValue={language ?? ''} placeholder={t.languageHint} maxLength={80} /></label>
    <label className="grid gap-1 text-sm">{t.contentsPageSize}
      <Input type="number" name="limit" defaultValue={limit ?? booksContentsInventoryLimit}
        min={1} max={100} step={1} className="w-24" /></label>
    <button type="submit" className={cn(buttonVariants(), 'shrink-0')}>{t.searchContents}</button>
  </form>;
}

/** The chapter inventory page. Loading, a populated page and a refusal share this view. */
export function BooksContentsRecordedPage({ view, locale, messages }: {
  view: BooksContentsRecordedView;
  locale: UiLocale;
  messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  if (view.kind === 'loading') {
    return <RegionSkeleton id="work-contents" title={t.contents} label={t.loadingRegion} lines={8} />;
  }
  const search = <ContentsLabelSearch action={view.searchHref} language={view.language} q={view.q} limit={view.limit} locale={locale}
    messages={messages} />;
  if (view.kind === 'refusal') {
    return <Region id="work-contents" title={t.contents}>
      {search}
      <RegionFailure title={view.title ?? t.contentsUnavailable} failure={view.failure} messages={messages}
        restartHref={view.restartHref} role={view.failure === 'pending' ? 'status' : 'alert'} />
    </Region>;
  }
  const first = !view.cursor ? view.chapters.find(chapter => chapter.readable && chapter.href) : undefined;
  // An open page can list nothing and still continue. Only a complete page is an empty inventory.
  const finishedEmpty = view.complete && view.chapters.length === 0;
  return <Region id="work-contents" title={t.contents}
    aside={<span className="text-muted-foreground text-sm">{t.onThisPage(view.count)}</span>}>
    {search}
    {view.title ? <p lang={view.title.language} dir={view.title.direction} className="text-balance break-words font-medium">
      {view.title.value}</p> : null}
    {first?.href ? <Link href={first.href} className={cn(buttonVariants(), 'justify-self-start')}>
      <BookOpenIcon aria-hidden="true" />{t.startReading}</Link> : null}
    {view.chapters.length ? <ol className="grid min-w-0 divide-y divide-border/60 border-border/60 border-y">
      {view.chapters.map(chapter => <li key={chapter.occurrence} data-occurrence={chapter.occurrence}>
        {chapter.href ? <Link href={chapter.href} className="-mx-2 flex min-w-0 items-center gap-3 rounded-xl px-2 py-3
          outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span lang={chapter.language} className="min-w-0 flex-1 truncate font-medium">{chapter.label}</span>
          <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
        </Link> : <div className="flex min-w-0 items-center gap-3 py-3">
          <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span lang={chapter.language} className="min-w-0 flex-1 truncate font-medium">{chapter.label}</span>
        </div>}
      </li>)}
    </ol> : finishedEmpty ? <EmptyState icon={ListTreeIcon} headingLevel={3} title={t.noContents} /> : null}
    {view.cursor || view.nextHref ? <nav aria-label={t.pagination} className="flex flex-wrap justify-between gap-2">
      {view.cursor ? <Link href={view.firstHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.firstPage}</Link> : <span />}
      {view.nextHref ? <Link href={view.nextHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.nextPage}</Link> : null}
    </nav> : null}
  </Region>;
}
