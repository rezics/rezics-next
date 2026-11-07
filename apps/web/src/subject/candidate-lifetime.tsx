import { createElement, type ComponentType, type ReactNode } from 'react';
import {
  CandidateReaderBoundary as PageCandidateReaderBoundary,
  candidateSession as pageCandidateSession,
  useCandidateWork,
  useCatalogueLifetime,
} from '../features/pages/candidate-reading-application';
import type { CandidateWork, CandidateSessionLease } from '../features/pages/visit-host-port';
import { captureCandidateSession, PageVisitBinding, withPageVisitHost } from './page-visit-binding';

export type { CandidateWork, CandidateSessionLease };
export { useCandidateWork, useCatalogueLifetime, captureCandidateSession };

/** Compatibility boundary for existing Web-owned readers and isolated reader fixtures. */
export function CandidateReaderBoundary(props: {
  observed: Parameters<typeof PageCandidateReaderBoundary>[0]['observed'];
  address: string;
  children: ReactNode;
  admission?: CandidateWork;
}) {
  return createElement(
    PageVisitBinding,
    { children: createElement(PageCandidateReaderBoundary, props) },
  );
}

/** Compatibility entry; new Search page readers use the page-owned application directly. */
export function candidateSession<Props extends object>(Component: ComponentType<Props>) {
  return withPageVisitHost(pageCandidateSession(Component));
}
