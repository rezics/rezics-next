import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyClassificationCommand,
  applyClassificationRead,
  dispatchClassificationCommand,
  emptyClassificationSnapshot,
  retireClassificationSnapshot,
  retryableClassificationCommand,
  type ClassificationAssessmentSession,
  type ClassificationAssessmentSnapshot,
  type ClassificationAssessmentTransport,
} from './subject-classification-assessment-controller';
import {
  sameClassificationAssociation,
  type ClassificationAssociationIdentity,
} from './subject-classification-assessment';
import type { ClassificationCommand } from './subject-classification-assessment-commands';

export function useClassificationAssessmentVisit(input: {
  identity: ClassificationAssociationIdentity | null;
  locale: string;
  session: ClassificationAssessmentSession;
  reader: string | null;
  csrfToken: string | null;
  transport?: ClassificationAssessmentTransport;
}): {
  snapshot: ClassificationAssessmentSnapshot;
  select: (identity: ClassificationAssociationIdentity | null) => void;
  send: (command: ClassificationCommand) => Promise<void>;
  retry: () => Promise<void>;
} {
  const [selected, setSelected] = useState<ClassificationAssociationIdentity | null>(input.identity);
  const [snapshot, setSnapshot] = useState<ClassificationAssessmentSnapshot>(() =>
    emptyClassificationSnapshot(input.session, input.identity, input.reader),
  );
  const incarnation = useRef(0);
  const current = useRef({ selected, reader: input.reader, session: input.session, csrf: input.csrfToken });
  current.current = { selected, reader: input.reader, session: input.session, csrf: input.csrfToken };

  useEffect(() => {
    const next = retireClassificationSnapshot(snapshot, {
      identity: selected,
      reader: input.reader,
      session: input.session,
    });
    if (next !== snapshot) setSnapshot(next);
    incarnation.current += 1;
    const visit = incarnation.current;
    if (!selected || (input.session !== 'signed-in' && input.session !== 'signed-out')) return;
    if (input.session === 'signed-out') return;
    const transport = input.transport;
    const identity = selected;
    const reader = input.reader;
    const locale = input.locale;
    void (async () => {
      const read = transport
        ? await transport.read({ identity, locale, expectedReader: reader })
        : await loadClassificationAssessmentFromDefault(identity, locale, reader);
      if (visit !== incarnation.current) return;
      if (!sameClassificationAssociation(current.current.selected, identity)) return;
      if (current.current.reader !== reader || current.current.session !== input.session) return;
      setSnapshot((previous) =>
        applyClassificationRead(
          retireClassificationSnapshot(previous, {
            identity,
            reader,
            session: input.session,
          }),
          read,
        ),
      );
    })().catch(() => {
      if (visit !== incarnation.current) return;
      setSnapshot((previous) => ({
        ...retireClassificationSnapshot(previous, { identity, reader, session: input.session }),
        own: { kind: 'unavailable' },
        aggregate: { kind: 'unavailable' },
      }));
    });
    // Selected association, viewer and session replacement retire the previous visit.
  }, [selected, input.reader, input.session, input.locale, input.transport]);

  const select = useCallback((identity: ClassificationAssociationIdentity | null) => {
    setSelected(identity);
  }, []);

  const send = useCallback(
    async (command: ClassificationCommand) => {
      if (current.current.csrf !== command.csrfToken || current.current.reader !== command.expectedReader) return;
      if (!sameClassificationAssociation(current.current.selected, command.identity)) return;
      const visit = incarnation.current;
      const next = await dispatchClassificationCommand(snapshot, command, input.transport);
      if (visit !== incarnation.current) return;
      setSnapshot(next);
    },
    [input.transport, snapshot],
  );

  const retry = useCallback(async () => {
    const command = retryableClassificationCommand(snapshot);
    if (!command) return;
    await send(command);
  }, [send, snapshot]);

  return { snapshot, select, send, retry };
}

async function loadClassificationAssessmentFromDefault(
  identity: ClassificationAssociationIdentity,
  locale: string,
  expectedReader: string | null,
) {
  const { readSubjectClassificationAssessment } = await import('./subject-classification-assessment-actions');
  return readSubjectClassificationAssessment({ data: { identity, locale, expectedReader } });
}

export function applyLocalCommand(
  snapshot: ClassificationAssessmentSnapshot,
  outcome: Parameters<typeof applyClassificationCommand>[1],
): ClassificationAssessmentSnapshot {
  return applyClassificationCommand(snapshot, outcome);
}
