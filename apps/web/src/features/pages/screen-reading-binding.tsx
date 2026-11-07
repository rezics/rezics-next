import type { ReactNode } from 'react';
import { subjectHref } from '../../subject/load-subject';
import {
  ScreenReadingApplicationProvider,
  type ScreenReadingApplication,
  type ScreenReadingPort,
} from '../catalogue/screen-reading-application';
import { subjectVisitReturn } from './subject-visit-navigation';
import { SpoilerGate } from './values';

/** Bind Search page values, spoiler disclosure, canonical hrefs and visit-return admission. */
export function screenReadingPort(PageValue: ScreenReadingPort['PageValue']): ScreenReadingApplication {
  return {
    PageValue,
    SpoilerGate,
    visitReturn: subjectVisitReturn,
    subjectHref: (subject, locale) => subjectHref(subject, locale),
  };
}

export function ScreenReadingBinding({
  PageValue,
  children,
}: {
  PageValue: ScreenReadingPort['PageValue'];
  children: ReactNode;
}) {
  return (
    <ScreenReadingApplicationProvider port={screenReadingPort(PageValue)}>{children}</ScreenReadingApplicationProvider>
  );
}
