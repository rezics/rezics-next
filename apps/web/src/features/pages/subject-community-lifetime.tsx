import { useRef } from 'react';

/** A visit belongs to one admitted Subject source, reader, Context, route and native reaction target. */
export function useSubjectCommunityLifetime(input: {
  subjectId: string;
  contextId: string | null;
  reader: string | null;
  route: string;
  source: string;
  targetId: string;
  ready: boolean;
}) {
  const identity = JSON.stringify([
    input.subjectId,
    input.contextId,
    input.reader,
    input.route,
    input.source,
    input.targetId,
    input.ready,
  ]);
  const visit = useRef({ identity, generation: 0 });
  if (visit.current.identity !== identity) {
    visit.current = { identity, generation: visit.current.generation + 1 };
  }
  const generation = visit.current.generation;
  return {
    key: JSON.stringify([identity, generation]),
    reader: input.reader,
    isCurrent: () => visit.current.identity === identity && visit.current.generation === generation,
  };
}
