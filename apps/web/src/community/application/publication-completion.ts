import { useEffect, useMemo, useRef, useState } from 'react';
import { usePublicationControls, type useShelfContinuationFocus } from '../publication-controls-view';
import {
  useRealmCompletionFocus,
  type RealmCompleted,
  type RealmPublicationCompletion,
  type RealmCompletionFocus,
} from '../realm-community/completion';
import type { PublicationChange } from '../publication-controls';
import type { RealmHome, PublishedSubject } from '../space';
import type { useShelfList } from '../space-queries';
import type { CommunityRealmReading, CommunityVisitApplication, RealmShelfTransport } from '../contract/visit';

/** Acknowledgement alone cannot complete a command: the selected shelf must admit and commit its refresh. */
export function useRealmPublicationCompletion({
  realm,
  application,
  transport,
  reading,
  publications,
  selection,
  current,
  frozen,
  publicationFocus,
  onCompleted,
}: {
  realm: RealmHome;
  application: CommunityVisitApplication;
  transport: RealmShelfTransport | undefined;
  reading: CommunityRealmReading;
  publications: ReturnType<typeof useShelfList<PublishedSubject>>;
  selection: { node?: 'boards' | 'publications' | undefined; cursor?: string | undefined };
  current: () => boolean;
  frozen: boolean;
  publicationFocus: ReturnType<typeof useShelfContinuationFocus>;
  onCompleted: RealmCompleted<RealmPublicationCompletion> | undefined;
}) {
  const { state, csrfToken, subject: reader } = application.session;
  const captureFocus = useRealmCompletionFocus();
  const commandFocus = useRef<RealmCompletionFocus | null>(null);
  const currentControl = useRef<ReturnType<typeof usePublicationControls> | null>(null);
  const [completed, setCompleted] = useState<{
    input: PublicationChange;
    head: string;
    intent: object;
    current: () => boolean;
    focus: RealmCompletionFocus | null;
  } | null>(null);
  const delivered = useRef(new WeakSet<object>());
  const publicationSource = useMemo(() => ({ realmId: realm.id }), [realm.id]);
  const control = usePublicationControls(
    realm.id,
    transport?.change ?? reading.transport.change,
    (input, target, head) => {
      publications.update((previous) => ({
        ...previous,
        items:
          input.action === 'publish'
            ? [{ ...target, publicationId: head }, ...previous.items.filter((subject) => subject.id !== target.id)]
            : previous.items.filter((subject) => subject.id !== target.id),
      }));
      if (!onCompleted || !current() || !control.current()) return;
      const intent = {};
      const draftCurrent = control.current;
      setCompleted({
        input,
        head,
        intent,
        focus: commandFocus.current,
        current: () => {
          const live = currentControl.current;
          return (
            current() &&
            draftCurrent() &&
            live?.target?.id === input.subjectId &&
            live.action === input.action &&
            live.outcome?.kind === 'saved' &&
            live.outcome.head === head
          );
        },
      });
      // Use the existing shelf reader and its admission receipt, including the selected physical window.
      if (selection.node === 'publications' && selection.cursor) void publications.restore(selection.cursor, intent);
      else void publications.load(true, intent);
    },
    publications.items,
    !frozen && state === 'signed-in' && Boolean(csrfToken),
    reader ?? '',
    transport?.prepare ?? reading.transport.prepare,
    publicationSource,
  );
  currentControl.current = control;
  useEffect(() => {
    const receipt = publications.continuation;
    if (
      !completed ||
      !completed.current() ||
      publications.busy ||
      publications.failure ||
      receipt?.intent !== completed.intent ||
      !receipt.current() ||
      delivered.current.has(completed.intent)
    )
      return;
    delivered.current.add(completed.intent);
    const outcome = currentControl.current?.outcome;
    const receiptCurrent = () =>
      completed.current() && currentControl.current?.outcome === outcome && receipt.current();
    const result: RealmPublicationCompletion = {
      realmId: realm.id,
      subjectId: completed.input.subjectId,
      action: completed.input.action,
      head: completed.head,
      current: receiptCurrent,
      focusEligible: () => receiptCurrent() && !!completed.focus?.eligible(),
    };
    const eligible = result.focusEligible();
    const handedOff = onCompleted?.(result) === true;
    if (eligible && !handedOff && result.current()) completed.focus?.restore(publicationFocus.boundaryRef.current);
    else completed.focus?.cancel();
  }, [completed, publications.continuation, publications.busy, publications.failure, onCompleted]);
  return {
    control,
    captureCommandFocus: (event: React.MouseEvent<HTMLButtonElement>) => {
      commandFocus.current = captureFocus(event);
    },
  };
}
