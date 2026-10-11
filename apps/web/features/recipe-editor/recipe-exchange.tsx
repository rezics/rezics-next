'use client';

import { Button } from '@rezics/ui/button';
import { DownloadIcon, LoaderCircleIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { RecipeEditorMessages } from './messages.ts';
import { downloadRecipeExport, mainRecipeExportApi, RecipeExportError, type RecipeExport, type RecipeExportApi } from './export-api.ts';

type Stage = { kind: 'idle' } | { kind: 'exporting' } | { kind: 'done'; revision: string }
  | { kind: 'failed'; failure: 'denied' | 'too-large' | 'unavailable'; detail: string | null };

/** Downloads the Schema.org representation of the editor's selected, saved revision. */
export function RecipeExchange({ structure, revision, actingSubject, locale, messages: catalog, disabled = false,
  api, save = downloadRecipeExport }: {
  structure: string | null; revision: string | null; actingSubject: string; locale: UiLocale;
  messages: RecipeEditorMessages; disabled?: boolean; api?: RecipeExportApi; save?: (exported: RecipeExport) => void;
}) {
  const t = materializeData(catalog, { locale });
  const [client] = useState(() => api ?? mainRecipeExportApi());
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const busy = stage.kind === 'exporting';

  async function exportRecipe() {
    if (!structure || !revision || busy || disabled) return;
    setStage({ kind: 'exporting' });
    try {
      const exported = await client.exportRevision({ structure, revision, actingSubject });
      save(exported);
      setStage({ kind: 'done', revision: exported.revision });
    } catch (error) {
      const refusal = error instanceof RecipeExportError ? error : new RecipeExportError('unavailable');
      setStage({ kind: 'failed', failure: refusal.failure, detail: refusal.detail });
    }
  }

  const revisionName = (value: string) => value.slice(-36);
  const failureText = stage.kind === 'failed'
    ? stage.failure === 'too-large' ? stage.detail ?? t.exportTooLargeFallback
      : stage.failure === 'denied' ? t.exportDenied : t.exportUnavailable
    : null;

  return <div className="grid min-w-0 justify-items-start gap-1 sm:justify-items-end">
    <Button type="button" size="sm" variant="outline" disabled={disabled || busy || !structure || !revision}
      aria-busy={busy || undefined} className="pointer-coarse:min-h-11" onClick={() => void exportRecipe()}>
      {busy ? <LoaderCircleIcon aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        : <DownloadIcon aria-hidden="true" />}
      {busy ? t.exporting : t.exportAction}
    </Button>
    {stage.kind === 'done' ? <p role="status" className="max-w-72 text-right text-xs text-muted-foreground">
      {t.exportedRevision({ revision: revisionName(stage.revision) })}</p> : null}
    {failureText ? <p role="alert" className="max-w-72 text-left text-xs text-destructive sm:text-right">{failureText}</p> : null}
  </div>;
}
