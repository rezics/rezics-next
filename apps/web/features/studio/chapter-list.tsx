'use client';

import { Alert, AlertDescription } from '@rezics/ui/alert';
import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ArrowDownIcon, ArrowUpIcon, BookOpenIcon, LockIcon, PenLineIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { relativeTime } from '../feed/time.ts';
import Link from '../shell/localized-link.tsx';
import { chapterHref as readerChapterHref } from '../work-page/route.ts';
import { chapterVariant, createChapter, moveChapter, readCompositionHead } from './content-api.ts';
import { browserStorage, type ChapterMemory, chapterMemoryKey, readChapterMemory } from './local-draft.ts';
import type { StudioMessages } from './messages.ts';
import { chapterHref } from './agent.ts';
import { lengthUnit } from './counts.ts';
import { lengthLabel } from './parts.tsx';
import type { ContentsItem, ContentsPage, Loaded, MainClient } from './types.ts';

type T = ContractOf<StudioMessages>;

export interface ChapterListProps {
  agent: AgentOption;
  book: { id: string; mainVersion: string; title: string; language: string };
  /** One page of the Book's chapters; `none` while the Book has no composition. */
  page: Loaded<ContentsPage> | { ok: false; failure: 'none' };
  /** Chapters before this page, for numbering; later pages come from Main's cursor. */
  offset?: number;
  moreHref?: string | null;
  locale: UiLocale;
  messages: StudioMessages;
  /** Stories pass a stand-in Main; the app uses the browser client through the BFF. */
  main?: MainClient;
  /** Stories pin the clock for relative save times. */
  now?: number;
}

type Row = Pick<ContentsItem, 'occurrence' | 'label' | 'target' | 'availability'>;
/** Marks a row added here whose place Main has not named yet. */
const UNPLACED = 'unplaced:';

function Status({ row, memory, t }: { row: Row; memory: ChapterMemory | undefined; t: T }) {
  const changed = memory?.publishedHead && memory.head && memory.head !== memory.publishedHead;
  if (row.availability === 'available') {
    return changed ? <Badge variant="warning">{t.chapterChanged}</Badge> : <Badge variant="success">{t.statePublished}</Badge>;
  }
  return <Badge variant="outline">{t.stateDraft}</Badge>;
}

/**
 * A Book's chapters in reading order, as its writer manages them: where each
 * stands, words and last save as this device knows them, reordering on the
 * composition's current head, and a new chapter added in place at the end.
 */
