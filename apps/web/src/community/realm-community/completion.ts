import { useEffect, useRef, type MouseEvent } from 'react';
import type { PublicationChange } from '../publication-controls';

/** A rendered result is useful only while its reader, route and native observation remain current. */
export type RealmCompletion = {
  realmId: string;
  current: () => boolean;
  focusEligible: () => boolean;
};

export type RealmMembershipCompletion = RealmCompletion & {
  action: 'join' | 'leave';
  membership: 'member' | 'pending' | 'none';
};

export type RealmPublicationCompletion = RealmCompletion & {
  subjectId: string;
  action: PublicationChange['action'];
  head: string;
};

/** True means that the eligible outer focus handoff actually happened. */
export type RealmCompleted<Receipt extends RealmCompletion> = (receipt: Receipt) => boolean;

export type RealmCompletionFocus = {
  eligible: () => boolean;
  restore: (fallback: HTMLElement | null) => void;
  cancel: () => void;
};

/** Keep keyboard intent local to the operation; a pointer, Tab or another focus destination cancels it. */
export function useRealmCompletionFocus() {
  const pending = useRef<RealmCompletionFocus | null>(null);
  useEffect(() => () => pending.current?.cancel(), []);
  return (event: MouseEvent<HTMLButtonElement>): RealmCompletionFocus => {
    pending.current?.cancel();
    const control = event.currentTarget;
    const document = control.ownerDocument;
    let active = event.detail === 0 && document.activeElement === control;
    const cancel = () => {
      active = false;
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', moved, true);
      if (pending.current === intent) pending.current = null;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab') cancel();
    };
    const moved = (event: FocusEvent) => {
      if (event.target !== control) cancel();
    };
    const eligible = () => active && (document.activeElement === control || document.activeElement === document.body);
    const intent: RealmCompletionFocus = {
      eligible,
      cancel,
      restore(fallback) {
        if (eligible()) {
          const target = control.isConnected && !control.hasAttribute('disabled') ? control : fallback;
          if (target?.isConnected) target.focus({ preventScroll: true });
        }
        cancel();
      },
    };
    if (active) {
      document.addEventListener('pointerdown', cancel, true);
      document.addEventListener('keydown', key, true);
      document.addEventListener('focusin', moved, true);
    }
    pending.current = intent;
    return intent;
  };
}
