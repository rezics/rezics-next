'use client';

import { ChefHatIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { seedTypes, type TypeRegistry } from '../catalogue/types.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { NoAuthority } from '../work-levels-edit/edit-frame.tsx';
import { copyOf as editCopy } from '../work-levels-edit/messages.ts';
import { globalWorkHref } from '../work-page/route.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { RecipeEditor } from './editor.tsx';
import type { RecipeExport } from './export-api.ts';
import { mainRecipeImportApi, type RecipeImportApi } from './import-api.ts';
import { copyOf, messages } from './messages.ts';
import { RecipeExchange } from './recipe-exchange.tsx';
import { recipeEditHref } from './route.ts';
import {
  loadRecipeAuthoring,
  readRecipeVisitFrame,
  recordedFileImportTarget,
  type RecipeAuthoringMapped,
} from './recipe-authoring-recorded-page.ts';

function actingSubjectOf(record: AnswerRecord, persona: AnswerPersona): string | null {
  const sample =
    record.personas[persona].find((item) => item.label === 'editor-authority') ??
    record.personas[persona].find((item) => item.label === 'editor-work-header');
  if (!sample) return null;
  return new URL(sample.path, 'https://recorded.invalid').searchParams.get('actingSubject');
}

function workIdOf(record: AnswerRecord, persona: AnswerPersona): string | null {
  const sample = record.personas[persona].find((item) => item.label === 'editor-work-header');
  if (!sample) return null;
  return new URL(sample.path, 'https://recorded.invalid').pathname.split('/').pop() ?? null;
}

/** The editor body both the server page and a recorded story render. */
export function RecipeAuthoringBody({
  view,
  locale,
  workRef,
  workHref,
  signInHref,
  main,
  importApi,
  saveExport,
}: {
  view: RecipeAuthoringMapped;
  locale: UiLocale;
  workRef: string;
  workHref: string;
  signInHref: string;
  main?: () => ReturnType<typeof browserMainApi>;
  importApi?: RecipeImportApi;
  saveExport?: (exported: RecipeExport, contentLanguage?: string, recipeName?: string) => void;
}) {
  const t = copyOf(locale);
  if (view.kind === 'discrepancy') return <p role="alert">{view.detail}</p>;
  if (view.kind === 'no-authority') {
    return (
      <NoAuthority
        workRef={workRef}
        signedIn={view.signedIn}
        t={editCopy(locale)}
        signInHref={signInHref}
      />
    );
  }
  if (view.kind === 'unavailable') {
    return (
      <EmptyState
        icon={ChefHatIcon}
        role="status"
        tone="destructive"
        title={t.unavailableTitle}
        description={t.unavailableBody}
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
      saveExport={saveExport}
    />
  );
}

type Shown =
  | { kind: 'loading' }
  | {
      kind: 'page';
      view: RecipeAuthoringMapped;
      main: () => ReturnType<typeof browserMainApi>;
      importApi: RecipeImportApi;
    }
  | {
      kind: 'panel';
      target: NonNullable<ReturnType<typeof recordedFileImportTarget>>;
      importApi: RecipeImportApi;
    };

/**
 * Authoring and exchange from recorded answers. The story file holds no reader:
 * this runs `loadRecipeAuthoring` and, when the visit recorded a frame, `readRecipeVisitFrame`.
 */
export function RecipeAuthoringRecordedPage({
  record,
  persona,
  selections,
  locale,
  frame = false,
  registry = null,
  mode = 'page',
}: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
  /** Exchange visits recorded the layout frame. Authoring did not record `GET /v1/types`. */
  frame?: boolean;
  /** Served type registry when the row has no `GET /v1/types` of its own. */
  registry?: TypeRegistry | null;
  mode?: 'page' | 'file-import';
}) {
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const workId = workIdOf(record, persona);
  const workRef = workId ?? '';

  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const origin = window.location.origin;
    const main = browserMainApi(origin, {
      anonymous: persona === 'visitor',
      fetcher: replay.fetcher,
    });
    const importApi = mainRecipeImportApi({ fetch: replay.fetcher, origin });
    void (async () => {
      if (mode === 'file-import') {
        const sample =
          selections.length === 1
            ? record.personas[persona].find((item) => item.label === selections[0]?.label)
            : undefined;
        const target = sample ? recordedFileImportTarget(sample.path) : null;
        if (!target)
          throw new Error('Recorded file import is missing its structure, head or acting person');
        if (mounted) setShown({ kind: 'panel', target, importApi });
        return;
      }
      if (registry) seedTypes(registry);
      if (frame) {
        const framed = await readRecipeVisitFrame(main, replay.fetcher, {
          actingSubject: actingSubjectOf(record, persona),
          locale,
          origin,
        });
        if (!framed.ok) {
          if (mounted)
            setShown({
              kind: 'page',
              view: { kind: 'discrepancy', detail: framed.detail },
              main: () => main,
              importApi,
            });
          return;
        }
      }
      const loaded = await loadRecipeAuthoring(main, {
        id: workRef,
        actingSubject: actingSubjectOf(record, persona),
        signedIn: persona !== 'visitor',
      });
      if (mounted) setShown({ kind: 'page', view: loaded, main: () => main, importApi });
    })().catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setShown({
        kind: 'page',
        view: {
          kind: 'discrepancy',
          detail: error instanceof Error ? error.message : String(error),
        },
        main: () => main,
        importApi,
      });
    });
    return () => {
      mounted = false;
      replay.dispose();
    };
  }, [frame, locale, mode, persona, record, registry, selections, workRef]);

  if (shown.kind === 'loading')
    return (
      <p role="status" aria-busy="true">
        {shellMessages.loading}
      </p>
    );
  if (shown.kind === 'panel') {
    return (
      <RecipeExchange
        structure={shown.target.structure}
        revision={shown.target.expectedHead}
        actingSubject={shown.target.actingSubject}
        locale={locale}
        messages={messages[locale]}
        importApi={shown.importApi}
        save={() => {
          /* The recorded refusal is the import answer. */
        }}
      />
    );
  }
  return (
    <RecipeAuthoringBody
      view={shown.view}
      locale={locale}
      workRef={workRef}
      workHref={globalWorkHref(workRef)}
      signInHref={signInPath(localizedPath(recipeEditHref(workRef), locale))}
      main={shown.main}
      importApi={shown.importApi}
      saveExport={() => {
        /* The status names the recorded revision; the file is not kept in the story. */
      }}
    />
  );
}
