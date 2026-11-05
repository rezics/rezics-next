import { useLayoutEffect, useRef, type MouseEvent } from 'react';

/** Specialist forms retain their own row admission; only the keyboard handoff is shared. */
export function useSpecialistLanguageAddFocus() {
  const pending = useRef<{
    origin: HTMLButtonElement;
    targetId: string;
    admitted: () => boolean;
    dispose: () => void;
  } | null>(null);
  const cancel = () => {
    pending.current?.dispose();
    pending.current = null;
  };
  useLayoutEffect(() => {
    const intent = pending.current;
    cancel();
    if (!intent) return;
    const { origin, targetId, admitted } = intent;
    if (!origin.isConnected || origin.ownerDocument.activeElement !== origin || !admitted()) return;
    const target = origin.ownerDocument.getElementById(targetId);
    if (target instanceof origin.ownerDocument.defaultView!.HTMLInputElement && !target.matches(':disabled'))
      target.focus();
  });
  useLayoutEffect(() => cancel, []);

  return (event: MouseEvent<HTMLButtonElement>, targetId: string, admitted: () => boolean) => {
    cancel();
    const origin = event.currentTarget;
    if (event.detail !== 0 || origin.ownerDocument.activeElement !== origin) return;
    // Moving away and back before React commits still retires the original intent.
    origin.addEventListener('focusout', cancel);
    pending.current = {
      origin,
      targetId,
      admitted,
      dispose: () => origin.removeEventListener('focusout', cancel),
    };
  };
}
