'use client';

import { useEffect, useState } from 'react';
import EditLayout from '../../app/[locale]/w/[ref]/edit/layout.tsx';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { globalWorkHref } from '../work-page/route.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { RecipeAuthoringBody as ProductionRecipeAuthoringBody } from './authoring-page.tsx';
import type { RecipeExport } from './export-api.ts';
import { mainRecipeImportApi, type RecipeImportApi } from './import-api.ts';
import { recipeEditHref } from './route.ts';
import {
  loadRecipeAuthoring,
  readRecipeVisitFrame,
  type RecipeAuthoringMapped,
} from './recipe-authoring-recorded-page.ts';

function actingSubjectOf(record: AnswerRecord, persona: AnswerPersona, headerLabel: string): string | null {
  const sample = record.personas[persona].find((item) => item.label === headerLabel);
  if (!sample) return null;
  return new URL(sample.path, 'https://recorded.invalid').searchParams.get('actingSubject');
}

function workIdOf(record: AnswerRecord, persona: AnswerPersona, headerLabel: string): string | null {
  const sample = record.personas[persona].find((item) => item.label === headerLabel);
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
  newImportId,
}: {
  view: RecipeAuthoringMapped;
  locale: UiLocale;
  workRef: string;
  workHref: string;
  signInHref: string;
  main?: () => ReturnType<typeof browserMainApi>;
  importApi?: RecipeImportApi;
  newImportId?: () => string;
  saveExport?: (exported: RecipeExport, contentLanguage?: string, recipeName?: string) => void;
}) {
  if (view.kind === 'discrepancy') return <p role="alert">{view.detail}</p>;
  return <ProductionRecipeAuthoringBody view={view} locale={locale} workRef={workRef} workHref={workHref}
    signInHref={signInHref} main={main} importApi={importApi} saveExport={saveExport} newImportId={newImportId} />;
}

type Shown =
  | { kind: 'loading' }
  | {
      kind: 'page';
      view: RecipeAuthoringMapped;
      main: () => ReturnType<typeof browserMainApi>;
      importApi: RecipeImportApi;
    };

/**
 * Authoring and exchange from recorded answers. The story file holds no reader:
 * this runs `loadRecipeAuthoring` and `readRecipeVisitFrame` for every visit.
 * The type registry is that persona's own `GET /v1/types`. A missing sample is not filled from another row.
 */
export function RecipeAuthoringRecordedPage({
  record,
  persona,
  selections,
  locale,
  headerLabel = 'editor-work-header',
  newImportId,
}: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
  /** The same reader can open a recorded destination Work with its own authority. */
  headerLabel?: string;
  newImportId?: () => string;
}) {
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const workId = workIdOf(record, persona, headerLabel);
  const workRef = workId ?? '';

  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, sequence: true });
    const origin = window.location.origin;
    const main = browserMainApi(origin, {
      anonymous: persona === 'visitor',
      fetcher: replay.fetcher,
    });
    const importApi = mainRecipeImportApi({ fetch: replay.fetcher, origin });
    void (async () => {
      {
        const framed = await readRecipeVisitFrame(main, replay.fetcher, {
          actingSubject: actingSubjectOf(record, persona, headerLabel),
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
        actingSubject: actingSubjectOf(record, persona, headerLabel),
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
  }, [headerLabel, locale, persona, record, selections, workRef]);

  if (shown.kind === 'loading')
    return (
      <p role="status" aria-busy="true">
        {shellMessages.loading}
      </p>
    );
  return (
    <EditLayout><RecipeAuthoringBody
      view={shown.view}
      locale={locale}
      workRef={workRef}
      workHref={globalWorkHref(workRef)}
      signInHref={signInPath(localizedPath(recipeEditHref(workRef), locale))}
      main={shown.main}
      importApi={shown.importApi}
      newImportId={newImportId}
      saveExport={() => {
        /* The status names the recorded revision; the file is not kept in the story. */
      }}
    /></EditLayout>
  );
}
