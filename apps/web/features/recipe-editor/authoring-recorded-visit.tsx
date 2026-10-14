'use client';

import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import EditLayout from '../../app/[locale]/w/[ref]/edit/layout.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { globalWorkHref } from '../work-page/route.ts';
import { loadRecipeAuthoring, type RecipeAuthoringMapped } from './authoring-page.ts';
import { RecipeAuthoringBody, RecipeAuthoringPending } from './authoring-page.tsx';
import { mainRecipeImportApi } from './import-api.ts';
import { recipeEditHref } from './route.ts';

/** Replay transports only: all reads and page decisions belong to the production authoring boundary. */
export function RecipeAuthoringRecordedVisit({ record, persona, selections, locale }: {
  record: AnswerRecord; persona: AnswerPersona; selections: readonly RecordedSelection[]; locale: UiLocale;
}) {
  const header = record.personas[persona].find(item => item.label === 'editor-work-header');
  if (!header) throw new Error('Missing editor header');
  const path = new URL(header.path, 'https://recorded.invalid');
  const id = path.pathname.split('/').pop()!;
  const actingSubject = persona === 'visitor' ? null : path.searchParams.get('actingSubject');
  const [ready, setReady] = useState<{ view: RecipeAuthoringMapped; main: ReturnType<typeof browserMainApi>;
    importApi: ReturnType<typeof mainRecipeImportApi> } | null>(null);
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const origin = window.location.origin;
    const main = browserMainApi(origin, { anonymous: persona === 'visitor', fetcher: replay.fetcher });
    void loadRecipeAuthoring(main, { id, actingSubject, signedIn: persona !== 'visitor' }).then(view => {
      if (mounted) setReady({ view, main, importApi: mainRecipeImportApi({ fetch: replay.fetcher, origin }) });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [actingSubject, id, persona, record, selections]);
  return <EditLayout>{ready ? <RecipeAuthoringBody view={ready.view} locale={locale} workRef={id}
    workHref={globalWorkHref(id)} signInHref={signInPath(localizedPath(recipeEditHref(id), locale))}
    main={() => ready.main} importApi={ready.importApi} saveExport={() => { /* Browser download is not retained in a story. */ }} />
    : <RecipeAuthoringPending locale={locale} />}</EditLayout>;
}
