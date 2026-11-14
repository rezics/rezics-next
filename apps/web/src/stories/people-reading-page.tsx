import { useMemo } from 'react';
import { pickText } from '@rezics/composition';
import {
  peopleReadingFixture,
  peopleReadingIds,
  selectPeopleReading,
  type PeopleReadingFamily,
  type PeopleReadingState,
} from '../kernel/fake/people-reading';
import { getLocale } from '../paraglide/runtime';
import { subjectHref } from '../subject/subject-href';
import { PageStory } from './page';

/** The installed route tree owns shell, tabs, current reading, navigation and continuation. */
export function PeopleReadingPage({
  family,
  state = 'complete',
}: {
  family: PeopleReadingFamily;
  state?: PeopleReadingState;
}) {
  const locale = getLocale();
  const fixture = useMemo(() => {
    selectPeopleReading(state);
    return peopleReadingFixture(state);
  }, [state, family, locale]);
  const current = fixture.profiles[family];
  return (
    <PageStory
      visitor="Signed Out"
      previewNewTabs
      path={
        subjectHref({ id: peopleReadingIds[family], label: pickText(current.subject.labels, locale).text }, locale).href
      }
    />
  );
}
