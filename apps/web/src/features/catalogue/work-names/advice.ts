import { useEffect, useRef, useState } from 'react';
import type { BrowserObservationSnapshot } from '../../../session/observation';
import type { TermsPageAuthority } from '../subject-terms';
import { peopleNamesAdvice, type NamesAdvice } from '../people-names/model';

export type NamesAdviceLoader = (reader: string) => Promise<TermsPageAuthority>;
export const loadNamesAdvice: NamesAdviceLoader = async (reader) => {
  const { readCatalogueTermsAuthority } = await import('../subject-terms-actions');
  return readCatalogueTermsAuthority({ data: { expectedReader: reader } });
};

/** Advice can fail independently of the public projection. Only its failed section is retried, once. */
export function useNamesAdvice(observation: BrowserObservationSnapshot, current: () => boolean,
  loader: NamesAdviceLoader, initial?: TermsPageAuthority) {
  const [advice, setAdvice] = useState<NamesAdvice>(initial ? peopleNamesAdvice(initial) : 'unavailable');
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    if (observation.state !== 'signed-in' || !latest.current() || (initial && attempt === 0)) return;
    let active = true;
    inFlight.current = true;
    setAdvice('pending');
    void loader(observation.observation.subject).then(
      result => { if (active && latest.current()) setAdvice(peopleNamesAdvice(result)); },
      () => { if (active && latest.current()) setAdvice('unavailable'); },
    ).finally(() => { if (active) inFlight.current = false; });
    return () => { active = false; inFlight.current = false; };
  }, [observation, loader, initial, attempt]);
  return {
    advice: observation.state === 'signed-out' ? 'signed-out' as const : observation.state !== 'signed-in' ? 'unavailable' as const : advice,
    retryAdvice: observation.state === 'signed-in' && attempt === 0 && advice === 'unavailable'
      ? () => { if (!inFlight.current && latest.current()) setAttempt(1); } : undefined,
  };
}
