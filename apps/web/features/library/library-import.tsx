'use client';

import { Button } from '@rezics/ui/button';
import { Input } from '@rezics/ui/input';
import { Progress } from '@rezics/ui/progress';
import { cn } from '@rezics/ui/utils';
import { UploadCloudIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { useReadingLanguages } from '../content-language/use-reading-languages.ts';
import { writingLanguage } from '../content-language/writing-language.ts';
import { type ApplyProgress, UPLOAD_LIMIT_BYTES, type CsvInspection, type CsvMapping, type ImportApi, ImportError, type ImportFormat,
  type ImportRow, mainImportApi, type RowResolution } from './import-api.ts';
import { browserImportShelf, type ImportShelf, type PendingImport } from './import-store.ts';
import { applyFinished, applyStarted, countGroups, groupOf, loadAllRows, needsChoice, replaceRow, reloadRow,
  type RowGroup, rowGroups } from './import-rows.ts';
import { CsvMapper } from './library-import-map.tsx';
import { ImportRowItem } from './library-import-rows.tsx';
import type { LibraryMessages } from './messages.ts';

const PAGE = 20;
const formats = ['goodreads', 'storygraph', 'mal', 'vndb', 'rezics', 'generic-csv'] as const satisfies readonly ImportFormat[];
const accept: Record<ImportFormat, string> = { goodreads: '.csv,text/csv', storygraph: '.csv,text/csv',
  'generic-csv': '.csv,text/csv', mal: '.xml,text/xml,application/xml', vndb: '.xml,text/xml,application/xml',
  rezics: '.json,application/json' };

/** One working import: the rows Main reported so far, and where the reader is in reviewing, applying and finishing. */
interface Active { entry: PendingImport; rows: ImportRow[]; loaded: boolean; progress: ApplyProgress | null;
  stopped: boolean; finished: boolean }

/**
 * Library import. Main parses the file, matches every row and applies the reviewed result; this component
 * uploads the text, shows each row Main reports (matched, ambiguous with candidates, not found), forwards
 * the reader's choices and repeats apply until Main has none pending. A reload or a second visit comes
 * back to the same upload, because Main keeps it for seven days and this browser remembers its id.
 */
export function LibraryImport({ agent, context, locale, messages, api, shelf = browserImportShelf, initialOpen = false }: {
  agent: string; context: string | null; locale: UiLocale; messages: LibraryMessages; api?: ImportApi;
  shelf?: ImportShelf; initialOpen?: boolean;
}) {
  const t = materializeData(messages, { locale });
  const router = useRouter();
  const [client] = useState(() => api ?? mainImportApi(agent));
  // Imported reviews are in a language the reader knows, not the page's: their first reading language, else unspecified.
  const reviewLanguage = writingLanguage({ reading: useReadingLanguages(agent) });
  const run = useRef(0);
  const [open, setOpen] = useState(initialOpen);
  const [pending, setPending] = useState<PendingImport[]>([]);
  const [format, setFormat] = useState<ImportFormat>('goodreads');
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mapping, setMapping] = useState<{ file: string; name: string; inspection: CsvInspection } | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<RowGroup | 'issues' | 'all'>('ambiguous');
  const [page, setPage] = useState(0);
  const [resolving, setResolving] = useState(false);
  const [useImported, setUseImported] = useState(false);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  useEffect(() => { setPending(shelf.list(agent)); }, [agent, shelf]);
  const refreshPending = () => setPending(shelf.list(agent));
  const patch = (change: Partial<Active>) => setActive(current => current && { ...current, ...change });
  const failureText = (failure: unknown) => failure instanceof ImportError
    ? failure.failure === 'missing' ? t.importExpired : failure.failure === 'invalid' ? t.importInvalid
      : t.importUnavailable : t.importUnavailable;

  async function openImport(entry: PendingImport) {
    const generation = ++run.current;
    const live = () => generation === run.current;
    setOpen(true); setError(null); setMapping(null); setPage(0);
    setActive({ entry, rows: [], loaded: false, progress: null, stopped: false, finished: false });
    let rows: ImportRow[];
    try {
      rows = await loadAllRows(client, entry.id, entry.total, loaded => live() && patch({ rows: loaded }), live);
    } catch (failure) {
      if (!live()) return;
      if (failure instanceof ImportError && failure.failure === 'missing') { shelf.remove(agent, entry.id); refreshPending(); setActive(null); }
      else patch({ loaded: false, stopped: true });
      setError(failureText(failure));
      return;
    }
    if (!live()) return;
    const finished = applyFinished(rows);
    setGroup(finished ? 'issues' : countGroups(rows).ambiguous ? 'ambiguous' : 'matched');
    patch({ rows, loaded: true, finished });
    if (finished) { shelf.remove(agent, entry.id); refreshPending(); }
    else if (applyStarted(rows) || entry.intent) void apply(entry, rows);
  }

  async function upload(file: File, chosen: CsvMapping | null = null, text?: string) {
    // The mapped CSV was checked when it was first read; only a file chosen now is measured.
    if (text === undefined && file.size > UPLOAD_LIMIT_BYTES) { setError(t.importTooLarge); return; }
    setError(null); setUploading(true);
    try {
      const content = text ?? await file.text();
      if (format === 'generic-csv' && !chosen) {
        setMapping({ file: content, name: file.name, inspection: await client.inspect(content) });
        return;
      }
      const created = await client.create({ format, file: content, ...chosen ? { mapping: chosen } : {} });
      const entry: PendingImport = { id: created.id, format, name: file.name, total: created.total,
        createdAt: Date.now(), intent: null };
      shelf.save(agent, entry); refreshPending();
      void openImport(entry);
    } catch (failure) { setError(failureText(failure)); }
    finally { setUploading(false); }
  }

  async function showRow(id: string, index: number) {
    const fresh = await reloadRow(client, id, index);
    if (fresh) setActive(current => current?.entry.id === id ? { ...current, rows: replaceRow(current.rows, fresh) } : current);
  }
  async function resolveRow(id: string, row: ImportRow, choice: RowResolution) {
    try { await client.resolve(id, row, choice); } catch (failure) {
      // The row changed elsewhere: show Main's version, so the next choice is made on it, then say so.
      if (failure instanceof ImportError && failure.failure === 'conflict') await showRow(id, row.index).catch(() => undefined);
      throw failure;
    }
    await showRow(id, row.index);
  }
  /** Rows the reader asked to overwrite what the Library already has: Main applies `replace` for them alone. */
  async function useImportedValues(id: string, targets: readonly ImportRow[]) {
    for (const row of targets) {
      const work = row.resolution?.work ?? row.match?.work;
      if (row.source.kind !== 'source' || !work || groupOf(row) !== 'matched') continue;
      const target = row.resolution?.target ?? row.match?.target;
      await client.resolve(id, row, { choice: 'apply', work, ...target ? { target } : {}, conflictChoice: 'replace' });
    }
  }
  async function adoptRow(id: string, row: ImportRow, workId: string) {
    const work = await client.adopt(id, row.index, workId, locale);
    await resolveRow(id, row, { choice: 'apply', work });
  }
  /** Not reloaded one by one: a reviewed choice only becomes sealed when apply starts. */
  async function keepPrivate(id: string, targets: readonly ImportRow[]) {
    for (const row of targets) {
      await client.resolve(id, row, { choice: 'private' });
      const kept = { ...row, resolution: { choice: 'private' as const }, version: row.version + 1 };
      setActive(current => current?.entry.id === id ? { ...current, rows: replaceRow(current.rows, kept) } : current);
    }
  }
  async function keepAllPrivate() {
    if (!active) return;
    setResolving(true); setError(null);
    try { await keepPrivate(active.entry.id, active.rows.filter(needsChoice)); } catch { setError(t.importResolveFailed); }
    setResolving(false);
  }

  async function apply(entry: PendingImport, current: readonly ImportRow[]) {
    const generation = run.current;
    const live = () => generation === run.current;
    const intent = entry.intent ?? { context, language: reviewLanguage };
    const withIntent = { ...entry, intent };
    setError(null);
    patch({ stopped: false, progress: { total: entry.total, completed: 0, issues: 0, pending: true } });
    try {
      // Main will not seal while a row has neither a match nor a choice: what was not found stays private.
      // A sealed import has none left in that group, so a resumed apply asks for nothing here.
      await keepPrivate(entry.id, current.filter(row => groupOf(row) === 'not-found'));
      if (!entry.intent && useImported) await useImportedValues(entry.id, current);
      // From here the intent is fixed: remember it, so a reload resumes this apply.
      shelf.save(agent, withIntent);
      patch({ entry: withIntent });
      let last = -1, stalled = 0;
      for (;;) {
        const progress = await client.apply(entry.id, intent);
        if (!live()) return;
        patch({ progress });
        if (!progress.pending) break;
        stalled = progress.completed === last ? stalled + 1 : 0;
        last = progress.completed;
        if (stalled >= 5) throw new ImportError('unavailable');
        if (stalled) await new Promise(resolve => setTimeout(resolve, 300 * stalled));
      }
      const rows = await loadAllRows(client, entry.id, entry.total, () => {}, live);
      if (!live()) return;
      patch({ rows, finished: true, stopped: false });
      setGroup(rows.some(row => row.outcome?.issues.length) ? 'issues' : 'all'); setPage(0);
      shelf.remove(agent, entry.id); refreshPending();
      router.refresh();
    } catch (failure) {
      if (!live()) return;
      if (failure instanceof ImportError && failure.failure === 'missing') { shelf.remove(agent, entry.id); refreshPending(); setActive(null); }
      else patch({ stopped: true });
      setError(failureText(failure));
    }
  }

  async function discard(entry: PendingImport) {
    try { await client.discard(entry.id); } catch (failure) {
      if (!(failure instanceof ImportError && failure.failure === 'missing')) { setError(failureText(failure)); return; }
    }
    shelf.remove(agent, entry.id); refreshPending();
    if (active?.entry.id === entry.id) { run.current += 1; setActive(null); }
  }

  const rows = active?.rows ?? [];
  const counts = countGroups(rows);
  const sealed = applyStarted(rows) || !!active?.entry.intent;
  const unresolved = rows.filter(needsChoice);
  const choose = unresolved.filter(row => groupOf(row) === 'ambiguous').length;
  const issues = rows.filter(row => row.outcome?.issues.length).length;
  const tabs: Array<{ key: RowGroup | 'issues' | 'all'; label: string; count: number }> = active?.finished
    ? [{ key: 'issues', label: t.importTabIssues, count: issues }, { key: 'all', label: t.importTabAll, count: rows.length }]
    : rowGroups.map(key => ({ key, count: counts[key], label: key === 'ambiguous' ? t.importGroupAmbiguous
      : key === 'not-found' ? t.importGroupNotFound : key === 'matched' ? t.importGroupMatched : t.importGroupPrivate }));
  const shown = rows.filter(row => group === 'all' || (group === 'issues' ? row.outcome?.issues.length : groupOf(row) === group));
  const visible = shown.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.ceil(shown.length / PAGE);
  const others = pending.filter(entry => entry.id !== active?.entry.id);
  const busy = uploading || (!!active && !active.finished && !active.stopped && (!active.loaded || !!active.progress?.pending));

  return <section aria-labelledby="library-import" className="rounded-2xl border border-border/70 p-4 sm:p-5">
    <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-sm font-semibold text-lg outline-none focus-visible:ring-2
        focus-visible:ring-ring"><h2 id="library-import" className="inline">{t.importTitle}</h2>
        {others.length && !open ? <span className="ms-2 font-normal text-muted-foreground text-sm">
          {t.importUnfinishedCount(others.length)}</span> : null}</summary>
      <div className="grid gap-4 pt-4">
        <p className="text-muted-foreground text-sm">{t.importHelp}</p>
        {others.length ? <section aria-labelledby="library-import-unfinished" className="grid gap-2 rounded-xl bg-muted/50 p-3">
          <h3 id="library-import-unfinished" className="font-medium text-sm">{t.importUnfinishedTitle}</h3>
          <ul className="grid gap-2">
            {others.map(entry => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0 break-words">{t.importUnfinishedItem({ name: entry.name, count: entry.total })}</span>
              <span className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void openImport(entry)}>{t.importContinue}
                  <span className="sr-only"> — {entry.name}</span></Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void discard(entry)}>{t.importDiscard}
                  <span className="sr-only"> — {entry.name}</span></Button>
              </span>
            </li>)}
          </ul>
          <p className="text-muted-foreground text-xs">{t.importDiscardNote}</p>
        </section> : null}
        {active ? null : <>
          <fieldset className="grid min-w-0 gap-2" disabled={uploading}>
            <legend className="mb-1 w-full max-w-full font-medium text-sm">{t.importFormatLabel}</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {formats.map(value => <label key={value} className={cn('flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring', format === value ? 'border-primary bg-primary/10' : 'border-border')}>
                <input type="radio" name="library-import-format" value={value} checked={format === value}
                  className="accent-primary" onChange={() => { setFormat(value); setMapping(null); setError(null); }} />
                {value === 'goodreads' ? 'Goodreads' : value === 'storygraph' ? 'The StoryGraph' : value === 'mal' ? 'MyAnimeList'
                  : value === 'vndb' ? 'VNDB' : value === 'rezics' ? 'REZICS' : t.importFormatCsv}</label>)}
            </div>
          </fieldset>
          <p className="text-muted-foreground text-sm">{({ goodreads: t.importHowGoodreads, storygraph: t.importHowStorygraph,
            mal: t.importHowMal, vndb: t.importHowVndb, rezics: t.importHowRezics, 'generic-csv': t.importHowCsv })[format]}</p>
          <p className="text-muted-foreground text-xs">{t.importAnilist}</p>
          {mapping ? <CsvMapper inspection={mapping.inspection} locale={locale} messages={messages} busy={uploading}
            onCancel={() => setMapping(null)}
            onSubmit={chosen => void upload(new File([], mapping.name), chosen, mapping.file)} /> : <label htmlFor="library-import-file"
            onDragEnter={event => { event.preventDefault(); setDragging(true); }}
            onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)}
            onDrop={event => { event.preventDefault(); setDragging(false);
              const file = event.dataTransfer.files[0]; if (file && !uploading) void upload(file); }}
            className={cn('relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed',
              'px-4 py-5 text-center text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              dragging ? 'border-primary bg-primary/10' : 'border-border bg-muted/30 hover:border-primary')}>
            <UploadCloudIcon aria-hidden="true" className="size-6 text-primary" />
            <span>{t.importFile}</span><span className="text-muted-foreground text-xs">{t.importDrop}</span>
            <Input id="library-import-file" type="file" aria-label={t.importFile} accept={accept[format]} disabled={uploading}
              className="sr-only" onChange={event => { const file = event.target.files?.[0]; event.target.value = '';
                if (file) void upload(file); }} /></label>}
          {uploading ? <p role="status" className="text-muted-foreground text-sm">{t.importUploading}</p> : null}
        </>}
        {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
        {active ? <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-sm">{t.importFileSelected({ name: active.entry.name })}</p>
            {!active.finished ? <Button size="sm" variant="outline" disabled={resolving || !!active.progress?.pending}
              onClick={() => void discard(active.entry)}>{t.importDiscard}</Button>
              : <span className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void discard(active.entry)}>{t.importDelete}</Button>
                <Button size="sm" variant="outline" onClick={() => { run.current += 1; setActive(null); }}>{t.importClose}</Button></span>}
          </div>
          {!active.loaded && !active.stopped ? <div className="grid gap-1" role="status">
            <Progress value={Math.round((rows.length / Math.max(1, active.entry.total)) * 100)} aria-label={t.importMatching({
              done: number(rows.length), total: number(active.entry.total) })} />
            <p className="text-muted-foreground text-sm">{t.importMatching({ done: number(rows.length), total: number(active.entry.total) })}</p>
          </div> : null}
          {active.stopped && !active.loaded ? <div><Button size="sm" onClick={() => void openImport(active.entry)}>{t.importContinue}</Button></div> : null}
          {active.loaded || rows.length ? <>
            {active.finished ? <p className="text-muted-foreground text-xs">{t.importDeleteNote}</p> : null}
            {active.finished ? <p role="status" className="text-sm">{t.importApplyDone({ done: number(rows.length - issues),
              total: number(rows.length) })}{issues ? ` ${t.importIssues(issues)}` : ''} <Link href="/library"
                className="text-primary underline">{t.importViewLibrary}</Link></p> : null}
            <div role="group" aria-label={t.importGroups} className="flex flex-wrap gap-2">
              {tabs.map(tab => <Button key={tab.key} size="sm" variant={group === tab.key ? 'default' : 'outline'}
                aria-pressed={group === tab.key} onClick={() => { setGroup(tab.key); setPage(0); }}>
                {tab.label} <span className={cn('tabular-nums', group !== tab.key && 'opacity-80')}>{number(tab.count)}</span></Button>)}
            </div>
            {shown.length ? <ol className="grid divide-y divide-border/70">
              {visible.map(row => <ImportRowItem key={row.index} row={row} sealed={sealed} locale={locale} messages={messages}
                onResolve={(item, choice) => resolveRow(active.entry.id, item, choice)}
                onAdopt={(item, workId) => adoptRow(active.entry.id, item, workId)} />)}
            </ol> : <p className="text-muted-foreground text-sm">{t.importNoRows}</p>}
            {pages > 1 ? <nav aria-label={t.pages} className="flex items-center justify-between gap-3">
              <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>{t.previousPage}</Button>
              <span className="text-muted-foreground text-sm">{t.pageOf({ page: number(page + 1), pages: number(pages) })}</span>
              <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>{t.nextPage}</Button>
            </nav> : null}
            {active.loaded && !active.finished ? <div className="grid gap-3 rounded-xl bg-muted/50 p-3">
              {!sealed && counts.matched ? <fieldset className="grid min-w-0 gap-1 text-sm">
                <legend className="mb-1 w-full max-w-full font-medium">{t.importConflictLabel}</legend>
                {([false, true] as const).map(value => <label key={String(value)} className="flex cursor-pointer items-center gap-2">
                  <input type="radio" name="library-import-conflict" className="accent-primary" checked={useImported === value}
                    onChange={() => setUseImported(value)} />{value ? t.importUseImported : t.importKeepMine}</label>)}
              </fieldset> : null}
              {!sealed && counts['not-found'] ? <p className="text-muted-foreground text-xs">{t.importNotFoundPrivate(counts['not-found'])}</p> : null}
              {!sealed && unresolved.length ? <div>
                <Button size="sm" variant="outline" disabled={resolving}
                  onClick={() => void keepAllPrivate()}>{t.importKeepAllPrivate}</Button></div> : null}
              <div className="flex flex-wrap items-center gap-3">
                {active.progress?.pending || active.stopped ? null : <Button disabled={busy || resolving || !!choose}
                  onClick={() => void apply(active.entry, rows)}>{t.importApply}</Button>}
                {active.stopped && active.loaded ? <Button onClick={() => void apply(active.entry, rows)}>{t.importContinue}</Button> : null}
                {choose && !sealed ? <p className="text-muted-foreground text-sm">{t.importNeedChoices(choose)}</p> : null}
              </div>
              {active.progress?.pending ? <div className="grid gap-1" role="status">
                <Progress value={Math.round((active.progress.completed / Math.max(1, active.progress.total)) * 100)}
                  aria-label={t.importApplying({ done: number(active.progress.completed), total: number(active.progress.total) })} />
                <p className="text-sm">{t.importApplying({ done: number(active.progress.completed), total: number(active.progress.total) })}</p>
              </div> : null}
              {active.stopped ? <p role="status" className="text-sm">{t.importApplyStopped}</p> : null}
            </div> : null}
          </> : null}
        </div> : null}
      </div>
    </details>
  </section>;
}
