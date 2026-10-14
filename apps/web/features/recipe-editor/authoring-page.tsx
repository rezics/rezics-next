'use client';

import { Skeleton } from '@rezics/ui/skeleton';
import { ChefHatIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import type { MainClient } from '../studio/types.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { NoAuthority } from '../work-levels-edit/edit-frame.tsx';
import { copyOf as editCopy } from '../work-levels-edit/messages.ts';
import { RecipeEditor } from './editor.tsx';
import type { RecipeExport } from './export-api.ts';
import type { RecipeImportApi } from './import-api.ts';
import { copyOf, messages } from './messages.ts';
import type { RecipeAuthoringMapped } from './authoring-page.ts';

/** The editor body both the server page and a recorded story render. */
export function RecipeAuthoringBody({
  view,
  locale,
  workRef,
  workHref,
  signInHref,
  main,
  importApi,
  newImportId,
  saveExport,
}: {
  view: RecipeAuthoringMapped;
  locale: UiLocale;
  workRef: string;
  workHref: string;
  signInHref: string;
  main?: () => MainClient;
  importApi?: RecipeImportApi;
  newImportId?: () => string;
  saveExport?: (exported: RecipeExport, contentLanguage?: string, recipeName?: string) => void;
}) {
  const t = copyOf(locale);
  const problem = 'refusal' in view ? view.refusal?.problem : null;
  const reason = problem && typeof problem === 'object' ? problem as { title?: unknown; detail?: unknown } : null;
  const detail = typeof reason?.detail === 'string' ? reason.detail : typeof reason?.title === 'string' ? reason.title : null;
  if (view.kind === 'no-authority') {
    return (
      <div className="grid gap-3"><NoAuthority
        workRef={workRef}
        signedIn={view.signedIn}
        t={editCopy(locale)}
        signInHref={signInHref}
      />{detail ? <p role="alert">{detail}</p> : null}</div>
    );
  }
  if (view.kind === 'unavailable') {
    return (
      <EmptyState
        icon={ChefHatIcon}
        role="alert"
        tone="destructive"
        title={t.unavailableTitle}
        description={detail ?? t.unavailableBody}
      />
    );
  }
  if (view.kind === 'not-recipe') {
    return (
      <EmptyState
        icon={ChefHatIcon}
        role="status"
        title={t.notRecipeTitle}
        description={t.notRecipeBody}
      />
    );
  }
  return (
    <RecipeEditor
      work={view.work}
      mainVersion={view.mainVersion}
      language={view.language}
      actingSubject={view.actingSubject}
      workHref={workHref}
      initial={view.initial}
      locale={locale}
      messages={messages[locale]}
      main={main}
      importApi={importApi}
      newImportId={newImportId}
      saveExport={saveExport}
    />
  );
}


/** The server visit streams its authoring reads under this same loading state. */
export function RecipeAuthoringPending({ locale }: { locale: UiLocale }) {
  const t = copyOf(locale);
  return <div role="status" aria-busy="true" className="grid gap-5">
    <p>{t.loadingRecipe}</p><Skeleton className="h-24 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" />
  </div>;
}
