import { useEffect, useRef, type MouseEvent } from 'react';
import type { Accepted } from './navigation';

const lifetime = 30_000;
type Origin = {
  anchor: HTMLAnchorElement;
  token: object;
  activated: number;
  occurrence: string;
  expires: number;
  leftWindow: boolean;
};

/** One visit-local, short-lived keyboard intent. It never authorizes a retained response. */
export function useEndpointReturn(input: {
  accepted: Accepted | undefined;
  current: () => boolean;
  heading: () => void;
}) {
  const binding = useRef({ accepted: input.accepted, token: {} });
  if (binding.current.accepted !== input.accepted) binding.current = { accepted: input.accepted, token: {} };
  const latest = useRef({ ...input, token: binding.current.token });
  latest.current = { ...input, token: binding.current.token };
  const origin = useRef<Origin | undefined>(undefined);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => {
    origin.current = undefined;
    clearTimeout(expiry.current);
    expiry.current = undefined;
  };
  useEffect(() => {
    const blur = () => {
      const bookmark = origin.current;
      if (!bookmark) return;
      // A later unrelated window switch is not the endpoint activation.
      if (Date.now() - bookmark.activated > 1_000) clear();
      else bookmark.leftWindow = true;
    };
    const focusin = (event: FocusEvent) => {
      const bookmark = origin.current;
      if (bookmark && event.target !== bookmark.anchor && event.target !== document.body) clear();
    };
    const restore = () => {
      const bookmark = origin.current;
      clear();
      const state = latest.current;
      if (
        !bookmark ||
        !bookmark.leftWindow ||
        bookmark.expires < Date.now() ||
        !state.current() ||
        state.token !== bookmark.token
      )
        return;
      const active = document.activeElement;
      if (active !== bookmark.anchor && active !== document.body) return;
      if (bookmark.anchor.isConnected && bookmark.anchor.dataset.occurrence === bookmark.occurrence)
        bookmark.anchor.focus();
      else if (active === document.body) state.heading();
    };
    // A second pointer/key action consumes the old intent even if it opens no window.
    window.addEventListener('pointerdown', clear);
    window.addEventListener('keydown', clear);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', restore);
    document.addEventListener('focusin', focusin);
    return () => {
      clear();
      window.removeEventListener('pointerdown', clear);
      window.removeEventListener('keydown', clear);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', restore);
      document.removeEventListener('focusin', focusin);
    };
  }, []);
  // Do not let an accepted-address change keep even a detached anchor alive.
  if (origin.current && origin.current.token !== binding.current.token) clear();
  return (event: MouseEvent<HTMLAnchorElement>) => {
    clear();
    if (
      event.detail !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !input.current() ||
      !input.accepted ||
      document.activeElement !== event.currentTarget
    )
      return;
    origin.current = {
      anchor: event.currentTarget,
      occurrence: event.currentTarget.dataset.occurrence ?? '',
      token: binding.current.token,
      activated: Date.now(),
      expires: Date.now() + lifetime,
      leftWindow: false,
    };
    expiry.current = setTimeout(clear, lifetime);
  };
}
