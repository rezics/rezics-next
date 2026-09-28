'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { ensureImportedShelf, importSelectedBook, type ImportIssue, type ImportRowResult } from './import-api.ts';
import { LIBRARY_IMPORT_COST, LibraryImportInvalid, parseLibraryImport, type ImportedBook } from './import-csv.ts';
import { lookupImportedBook, matchImportedBook, type ImportMatch } from './import-match.ts';
import type { LibraryMessages } from './messages.ts';
import type { CustomShelf } from './types.ts';

interface PreviewRow { book: ImportedBook; match: ImportMatch | null; lookupFailed: boolean;
  selected: string; rating: number | null; visibility: 'private' | 'public'; result: ImportRowResult | null }
const id = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const BATCH = 16;
const PAGE = 20;
const choiceWork = (value: string) => {
  const found = value.match(/(?:\/w\/|\/id\/)([0-9a-f-]{36})(?:[/?#]|$)/);
  return found ? `https://rezics.com/id/${found[1]}` : id.test(value) ? value : value;
};

/** The file stays in the browser. Matching is limited to three concurrent Main searches;
 * each saved row reports partial outcomes so a retry never hides an earlier success. */
export function LibraryImport({ agent, context, customShelves = [], locale, messages, lookup = lookupImportedBook,
  ensureShelf = ensureImportedShelf, importRow = importSelectedBook }: { agent: string; context: string | null;
  customShelves?: readonly CustomShelf[]; locale: UiLocale; messages: LibraryMessages;
  lookup?: typeof lookupImportedBook; ensureShelf?: typeof ensureImportedShelf;
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
      visibility: 'private', result: null })));
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
  async function save() {
    const selected = rows.flatMap((row, index) => id.test(row.selected) ? [{ row, index }] : []);
    if (!selected.length) return;
    setSaving(true); setSaved(0); setSummary(null);
    let done = 0, issues = 0;
    const shelfIds = new Map(customShelves.map(shelf => [shelf.name, shelf.id]));
    const names = [...new Set(selected.flatMap(({ row }) => row.book.shelves))]
      .filter(name => !['read', 'to-read', 'currently-reading', 'want-to-read'].includes(name.toLowerCase()));
    for (const name of names) if (!shelfIds.has(name)) {
      try { shelfIds.set(name, await ensureShelf(agent, name)); }
      catch { /* Rows needing this shelf report a partial import below. */ }
    }
    for (let offset = 0; offset < selected.length; offset += BATCH) {
      for (const { row, index } of selected.slice(offset, offset + BATCH)) {
        try {
          const outcome = await importRow(agent, row.book, { work: row.selected, rating: row.rating,
            reviewVisibility: row.visibility }, context, locale, shelfIds);
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
  const visible = rows.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.ceil(rows.length / PAGE);
  const selectedCount = rows.filter(row => id.test(row.selected)).length;
  return <section aria-labelledby="library-import" className="rounded-2xl border border-border/70 p-4 sm:p-5">
    <details>
      <summary className="cursor-pointer rounded-sm font-semibold text-lg outline-none focus-visible:ring-2
        focus-visible:ring-ring"><h2 id="library-import" className="inline">{t.importTitle}</h2></summary>
    <div className="grid gap-4 pt-4">
    <div className="grid gap-1">
      <p className="text-muted-foreground text-sm">{t.importHelp}</p>
      <p className="text-muted-foreground text-xs">{t.importShelvesPrivate}</p>
    </div>
    <label htmlFor="library-import-file" className="grid max-w-md gap-1 text-sm">
      <span>{t.importFile}</span>
      <Input id="library-import-file" type="file" accept=".csv,text/csv" disabled={matching || saving}
        onChange={event => { const file = event.target.files?.[0]; if (file) void load(file); }} /></label>
    {fileName ? <p className="text-muted-foreground text-xs">{t.importFileSelected({ name: fileName })}</p> : null}
    {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
    {matching ? <p role="status" className="text-muted-foreground text-sm">
      {t.importMatching({ done: number(matched), total: number(rows.length) })}</p> : null}
    {rows.length ? <>
      <ol className="grid divide-y divide-border/70">
        {visible.map((row, slot) => {
          const index = page * PAGE + slot;
          const { book, match } = row;
          const candidates = match?.candidates ?? [];
          return <li key={`${book.row}:${book.sourceId}`} className="grid gap-3 py-4 first:pt-0 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)]">
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
            </div>
            <div className="grid content-start gap-2">
              {match?.kind === 'matched' ? <p className="text-primary text-xs">{t.importMatched}</p>
                : <p className="text-muted-foreground text-xs">{row.lookupFailed ? t.shelfUnavailable
                  : match?.kind === 'ambiguous' ? t.importAmbiguous : match ? t.importMissing : t.importMatching({
                    done: '0', total: '1' })}</p>}
              {candidates.length ? <ChoiceSelect value={row.selected} label={t.importPick}
                options={[{ value: '', label: t.importSkip }, ...candidates.map(candidate => ({ value: candidate.work,
                  label: `${candidate.title} — ${candidate.authors.join(', ')}` }))]}
                onValueChange={selected => change(index, { selected })} />
                : <><Input aria-label={t.importPick} placeholder="REZICS Work URL" value={row.selected}
                  onChange={event => change(index, { selected: choiceWork(event.target.value) })} />
                  <Link href={`/search?q=${encodeURIComponent(book.title)}`}
                    className="text-primary text-sm underline">{t.importSearch}</Link></>}
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
      {summary ? <p role="status" className="text-sm">{t.importDone({ count: number(summary.done) })}
        {summary.issues ? ` ${t.importIssues({ count: number(summary.issues) })}` : ''}</p> : null}
    </> : null}
    </div>
    </details>
  </section>;
}
