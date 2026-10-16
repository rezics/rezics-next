import type { UiLocale } from '../../i18n/define.ts';
import { createReaderStore } from '../catalogue/reader-store.ts';
import type { RelationshipsApi } from '../relationships/types.ts';
import { messages } from '../work-page/messages.ts';
import { readReaderState, readWorkHeader } from '../work-page/read.ts';
import { EVERYONE } from '../work-page/route.ts';
import { WorkContents, WorkFrameView, WorkOverview, type WorkPageClient } from '../work-page/work-views.tsx';

/** The actual Work route composition, supplying only its session client and existing command adapters. */
export async function mangaWorkVisit(client: WorkPageClient, id: string, tab: 'overview' | 'contents', locale: UiLocale = 'en', relationships?: RelationshipsApi) {
  const work = await readWorkHeader(id, locale, client);
  if (!work.ok) return work;
  const seed = await readReaderState(id, client);
  const actions = client.actingSubject && seed ? createReaderStore({ main: () => client.main,
    actingSubject: client.actingSubject, seed }) : undefined;
  const common = { client, id, workRef: id, work: work.data, locale, messages: messages[locale] };
  const children = tab === 'overview'
    ? await WorkOverview({ ...common, scope: EVERYONE, context: undefined })
    : await WorkContents({ ...common, query: {} });
  return { ok: true as const, work: work.data, page: await WorkFrameView({ ...common, children,
    readerActions: actions, relationships }) };
}
