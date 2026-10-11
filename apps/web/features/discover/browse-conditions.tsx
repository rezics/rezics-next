'use client';

import type { EntityPickerLoad } from '@rezics/ui/entity-picker';
import type { UiLocale } from '../../i18n/define.ts';
import { DiscoverBrowseConditions } from '../query/condition-bar.tsx';
import type { ConceptChoice } from './api.ts';
import type { BrowseState } from './browse-state.ts';
import { iriOf } from './scope.ts';
import { topicLoader, type TopicItem } from './topic-picker.tsx';

/** Construct the picker on the browser side with the same reader as its server suggestions. */
export function BrowseConditions({ state, locale, signedIn, actingSubject, topics, load }: {
  state: BrowseState; locale: UiLocale; signedIn: boolean; actingSubject?: string;
  topics: readonly ConceptChoice[]; load?: EntityPickerLoad<TopicItem>;
}) {
  return <DiscoverBrowseConditions key={`${signedIn}:${actingSubject ?? ''}`} state={state} locale={locale}
    actingSubject={actingSubject} topics={topics} load={load ?? topicLoader(locale, actingSubject,
      state.scope.kind === 'realm' ? iriOf(state.scope.realm) : undefined, signedIn)} />;
}