export function ChapterList({ agent, book, page, offset = 0, moreHref = null, locale, messages, main, now }: ChapterListProps) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const formId = useId();
  const initial = useMemo(() => page.ok ? page.data.items.filter(item => item.role === 'chapter') : [], [page]);
  const [rows, setRows] = useState<Row[]>(initial);
  const [composition, setComposition] = useState(page.ok
    ? { structure: page.data.composition, head: page.data.compositionRevision } : null);
  useEffect(() => {
    setRows(initial);
    if (page.ok) setComposition({ structure: page.data.composition, head: page.data.compositionRevision });
  }, [initial, page]);

  // What this device remembers of each chapter's draft: Main does not yet let a writer read variant heads.
  const [memory, setMemory] = useState<Record<string, ChapterMemory>>({});
  const [revisions, setRevisions] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const storage = browserStorage();
    void Promise.all(rows.filter(row => row.target).map(async row => {
      const variant = await chapterVariant(row.target!, row.label?.language ?? book.language);
      return [row.target!, readChapterMemory(storage, chapterMemoryKey(agent.iri, variant))] as const;
    })).then(entries => {
      if (!active) return;
      const known = Object.fromEntries(entries.filter((entry): entry is readonly [string, ChapterMemory] => !!entry[1]));
      setMemory(known);
      setRevisions(Object.fromEntries(Object.entries(known).flatMap(([id, value]) => value.head ? [[id, value.head]] : [])));
    });
    return () => { active = false; };
  }, [rows, agent.iri, book.language]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const attempt = useRef<string | null>(null);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('title') ?? '').trim();
    if (!name || busy) return;
    setBusy('add');
    setError(null);
    // One key per chapter the writer asked for: a retry after a lost answer replays instead of adding it twice.
    attempt.current ??= crypto.randomUUID();
    const input = { actingSubject: agent.iri, book: book.id, mainVersion: book.mainVersion, title: name,
      language: book.language, key: attempt.current };
    try {
      let result = await createChapter({ ...input, composition }, main);
      if (result.outcome === 'stale') {
        // Another tab changed the chapter list first: place it on the list's current head instead.
        const current = await readCompositionHead(agent.iri, book.id, book.language, main);
        if (current && current !== 'unavailable') result = await createChapter({ ...input, composition: current }, main);
      }
      if (result.outcome === 'done' && result.chapter && result.structure) {
        attempt.current = null;
        setComposition({ structure: result.structure, head: result.head });
        // Until Main names the new place (the refresh below), the row cannot be moved.
        setRows(current => [...current, { occurrence: result.occurrence ?? `${UNPLACED}${result.chapter}`,
          label: { value: name, language: book.language }, target: result.chapter!, availability: 'unavailable' }]);
        form.reset();
        setAnnouncement(t.chapterAdded({ title: name }));
        router.refresh();
      } else {
        setError(result.outcome === 'denied' ? t.chapterAddDenied : result.outcome === 'pending' ? t.chapterAddPending
          : t.chapterAddFailed);
      }
    } catch {
      setError(t.chapterAddFailed);
    } finally { setBusy(null); }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const row = rows[index];
    const target = index + direction;
    if (!row || !composition || target < 0 || target >= rows.length || busy) return;
    if ([row, rows[target]].some(item => item?.occurrence.startsWith(UNPLACED))) return;
    // Up: after the chapter two above (or first). Down: after the chapter below.
    const after = direction === -1 ? target === 0 ? null : rows[target - 1]!.occurrence : rows[target]!.occurrence;
    setBusy(row.occurrence);
    setError(null);
    try {
      const result = await moveChapter({ actingSubject: agent.iri, structure: composition.structure, head: composition.head,
        occurrence: row.occurrence, after, key: crypto.randomUUID() }, main);
      if (result.outcome === 'done') {
        setComposition({ ...composition, head: result.head });
        setRows(current => {
          const next = [...current];
          next.splice(index, 1);
          next.splice(target, 0, row);
          return next;
        });
        setAnnouncement(t.chapterMoved({ title: row.label?.value ?? t.chapterHidden, position: String(offset + target + 1) }));
      } else {
        setError(result.outcome === 'denied' ? t.chapterMoveDenied : t.chapterMoveFailed);
      }
      router.refresh();
    } catch {
      setError(t.chapterMoveFailed);
    } finally { setBusy(null); }
  };

  const failed = !page.ok && page.failure !== 'none' && page.failure !== 'missing';
  const clock = now ?? Date.now();
  // Moving up to the top of a later page would need the chapter before it, which is on the page before.
  const firstMovable = offset > 0 ? 2 : 1;
  return <div className="grid gap-4">
    <p role="status" className="sr-only">{announcement}</p>
    {failed ? <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
      <AlertDescription className="text-destructive-foreground">{t.chaptersFailed}</AlertDescription></Alert> : null}
    {rows.length ? <ol className="grid divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/60 bg-card">
      {rows.map((row, index) => {
        const known = row.target ? memory[row.target] : undefined;
        const language = row.label?.language ?? book.language;
        const stats = [typeof known?.length === 'number'
          ? lengthLabel({ unit: lengthUnit(language), value: known.length }, t) : null,
          known?.savedAt ? t.savedWhen({ time: relativeTime(known.savedAt, clock, locale, 'long') }) : null]
          .filter((part): part is string => part !== null);
        const name = row.label?.value ?? t.chapterHidden;
        const placed = (item: Row | undefined) => Boolean(item) && !item!.occurrence.startsWith(UNPLACED);
        const fixed = !placed(row);
        return <li key={row.occurrence} className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-3
          sm:grid-cols-[2.5rem_minmax(0,1fr)_auto] sm:px-4">
          <span className="text-center font-medium text-muted-foreground text-sm tabular-nums">{offset + index + 1}</span>
          <div className="grid min-w-0 gap-1">
            <p lang={row.label?.language} className={row.target ? 'font-medium font-work-title [overflow-wrap:anywhere]'
              : 'flex items-center gap-1.5 text-muted-foreground'}>
              {row.target ? null : <LockIcon aria-hidden="true" className="size-4" />}{name}</p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
              {row.target ? <Status row={row} memory={known} t={t} /> : null}
              {stats.map(part => <span key={part}>{part}</span>)}
            </p>
          </div>
          <div className="col-start-2 flex flex-wrap items-center gap-1 sm:col-start-3 sm:justify-end">
            {row.target ? <Link href={chapterHref(agent, book.id, row.target, revisions[row.target])}
              aria-label={t.writeNamed({ title: name })} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <PenLineIcon aria-hidden="true" />{t.writeChapter}</Link> : null}
            {row.availability === 'available' && row.target ? <Link href={readerChapterHref(book.id.slice(-36),
              row.occurrence.slice(-36), book.language)} aria-label={t.readNamed({ title: name })}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              <BookOpenIcon aria-hidden="true" /><span className="max-sm:sr-only">{t.readChapter}</span></Link> : null}
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t.moveUp({ title: name })}
              disabled={index < firstMovable || fixed || !placed(rows[index - 1]) || busy !== null}
              onClick={() => void move(index, -1)}>
              <ArrowUpIcon aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t.moveDown({ title: name })}
              disabled={index === rows.length - 1 || fixed || !placed(rows[index + 1]) || busy !== null}
              onClick={() => void move(index, 1)}>
              <ArrowDownIcon aria-hidden="true" /></Button>
          </div>
        </li>;
      })}
    </ol> : page.ok || page.failure === 'none' || page.failure === 'missing'
      ? <p className="rounded-2xl border border-border/80 border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
        {t.noChapters}</p> : null}
    {moreHref ? <Link href={moreHref} className={buttonVariants({ variant: 'outline', className: 'justify-self-start' })}>
      {t.moreChapters}</Link> : null}
    {error ? <Alert variant="destructive"><TriangleAlertIcon aria-hidden="true" />
      <AlertDescription role="alert" className="text-destructive-foreground">{error}</AlertDescription></Alert> : null}
    <form id={formId} onSubmit={event => void add(event)} className="flex flex-col gap-2 rounded-2xl border border-border/60
      bg-muted/40 p-3 sm:flex-row sm:items-end">
      <label className="grid min-w-0 flex-1 gap-1.5 text-sm"><span className="font-medium">{t.newChapter}</span>
        <Input name="title" maxLength={200} required
          placeholder={t.newChapterPlaceholder({ number: String(offset + rows.length + 1) })} lang={book.language}
          className="font-work-title" autoComplete="off" /></label>
      <Button type="submit" disabled={busy !== null} isLoading={busy === 'add'}>
        <PlusIcon aria-hidden="true" />{busy === 'add' ? t.addingChapter : t.addChapter}</Button>
    </form>
  </div>;
}
