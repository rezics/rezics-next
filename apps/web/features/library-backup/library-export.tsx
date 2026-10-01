'use client';

import { Button } from '@rezics/ui/button';
import { Progress } from '@rezics/ui/progress';
import { DownloadIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { LibraryMessages } from '../library/messages.ts';
import { ExportError, type ExportApi, mainExportApi } from './export-api.ts';
import { assembleFiles, collectedRows, collectExport, type ExportFile } from './export-job.ts';
import { type ExportProgress, type ExportStore, indexedDbExportStore } from './export-store.ts';

type Stage = { kind: 'idle' } | { kind: 'running'; rows: number } | { kind: 'paused'; rows: number; failure: 'moved' | 'failed' }
  | { kind: 'ready'; rows: number; files: ExportFile[] };

/** Hands each assembled file to the browser as a download. */
export function downloadFiles(files: readonly ExportFile[]) {
  files.forEach((file, index) => setTimeout(() => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }, index * 400));
}

/**
 * "Download your library": every record Main keeps about the reader's library, fetched page by page as one
 * REZICS export. The position is kept in the browser, so a reload or a lost connection resumes where it
 * stopped; the file is offered only after the collected pages are checked against what each page counted.
 */
export function LibraryExport({ agent, locale, messages, api, store, save = downloadFiles }: {
  agent: string; locale: UiLocale; messages: LibraryMessages; api?: ExportApi; store?: ExportStore;
  save?: (files: readonly ExportFile[]) => void;
}) {
  const t = materializeData(messages, { locale });
  const [client] = useState(() => api ?? mainExportApi(agent));
  const [kept] = useState(() => store ?? indexedDbExportStore());
  const run = useRef(0);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);

  async function finish(progress: ExportProgress) {
    const files = assembleFiles(await collectedRows(kept, agent, progress), new Date().toISOString().slice(0, 10));
    // The file now exists in this page alone. Its pages hold private reviews, so they are not kept in the browser:
    // a reload offers a new download, never an old snapshot as ready.
    await kept.clear(agent);
    setStage({ kind: 'ready', rows: progress.rows, files });
  }
  async function start(restart = false) {
    const generation = ++run.current;
    const live = () => generation === run.current;
    if (restart) await kept.clear(agent);
    setStage({ kind: 'running', rows: 0 });
    try {
      const progress = await collectExport({ api: client, store: kept, agent, active: live,
        onProgress: next => live() && setStage({ kind: 'running', rows: next.rows }) });
      if (live()) await finish(progress);
    } catch (failure) {
      if (!live()) return;
      const moved = failure instanceof ExportError && failure.failure === 'moved';
      if (moved) await kept.clear(agent);
      setStage({ kind: 'paused', rows: moved ? 0 : (await kept.progress(agent))?.rows ?? 0, failure: moved ? 'moved' : 'failed' });
    }
  }

  // A download this browser began before a reload: offer to resume it rather than start over.
  useEffect(() => {
    let current = true;
    void kept.progress(agent).then(progress => {
      if (!current || !progress) return;
      if (progress.done) void kept.clear(agent);
      else setStage({ kind: 'paused', rows: progress.rows, failure: 'failed' });
    }).catch(() => undefined);
    return () => { current = false; };
  // The stored position is read once per mount.
  }, [agent, kept]);

  return <section aria-labelledby="library-export" className="rounded-2xl border border-border/70 p-4 sm:p-5">
    <details>
      <summary className="cursor-pointer rounded-sm font-semibold text-lg outline-none focus-visible:ring-2
        focus-visible:ring-ring"><h2 id="library-export" className="inline">{t.backupTitle}</h2></summary>
      <div className="grid gap-4 pt-4">
        <ul className="grid gap-1 text-muted-foreground text-sm">
          <li>{t.backupContains}</li><li>{t.backupNever}</li><li>{t.backupReimport}</li>
        </ul>
        {stage.kind === 'idle' ? <div><Button onClick={() => void start()}>
          <DownloadIcon aria-hidden="true" />{t.backupStart}</Button></div> : null}
        {stage.kind === 'running' ? <div className="grid gap-1" role="status">
          <Progress indeterminate aria-label={t.backupProgress(stage.rows)} />
          <p className="text-sm">{t.backupProgress(stage.rows)}</p>
        </div> : null}
        {stage.kind === 'paused' ? <div className="grid gap-3">
          <p role="alert" className="text-sm">{stage.failure === 'moved' ? t.backupChanged
            : t.backupPaused(stage.rows)}</p>
          <div className="flex flex-wrap gap-2">
            {stage.failure === 'moved' ? <Button onClick={() => void start(true)}>{t.backupRestart}</Button>
              : <><Button onClick={() => void start()}>{t.backupResume}</Button>
                <Button variant="outline" onClick={() => void start(true)}>{t.backupRestart}</Button></>}
          </div>
        </div> : null}
        {stage.kind === 'ready' ? <div className="grid gap-3">
          <p role="status" className="text-sm">{stage.rows ? t.backupReady(stage.rows) : t.backupEmpty}</p>
          {stage.files.length > 1 ? <p className="text-muted-foreground text-sm">{t.backupSplit({ count: number(stage.files.length) })}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save(stage.files)}><DownloadIcon aria-hidden="true" />{t.backupSave}</Button>
            <Button variant="outline" onClick={() => void start(true)}>{t.backupRestart}</Button>
          </div>
        </div> : null}
      </div>
    </details>
  </section>;
}
