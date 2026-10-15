'use client';

import { Button } from '@rezics/ui/button';
import { DownloadIcon, LoaderCircleIcon, UploadIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { RecipeEditorMessages } from './messages.ts';
import { downloadRecipeExport, mainRecipeExportApi, RecipeExportError, type RecipeExport, type RecipeExportApi } from './export-api.ts';
import { mainRecipeImportApi, RecipeImportError, RECIPE_FILE_MAX_BYTES,
  type RecipeFileImport, type RecipeImportApi, type RecipeImportFailure, type RecipeImportRequest } from './import-api.ts';

type ExportStage = { kind: 'idle' } | { kind: 'exporting' } | { kind: 'done'; revision: string }
  | { kind: 'failed'; failure: 'denied' | 'too-large' | 'unavailable'; detail: string | null };

type ImportStage = { kind: 'idle' } | { kind: 'importing' }
  | { kind: 'failed'; failure: RecipeImportFailure; detail: string | null; retry: RecipeImportRequest | null }
  | { kind: 'refreshing-stale'; file: File; detail: string | null }
  | { kind: 'stale-refresh-failed'; file: File; detail: string | null }
  | { kind: 'stale'; file: File; head: string; detail: string | null }
  | { kind: 'done'; result: RecipeFileImport; refreshFailed: boolean; refreshing: boolean };

/** Downloads the selected saved revision and imports a local Schema.org Recipe into the current head. */
export function RecipeExchange({ structure, revision, actingSubject, locale, messages: catalog, disabled = false,
  api, importApi, allowImport = true, prepareImport, save = downloadRecipeExport, contentLanguage, recipeName, onImportBusyChange, onStaleRefresh, onImported,
  newId = () => crypto.randomUUID() }: {
  allowImport?: boolean;
  prepareImport?: () => Promise<{ structure: string; revision: string } | null>;
  structure: string | null; revision: string | null; actingSubject: string; locale: UiLocale;
  messages: RecipeEditorMessages; disabled?: boolean; api?: RecipeExportApi; importApi?: RecipeImportApi;
  contentLanguage?: string; recipeName?: string;
  save?: (exported: RecipeExport, contentLanguage?: string, recipeName?: string) => void;
  onImportBusyChange?: (busy: boolean) => void;
  /** Reload the recipe after a stale-head refusal, returning the head the cook can confirm. */
  onStaleRefresh?: () => Promise<string | null>;
  /** Read the imported revision back so the editor shows its sections, ingredients and steps. */
  onImported?: (result: RecipeFileImport) => Promise<boolean | void> | boolean | void;
  newId?: () => string;
}) {
  const t = materializeData(catalog, { locale });
  const [exportClient] = useState(() => api ?? mainRecipeExportApi());
  const [importClient] = useState(() => importApi ?? mainRecipeImportApi());
  const [hydrated, setHydrated] = useState(false);
  const [exportStage, setExportStage] = useState<ExportStage>({ kind: 'idle' });
  const [importStage, setImportStage] = useState<ImportStage>({ kind: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);
  const exportBusy = exportStage.kind === 'exporting';
  const importBusy = importStage.kind === 'importing' || importStage.kind === 'refreshing-stale'
    || (importStage.kind === 'done' && importStage.refreshing);

  useEffect(() => setHydrated(true), []);

  async function exportRecipe() {
    if (!hydrated || !structure || !revision || exportBusy || disabled) return;
    setExportStage({ kind: 'exporting' });
    try {
      const exported = await exportClient.exportRevision({ structure, revision, actingSubject });
      save(exported, contentLanguage, recipeName);
      setExportStage({ kind: 'done', revision: exported.revision });
    } catch (error) {
      const refusal = error instanceof RecipeExportError ? error : new RecipeExportError('unavailable');
      setExportStage({ kind: 'failed', failure: refusal.failure, detail: refusal.detail });
    }
  }

  const requestFor = (file: File, expectedHead: string): RecipeImportRequest => ({
    structure: structure!, expectedHead, actingSubject, idempotencyKey: `recipe-file-import:${newId()}`, file,
  });

  async function readLatestAfterStale(file: File, detail: string | null) {
    setImportStage({ kind: 'refreshing-stale', file, detail });
    onImportBusyChange?.(true);
    let head: string | null = null;
    try { head = await onStaleRefresh?.() ?? null; } catch { /* Keep the selected file and offer another refresh. */ }
    setImportStage(head ? { kind: 'stale', file, head, detail } : { kind: 'stale-refresh-failed', file, detail });
    onImportBusyChange?.(false);
  }

  async function runImport(request: RecipeImportRequest) {
    if (disabled || importBusy) return;
    setImportStage({ kind: 'importing' });
    onImportBusyChange?.(true);
    try {
      const result = await importClient.importFile(request);
      let refreshFailed = false;
      if (onImported) {
        try { refreshFailed = (await onImported(result)) === false; }
        catch { refreshFailed = true; }
      }
      setImportStage({ kind: 'done', result, refreshFailed, refreshing: false });
    } catch (error) {
      const refusal = error instanceof RecipeImportError ? error : new RecipeImportError('unavailable');
      if (refusal.failure === 'stale') {
        await readLatestAfterStale(request.file, refusal.detail);
      } else {
        setImportStage({ kind: 'failed', failure: refusal.failure, detail: refusal.detail,
          retry: refusal.failure === 'unavailable' || refusal.failure === 'pending' ? request : null });
      }
    } finally {
      onImportBusyChange?.(false);
    }
  }

  async function selectFile(file: File | undefined) {
    if (!file || !hydrated || disabled || importBusy) return;
    if (file.size > RECIPE_FILE_MAX_BYTES) {
      setImportStage({ kind: 'failed', failure: 'too-large', detail: null, retry: null });
      return;
    }
    let target = structure && revision ? { structure, revision } : null;
    if (!target && prepareImport) {
      setImportStage({ kind: 'importing' });
      onImportBusyChange?.(true);
      try { target = await prepareImport(); } catch { /* The editor keeps its refused creation. */ }
      onImportBusyChange?.(false);
    }
    if (!target) {
      setImportStage({ kind: 'failed', failure: 'unavailable', detail: null, retry: null });
      return;
    }
    await runImport({ ...requestFor(file, target.revision), structure: target.structure });
  }

  async function refreshStale(file: File, detail: string | null) {
    if (disabled || importBusy) return;
    await readLatestAfterStale(file, detail);
  }

  async function refreshImported(result: RecipeFileImport) {
    if (!onImported || disabled || importBusy) return;
    setImportStage({ kind: 'done', result, refreshFailed: true, refreshing: true });
    onImportBusyChange?.(true);
    try {
      const loaded = await onImported(result);
      setImportStage({ kind: 'done', result, refreshFailed: loaded === false, refreshing: false });
    } catch {
      setImportStage({ kind: 'done', result, refreshFailed: true, refreshing: false });
    } finally {
      onImportBusyChange?.(false);
    }
  }

  const revisionName = (value: string) => value.slice(-36);
  const exportFailureText = exportStage.kind === 'failed'
    ? exportStage.failure === 'too-large' ? exportStage.detail ?? t.exportTooLargeFallback
      : exportStage.failure === 'denied' ? t.exportDenied : t.exportUnavailable
    : null;
  const importFailureText = importStage.kind === 'failed'
    ? importStage.failure === 'too-large' ? importStage.detail ?? t.importTooLarge
      : importStage.failure === 'invalid' ? importStage.detail ?? t.importInvalid
        : importStage.failure === 'conflict' ? t.importConflict
          : importStage.failure === 'pending' ? t.failPending
          : importStage.failure === 'denied' ? t.importDenied : t.importUnavailable
    : null;

  return <div className="grid min-w-0 gap-3 sm:grid-flow-col sm:auto-cols-max sm:items-start sm:justify-end">
    <div className="grid min-w-0 justify-items-start gap-1 sm:justify-items-end">
      <Button type="button" size="sm" variant="outline" disabled={!hydrated || disabled || exportBusy || !structure || !revision}
        data-hydrated={hydrated ? 'true' : undefined} aria-busy={exportBusy || undefined}
        className="pointer-coarse:min-h-11" onClick={() => void exportRecipe()}>
        {exportBusy ? <LoaderCircleIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
          : <DownloadIcon aria-hidden="true" />}
        {exportBusy ? t.exporting : t.exportAction}
      </Button>
      {exportStage.kind === 'done' ? <p role="status" className="max-w-72 text-left text-xs text-muted-foreground sm:text-right">
        {t.exportedRevision({ revision: revisionName(exportStage.revision) })}</p> : null}
      {exportFailureText ? <p role="alert" className="max-w-72 text-left text-xs text-destructive-foreground sm:text-right">
        {exportFailureText}{exportStage.kind === 'failed' && exportStage.detail && exportStage.failure !== 'too-large'
          ? <span> {t.mainSays}: {exportStage.detail}</span> : null}
      </p> : null}
    </div>

    {allowImport ? <div className="grid min-w-0 justify-items-start gap-1 sm:justify-items-end">
      <input ref={fileInput} type="file" accept=".json,application/json,application/ld+json" className="sr-only"
        aria-label={t.importAction} disabled={!hydrated || disabled || importBusy || (!(structure && revision) && !prepareImport)}
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          void selectFile(file);
        }} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!hydrated || disabled || importBusy || (!(structure && revision) && !prepareImport)}
          data-hydrated={hydrated ? 'true' : undefined} aria-busy={importBusy || undefined}
          className="pointer-coarse:min-h-11" onClick={() => fileInput.current?.click()}>
          {importBusy ? <LoaderCircleIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
            : <UploadIcon aria-hidden="true" />}
          {importBusy ? (importStage.kind === 'refreshing-stale' || (importStage.kind === 'done' && importStage.refreshing)
            ? t.importRefreshing : t.importing) : t.importAction}
        </Button>
        {importStage.kind === 'stale' ? <Button type="button" size="sm" className="pointer-coarse:min-h-11"
          disabled={disabled} onClick={() => void runImport(requestFor(importStage.file, importStage.head))}>
          {t.importStaleAction}</Button> : null}
        {importStage.kind === 'stale-refresh-failed' ? <Button type="button" size="sm" variant="outline"
          className="pointer-coarse:min-h-11" disabled={disabled} onClick={() => void refreshStale(importStage.file, importStage.detail)}>
          {t.importRefreshAction}</Button> : null}
        {importStage.kind === 'failed' && importStage.retry ? <Button type="button" size="sm" variant="outline"
          className="pointer-coarse:min-h-11" disabled={disabled} onClick={() => void runImport(importStage.retry!)}>
          {t.retry}</Button> : null}
        {importStage.kind === 'done' && importStage.refreshFailed && onImported ? <Button type="button" size="sm" variant="outline"
          className="pointer-coarse:min-h-11" disabled={disabled || importStage.refreshing}
          onClick={() => void refreshImported(importStage.result)}>
          {importStage.refreshing ? t.importRefreshing : t.importRefreshAction}</Button> : null}
      </div>
      {importFailureText ? <p role="alert" className="max-w-80 text-left text-xs text-destructive-foreground sm:text-right">
        {importFailureText}{importStage.kind === 'failed' && importStage.detail && importStage.failure !== 'too-large'
          && importStage.failure !== 'invalid' ? <span> {t.mainSays}: {importStage.detail}</span> : null}
      </p> : null}
      {importStage.kind === 'stale' || importStage.kind === 'stale-refresh-failed'
        ? <p role="alert" className="max-w-80 text-left text-xs text-destructive-foreground sm:text-right">
          {importStage.kind === 'stale-refresh-failed' ? t.importRefreshFailed : t.importStale}
          {importStage.detail ? <><span> {t.mainSays}: </span>{importStage.detail}</> : null}</p> : null}
      {importStage.kind === 'done' ? <>
        <p role="status" className="max-w-80 text-left text-xs text-muted-foreground sm:text-right">
          {t.importedRevision({ revision: revisionName(importStage.result.revision) })}</p>
        {importStage.refreshFailed ? <p role="alert" className="max-w-80 text-left text-xs text-destructive-foreground sm:text-right">
          {t.importRefreshFailed}</p> : null}
      </> : null}
    </div> : null}
  </div>;
}
