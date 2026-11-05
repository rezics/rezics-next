import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { EntityPickerSearch } from '@rezics/ui/entity-picker';
import { m } from '../../../paraglide/messages.js';
import type { CandidateTransport } from '../../../subject/candidate-review';
import { AuthoringDepartureBoundary } from '../../../threads/authoring-departure';
import { CharacterClassifications } from '../character-profile-classification';
import { useCurrentReadingActive, useCurrentReadingVisible } from '../editor-lifetime';
import type { FactsCurrent, FactsTransport } from '../subject-facts';

const unavailableReview: CandidateTransport = {
  read: async () => ({ ok: false, reason: 'unavailable' }),
  confirm: async () => ({ ok: false, reason: 'unavailable' }),
};

type KeyboardRecovery = {
  opener: HTMLButtonElement;
  active: () => boolean;
  cancel: () => void;
};

let keyboardRecovery: KeyboardRecovery | undefined;

/** Capture only an explicit keyboard reload before its control leaves the tree. */
export function beginClassificationKeyboardRecovery(event: MouseEvent<HTMLButtonElement>) {
  const opener = event.currentTarget;
  const document = opener.ownerDocument;
  keyboardRecovery?.cancel();
  if (event.detail !== 0 || document.activeElement !== opener || !opener.isConnected) return;
  const cancel = () => {
    document.removeEventListener('focusin', moved, true);
    document.removeEventListener('pointerdown', cancel, true);
    document.removeEventListener('keydown', tabbed, true);
    if (keyboardRecovery?.cancel === cancel) keyboardRecovery = undefined;
  };
  const moved = (event: FocusEvent) => {
    if (event.target !== opener) cancel();
  };
  const tabbed = (event: KeyboardEvent) => {
    if (event.key === 'Tab') cancel();
  };
  keyboardRecovery = {
    opener,
    active: () => opener.isConnected,
    cancel,
  };
  document.addEventListener('focusin', moved, true);
  document.addEventListener('pointerdown', cancel, true);
  document.addEventListener('keydown', tabbed, true);
}

function consumeClassificationKeyboardRecovery() {
  const intent = keyboardRecovery;
  if (!intent) return false;
  const document = intent.opener.ownerDocument;
  const focused = document.activeElement;
  const admitted =
    intent.active() &&
    (focused === intent.opener || (!intent.opener.isConnected && (!focused || focused === document.body)));
  intent.cancel();
  return admitted;
}

/** Keep the last matching private reading for the mounted holder. */
export function retainClassificationRead<T>(slot: { current: T | undefined }, next: T | undefined): T | undefined {
  if (next) slot.current = next;
  return slot.current;
}

/** Album and Manga keep Character's classification writer mounted across reading loss and withdrawal. */
export function ClassificationRecovery({
  title,
  properties,
  read,
  locale,
  search,
  transport,
  review,
}: {
  title: ReactNode;
  properties: string[];
  read: FactsCurrent;
  locale: string;
  search: EntityPickerSearch;
  transport: FactsTransport;
  review: (property: string, session?: string) => CandidateTransport;
}) {
  const visible = useCurrentReadingVisible();
  const active = useCurrentReadingActive();
  const admittedReview = useMemo(
    () => (property: string, session?: string) => (active() ? review(property, session) : unavailableReview),
    [review, active],
  );
  const o = { locale: locale as never };
  const offered = properties.length > 0;
  const seen = useRef(offered);
  if (offered) seen.current = true;
  const show = offered || seen.current;
  const summary = useRef<HTMLDivElement>(null);
  const [recovered, setRecovered] = useState(0);
  const wasVisible = useRef(visible);
  if (wasVisible.current !== visible) {
    if (visible) setRecovered((count) => count + 1);
    wasVisible.current = visible;
  }
  useLayoutEffect(() => {
    if (!recovered || !visible) return;
    if (consumeClassificationKeyboardRecovery()) summary.current?.focus();
  }, [recovered, visible]);
  return (
    <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
      {visible && recovered > 0 && (
        <div
          ref={summary}
          role="status"
          tabIndex={-1}
          className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.classification_recovery_summary({}, o)}
        </div>
      )}
      {visible && show && title}
      {visible && show && !offered && (
        <p className="text-sm text-muted-foreground">{m.classification_recovery_withdrawn({}, o)}</p>
      )}
      <AuthoringDepartureBoundary sessionBound={false}>
        <CharacterClassifications
          properties={properties}
          read={read}
          locale={locale}
          search={search}
          transport={transport}
          review={admittedReview}
        />
      </AuthoringDepartureBoundary>
    </section>
  );
}
