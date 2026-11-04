import { useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { browserObservation } from '../../../session/observation';
import type { Subject } from '../../../subject/types';
import { workNames, supportsWorkNames } from './model';
import { WorkNamesView } from './view';

/** Uses the page's admitted terms; opening any group performs no native reads. */
export function WorkNamesEntry({
  subject,
  ancestors,
  source,
  locale,
  context,
  sourcesHref,
}: {
  subject: Subject;
  ancestors?: readonly string[] | undefined;
  source: object;
  locale: string;
  context: string | null;
  sourcesHref: string;
}) {
  const client = useQueryClient();
  const store = browserObservation(client);
  const observation = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const seen = useRef(new WeakSet<object>());
  const captured = useRef<{
    source: object;
    observation: typeof observation;
    retired: boolean;
    identity: string;
    generation: number;
  } | null>(null);
  const identity = JSON.stringify([subject.id, context, locale]);
  if (!captured.current || captured.current.source !== source) {
    captured.current = {
      source,
      observation,
      retired: seen.current.has(source),
      identity,
      generation: (captured.current?.generation ?? 0) + 1,
    };
    seen.current.add(source);
  } else {
    if (
      captured.current.observation.state === 'unknown' &&
      observation.state !== 'unknown' &&
      !captured.current.retired
    )
      captured.current.observation = observation;
    if (captured.current.observation !== observation || captured.current.identity !== identity)
      captured.current.retired = true;
  }
  const names = useMemo(() => workNames(subject, locale), [subject, source, locale]);
  if (!supportsWorkNames(subject.type, ancestors)) return null;
  return (
    <WorkNamesView
      key={captured.current.generation}
      names={names}
      locale={locale}
      retired={captured.current.retired}
      sourcesHref={sourcesHref}
    />
  );
}
