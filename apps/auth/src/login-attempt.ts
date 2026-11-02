import { useRouter } from '@tanstack/react-router';
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { useLayoutEffect, useRef, useState } from 'react';

type Method = 'password' | 'passkey' | 'autofill';

// Browser ownership only: retiring a request cannot undo a server sign-in.
export class LoginAttempt {
  private active = true;
  private current: { method: Method } | null = null;

  begin(method: Method) {
    if (!this.active) return null;
    if (this.current && this.current.method !== 'autofill') {
      if (method !== 'password' || this.current.method !== 'passkey') return null;
    }
    this.cancel();
    const token = { method };
    this.current = token;
    const isCurrent = () => this.active && this.current === token;
    return {
      isCurrent,
      finish: () => {
        if (!isCurrent()) return false;
        this.current = null;
        return true;
      },
    };
  }

  private cancel() {
    const previous = this.current;
    this.current = null;
    if (previous && previous.method !== 'password') WebAuthnAbortService.cancelCeremony();
  }

  retire() {
    this.active = false;
    this.cancel();
  }
}

export function useLoginJourney() {
  const { history } = useRouter();
  const sequence = useRef(0);
  const [journey, setJourney] = useState<{ key: number; query: string; attempt: LoginAttempt } | null>(() => ({
    key: 0,
    query: history.location.search,
    attempt: new LoginAttempt(),
  }));
  useLayoutEffect(() => {
    let current: LoginAttempt | null = null;
    const replace = () => {
      current?.retire();
      current = new LoginAttempt();
      setJourney({ key: ++sequence.current, query: history.location.search, attempt: current });
    };
    const leave = () => {
      current?.retire();
      current = null;
      setJourney(null);
    };
    const unsubscribe = history.subscribe(({ location }) => {
      if (location.pathname === '/login') replace();
      else leave();
    });
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted && window.location.pathname === '/login') replace();
    };
    window.addEventListener('pagehide', leave);
    window.addEventListener('pageshow', restore);
    replace();
    return () => {
      current?.retire();
      unsubscribe();
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('pageshow', restore);
    };
  }, [history]);
  return journey;
}
