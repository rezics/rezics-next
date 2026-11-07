import { useMemo, type ReactNode } from 'react';
import { CandidateReaderBoundary, useCandidateReading } from '../candidate-reading-application';
import { usePageVisitHost, type CandidateSessionObservation } from '../visit-host-port';

/** Exposure replacement retires the visit through the shared Web observation adapter. */
export function ProducerHistoryAdmission({
  observed,
  address,
  locale,
  children,
}: {
  observed: CandidateSessionObservation;
  address: string;
  locale: string;
  children: ReactNode;
}) {
  const host = usePageVisitHost();
  const parent = useCandidateReading({ candidate: 'producer-exposure', locale, address });
  const exposure = host.useExposureObservation();
  const admission = useMemo(
    () => ({ reader: parent.reader, live: () => parent.active() && exposure.current() }),
    [parent, exposure],
  );
  return (
    <CandidateReaderBoundary observed={observed} admission={admission} address={address}>
      {children}
    </CandidateReaderBoundary>
  );
}
