'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { UploadCloudIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { adoptOpenLibraryBook, ensureImportedShelf, importSelectedBook, inspectImportedBook,
  type ImportIssue, type ImportRowResult } from './import-api.ts';
import { LIBRARY_IMPORT_COST, LibraryImportInvalid, parseLibraryImport, type ImportedBook } from './import-csv.ts';
import { lookupImportedBook, lookupOpenLibraryBook, matchImportedBook,
  type ImportMatch, type OpenLibraryCandidate } from './import-match.ts';
import type { LibraryMessages } from './messages.ts';
import type { CustomShelf } from './types.ts';

interface PreviewRow { book: ImportedBook; match: ImportMatch | null; lookupFailed: boolean;
  selected: string; rating: number | null; visibility: 'private' | 'public'; result: ImportRowResult | null;
  search: string; searching: boolean; skipped: boolean; conflictChoice?: 'keep' | 'replace';
  openLibrary: OpenLibraryCandidate[] | null; openLibraryBusy: boolean; openLibraryError: boolean;
  manual: boolean }
const id = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const BATCH = 16;
const PAGE = 20;

/** The file stays in the browser. Matching is limited to three concurrent Main searches;
 * each saved row reports partial outcomes so a retry never hides an earlier success. */
export function LibraryImport({ agent, context, customShelves = [], locale, messages, lookup = lookupImportedBook,
  lookupSource = lookupOpenLibraryBook, adoptSource = adoptOpenLibraryBook,
  ensureShelf = ensureImportedShelf, inspectRow = inspectImportedBook,
  importRow = importSelectedBook }: { agent: string; context: string | null;
  customShelves?: readonly CustomShelf[]; locale: UiLocale; messages: LibraryMessages;
  lookup?: typeof lookupImportedBook; ensureShelf?: typeof ensureImportedShelf;
  lookupSource?: typeof lookupOpenLibraryBook; adoptSource?: typeof adoptOpenLibraryBook;
  inspectRow?: typeof inspectImportedBook;
  importRow?: typeof importSelectedBook }) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const run = useRef(0);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [matching, setMatching] = useState(false);
  const [matched, setMatched] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(0);
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ done: number; issues: number } | null>(null);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const issueText = (issue: ImportIssue) => ({
    'state-unavailable': t.importStateUnavailable, 'status-changed': t.importStatusChanged,
    'status-failed': t.importStatusFailed, 'rating-needs-choice': t.importRatingChoiceNeeded,
    'rating-changed': t.importRatingChanged, 'rating-failed': t.importRatingFailed,
    'review-needs-rating': t.importReviewNeedsRating, 'review-changed': t.importReviewChanged,
    'review-failed': t.importReviewFailed, 'shelf-failed': t.importShelfFailed,
  })[issue];

  function change(index: number, patch: Partial<PreviewRow>) {
    setRows(current => current.map((row, at) => at === index ? { ...row, ...patch } : row));
  }
  async function load(file: File) {
    const generation = ++run.current;
    setFileName(file.name);
    setError(null); setSummary(null); setPage(0); setMatched(0);
    let books: ImportedBook[];
    try {
      if (file.size > LIBRARY_IMPORT_COST.bytes) throw new LibraryImportInvalid('File too large');
      books = parseLibraryImport(await file.text()).books;
    } catch { setRows([]); setError(t.importInvalid); return; }
    setRows(books.map(book => ({ book, match: null, lookupFailed: false, selected: '',
      rating: Number.isInteger(book.rating) ? book.rating : null,
      visibility: 'private', result: null, search: book.title, searching: false, skipped: false,
      openLibrary: null, openLibraryBusy: false, openLibraryError: false, manual: false })));
    setMatching(true);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, books.length) }, async () => {
      while (next < books.length && generation === run.current) {
        const index = next++;
        const book = books[index]!;
        try {
          const match = matchImportedBook(book, await lookup(book, locale));
          if (generation === run.current) change(index, { match, selected: match.selected ?? '' });
        } catch { if (generation === run.current) change(index, { lookupFailed: true }); }
        if (generation === run.current) setMatched(count => count + 1);
      }
    }));
    if (generation === run.current) setMatching(false);
  }
  async function search(index: number) {
    const row = rows[index];
    if (!row?.search.trim()) return;
    change(index, { searching: true, lookupFailed: false });
    try {
      const candidates = await lookup({ ...row.book, title: row.search.trim(), isbn: null }, locale);
      change(index, { match: { kind: candidates.length ? 'ambiguous' : 'not-found', selected: null,
        candidates, reason: candidates.length ? 'review' : null }, searching: false });
    } catch { change(index, { searching: false, lookupFailed: true }); }
  }
  async function findSource(index: number) {
    const row = rows[index];
    if (!row) return;
    change(index, { openLibraryBusy: true, openLibraryError: false });
    try { change(index, { openLibrary: await lookupSource(agent, row.book), openLibraryBusy: false }); }
    catch { change(index, { openLibraryBusy: false, openLibraryError: true }); }
  }
  async function addSource(index: number, workId: string) {
    change(index, { openLibraryBusy: true, openLibraryError: false });
    try {
      const selected = await adoptSource(agent, workId, locale);
      change(index, { selected, skipped: false, openLibraryBusy: false,
        match: { kind: 'matched', selected, candidates: [], reason: 'review' } });
    } catch { change(index, { openLibraryBusy: false, openLibraryError: true }); }
  }
  async function save() {
    const selected = rows.flatMap((row, index) => !row.skipped && id.test(row.selected) ? [{ row, index }] : []);
    if (!selected.length) return;
    setSaving(true); setSaved(0); setSummary(null);
    let done = 0, issues = 0;
    const pending: typeof selected = [];
    for (const { row, index } of selected) {
      const selection = { work: row.selected, rating: row.rating,
        reviewVisibility: row.visibility, conflictChoice: row.conflictChoice };
      try {
        const found = await inspectRow(agent, row.book, selection, context);
        if (found.length) { change(index, { result: { work: row.selected, applied: [], issues: found } }); issues++; }
        else pending.push({ row, index });
      } catch {
        change(index, { result: { work: row.selected, applied: [], issues: ['state-unavailable'] } }); issues++;
      }
    }
    setSaved(issues);
    const shelfIds = new Map(customShelves.map(shelf => [shelf.name, shelf.id]));
    const names = [...new Set(pending.flatMap(({ row }) => row.book.shelves))]
      .filter(name => !['read', 'to-read', 'currently-reading', 'want-to-read'].includes(name.toLowerCase()));
    for (const name of names) if (!shelfIds.has(name)) {
      try { shelfIds.set(name, await ensureShelf(agent, name)); }
      catch { /* Rows needing this shelf report a partial import below. */ }
    }
    for (let offset = 0; offset < pending.length; offset += BATCH) {
      for (const { row, index } of pending.slice(offset, offset + BATCH)) {
        try {
          const outcome = await importRow(agent, row.book, { work: row.selected, rating: row.rating,
            reviewVisibility: row.visibility, conflictChoice: row.conflictChoice }, context, locale, shelfIds);
          change(index, { result: outcome });
          if (outcome.issues.length) issues++;
          else done++;
        } catch {
          issues++;
          change(index, { result: { work: row.selected, applied: [], issues: ['state-unavailable'] } });
        }
        setSaved(count => count + 1);
      }
    }
    setSaving(false); setSummary({ done, issues });
    router.refresh();
  }
  const needsAttention = (row: PreviewRow) => !row.skipped && (!id.test(row.selected) || !!row.result?.issues.length);
  const shown = filter === 'attention' ? rows.flatMap((row, index) => needsAttention(row) ? [{ row, index }] : [])
    : rows.map((row, index) => ({ row, index }));
  const visible = shown.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.ceil(shown.length / PAGE);
  const selectedCount = rows.filter(row => !row.skipped && id.test(row.selected)).length;
  const attentionCount = rows.filter(needsAttention).length;
  const skippedCount = rows.filter(row => row.skipped).length;
  return <section aria-labelledby="library-import" className="rounded-2xl border border-border/70 p-4 sm:p-5">
    <details>
      <summary className="cursor-pointer rounded-sm font-semibold text-lg outline-none focus-visible:ring-2
        focus-visible:ring-ring"><h2 id="library-import" className="inline">{t.importTitle}</h2></summary>
    <div className="grid gap-4 pt-4">
    <div className="grid gap-1">
      <p className="text-muted-foreground text-sm">{t.importHelp}</p>
      <p className="text-muted-foreground text-xs">{t.importShelvesPrivate}</p>
    </div>
    <label htmlFor="library-import-file" onDragEnter={event => { event.preventDefault(); setDragging(true); }}
      onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false);
        const file = event.dataTransfer.files[0]; if (file && !matching && !saving) void load(file); }}
      className={`flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed
        px-4 py-5 text-center text-sm transition-colors ${dragging ? 'border-primary bg-primary/10' : 'border-border bg-muted/30 hover:border-primary'}`}>
      <UploadCloudIcon aria-hidden="true" className="size-6 text-primary" />
      <span>{t.importFile}</span><span className="text-muted-foreground text-xs">{t.importDrop}</span>
      <Input id="library-import-file" type="file" aria-label={t.importFile} accept=".csv,text/csv"
        disabled={matching || saving}
        className="sr-only" onChange={event => { const file = event.target.files?.[0]; if (file) void load(file); }} /></label>
    {fileName ? <p className="text-muted-foreground text-xs">{t.importFileSelected({ name: fileName })}</p> : null}
    {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
    {matching ? <p role="status" className="text-muted-foreground text-sm">
      {t.importMatching({ done: number(matched), total: number(rows.length) })}</p> : null}
    {rows.length ? <>
      {!matching ? <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-sm"
        role="status"><span>{t.importFound(selectedCount)}</span>
        <span>{t.importNeedMatch(attentionCount)}</span>
        <span>{t.importSkipped(skippedCount)}</span></div> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={filter === 'all' ? 'default' : 'outline'} onClick={() => { setFilter('all'); setPage(0); }}>
          {t.importAll}</Button>
        <Button size="sm" variant={filter === 'attention' ? 'default' : 'outline'}
          onClick={() => { setFilter('attention'); setPage(0); }}>{t.importAttention}</Button>
        <Button size="sm" variant="outline" disabled={!attentionCount}
          onClick={() => setRows(current => current.map(row => needsAttention(row)
            ? { ...row, skipped: true, selected: '' } : row))}>{t.importSkipAttention}</Button>
      </div>
      <ol className="grid divide-y divide-border/70">
        {visible.map(({ row, index }) => {
          const { book, match } = row;
          const candidates = match?.candidates ?? [];
          return <li key={`${book.row}:${book.sourceId}`} className="grid gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)]">
            <div className="flex min-w-0 gap-3">
              {candidates[0] ? <CatalogueCover work={{ id: candidates[0].work, title: { value: candidates[0].title,
                language: locale, direction: 'ltr', basis: 'requested' }, authors: candidates[0].authors.map(name => ({ name, href: null })),
                cover: candidates[0].cover ?? null, kind: candidates[0].kind ?? 'book' }}
                size="xs" className="w-12 shrink-0" /> : null}
              <div className="grid min-w-0 content-start gap-1">
              <p className="font-medium">{book.title}</p>
              <p className="text-muted-foreground text-sm">{book.author}</p>
              {book.status ? <p className="text-muted-foreground text-xs">{book.status === 'read' ? t.read
                : book.status === 'reading' ? t.reading : t.wantToRead}</p> : null}
              {book.rating !== null ? <p className="text-muted-foreground text-xs">
                {t.importSourceRating({ value: String(book.rating) })}</p> : null}
              {book.review ? <p className="line-clamp-2 text-muted-foreground text-xs">{book.review}</p> : null}
              {row.result?.issues.length ? <p role="alert" className="text-destructive text-xs">
                {row.result.issues.map(issueText).join(' ')}</p> : null}
              {row.result?.issues.some(issue => issue.endsWith('-changed')) ? <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={row.conflictChoice === 'keep' ? 'default' : 'outline'}
                  onClick={() => change(index, { conflictChoice: 'keep' })}>{t.importKeepMine}</Button>
                <Button size="sm" variant={row.conflictChoice === 'replace' ? 'default' : 'outline'}
                  onClick={() => change(index, { conflictChoice: 'replace' })}>{t.importUseImported}</Button>
              </div> : null}
              </div>
            </div>
            <div className="grid content-start gap-2">
              <Button size="sm" variant={row.skipped ? 'default' : 'ghost'} className="justify-self-start"
                onClick={() => change(index, { skipped: !row.skipped })}>{row.skipped ? t.importUnskip : t.importSkip}</Button>
              {match?.kind === 'matched' ? <p className="text-primary text-xs">{t.importMatched}</p>
                : <p className="text-muted-foreground text-xs">{row.lookupFailed ? t.shelfUnavailable
                  : match?.kind === 'ambiguous' ? t.importAmbiguous : match ? t.importMissing : t.importMatching({
                    done: '0', total: '1' })}</p>}
              {row.selected && !row.manual ? <Button size="sm" variant="outline" className="justify-self-start"
                onClick={() => change(index, { manual: true, selected: '' })}>{t.importChangeMatch}</Button> : null}
              {candidates.length && (match?.kind !== 'matched' || row.manual) ? <div className="grid gap-2"><ChoiceSelect value={row.selected} label={t.importPick}
                options={[{ value: '', label: t.importSkip }, ...candidates.map(candidate => ({ value: candidate.work,
                  label: `${candidate.title} — ${candidate.authors.join(', ')}` }))]}
                onValueChange={selected => change(index, { selected, skipped: false })} />
                {candidates.map(candidate => <Button key={candidate.work} size="sm" variant="outline"
                  onClick={() => change(index, { selected: candidate.work, skipped: false })}
                  className="h-auto w-full justify-start gap-2 whitespace-normal p-2 text-left text-xs">
                  <CatalogueCover work={{ id: candidate.work, title: { value: candidate.title, language: locale,
                    direction: 'ltr', basis: 'requested' }, authors: candidate.authors.map(name => ({ name, href: null })),
                    cover: candidate.cover ?? null, kind: candidate.kind ?? 'book' }} size="xs" className="w-9 shrink-0" />
                  <span>{candidate.title}<br />{candidate.authors.join(', ')}</span></Button>)}</div> : null}
              {(!row.selected || row.manual) ? <div className="flex gap-2"><Input aria-label={t.importSearch} value={row.search}
                onChange={event => change(index, { search: event.target.value })}
                onKeyDown={event => { if (event.key === 'Enter') void search(index); }} />
                <Button size="sm" variant="outline" disabled={row.searching} onClick={() => void search(index)}>
                  {t.importSearch}</Button></div> : null}
              {!row.selected && !row.skipped ? <div className="grid gap-2">
                <Button size="sm" variant="outline" disabled={row.openLibraryBusy}
                  onClick={() => void findSource(index)}>{t.importFindOpenLibrary}</Button>
                {row.openLibraryError ? <p role="alert" className="text-destructive text-xs">
                  {t.importOpenLibraryFailed}</p> : null}
                {row.openLibrary?.length === 0 ? <p className="text-muted-foreground text-xs">
                  {t.importOpenLibraryMissing}</p> : null}
                {row.openLibrary?.map(candidate => <div key={candidate.workId}
                  className="flex items-center justify-between gap-2 rounded-lg border p-2 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <CatalogueCover work={{ id: candidate.workId, title: { value: candidate.title,
                      language: locale, direction: 'ltr', basis: 'requested' },
                      authors: candidate.authors.map(name => ({ name, href: null })), cover: null, kind: 'book' }}
                      size="xs" className="w-9 shrink-0" />
                    <span>{candidate.title}<br />{candidate.authors.join(', ')}</span>
                  </div>
                  <Button size="sm" variant="outline" disabled={row.openLibraryBusy}
                    onClick={() => void addSource(index, candidate.workId)}>{t.importAddOpenLibrary}</Button>
                </div>)}
              </div> : null}
              {book.rating !== null && !Number.isInteger(book.rating) ? <>
                <p className="text-muted-foreground text-xs">{t.importRatingUnsupported}</p>
                <ChoiceSelect value={row.rating?.toString() ?? ''} label={t.importRatingChoice}
                  options={[{ value: '', label: t.importSkip }, ...[1, 2, 3, 4, 5].map(value => ({
                    value: String(value), label: String(value) }))]}
                  onValueChange={value => change(index, { rating: value ? Number(value) : null })} />
              </> : null}
              {book.review ? <ChoiceSelect value={row.visibility} label={t.importReviewVisibility}
                options={[{ value: 'private', label: t.importReviewPrivate },
                  { value: 'public', label: t.importReviewPublic }]}
                onValueChange={value => change(index, { visibility: value === 'public' ? 'public' : 'private' })} /> : null}
            </div>
          </li>;
        })}
      </ol>
      {pages > 1 ? <nav aria-label={t.pages} className="flex items-center justify-between gap-3">
        <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
          {t.previousPage}</Button>
        <span className="text-muted-foreground text-sm">{t.pageOf({ page: number(page + 1), pages: number(pages) })}</span>
        <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
          {t.nextPage}</Button></nav> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={matching || saving || !selectedCount}>{t.importSave}</Button>
        {saving ? <p role="status" className="text-muted-foreground text-sm">
          {t.importSaving({ done: number(saved), total: number(selectedCount) })}</p> : null}
      </div>
      {summary ? <p role="status" className="text-sm">{t.importDone(summary.done)}
        {summary.issues ? ` ${t.importIssues(summary.issues)}` : ''} <Link href="/library"
          className="text-primary underline">{t.importViewLibrary}</Link></p> : null}
    </> : null}
    </div>
    </details>
  </section>;
}
