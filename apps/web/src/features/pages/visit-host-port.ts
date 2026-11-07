import { createContext, createElement, useContext, type ReactNode } from 'react';

/** The page reader's native outcome vocabulary. */
export type CandidateFailure = {
  ok: false;
  reason: 'denied' | 'stale' | 'unavailable' | 'invalid';
  clearPrivate?: boolean;
};

export const candidateContext = '00000000-0000-8000-8000-000000000000';

/** Missing and hidden use the same unavailable outcome. Never reveal existence from a denial. */
export function candidateFailure(status: number): CandidateFailure {
  return {
    ok: false,
    reason:
      status === 401 || status === 403
        ? 'denied'
        : status === 409
          ? 'stale'
          : status === 400 || status === 422
            ? 'invalid'
            : 'unavailable',
  };
}

/** Validate the browser's expected reader at the server-function boundary. */
export function expectedCandidateReader(input: unknown): string {
  if (
    !input ||
    typeof input !== 'object' ||
    !('expectedReader' in input) ||
    typeof input.expectedReader !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i.test(input.expectedReader)
  )
    throw new Error('Invalid candidate reader');
  return input.expectedReader;
}

export type CandidateSessionObservation = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null | undefined;
  csrfToken?: string | null | undefined;
};

export type CandidateWork = { reader: string; live: () => boolean };
export type CandidateVisit = CandidateWork & {
  generation: number;
  retire: () => void;
  active: () => boolean;
};
export type CandidateSessionLease = {
  reader: string;
  generation: number;
  current: () => boolean;
  subscribe: (listener: () => void) => () => void;
};
export type CandidateAddressLease = { current: () => boolean; retire: () => void };
export type CandidateBrowserObservation = {
  reader: string;
  generation: number;
  current: () => boolean;
};
export type CandidateExposureObservation = {
  revision: string;
  current: () => boolean;
};

/** Web supplies browser/session capabilities; the page application owns their visit semantics. */
export type PageVisitHost = {
  useSessionObservation: () => CandidateSessionObservation;
  useBrowserObservation: () => CandidateBrowserObservation;
  captureBrowserObservation: () => CandidateBrowserObservation;
  useExposureObservation: () => CandidateExposureObservation;
  createAddressLease: (parentLive?: (() => boolean) | undefined) => CandidateAddressLease;
};

const PageVisitHostContext = createContext<PageVisitHost | null>(null);

export function PageVisitHostProvider({ host, children }: { host: PageVisitHost; children: ReactNode }) {
  return createElement(PageVisitHostContext.Provider, { value: host, children });
}

export function usePageVisitHost(): PageVisitHost {
  const host = useContext(PageVisitHostContext);
  if (!host) throw new Error('PageVisitHost is not installed');
  return host;
}
