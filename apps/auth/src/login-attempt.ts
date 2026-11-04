import { useRouter } from '@tanstack/react-router';
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { retainLoginHistory, type LoginPhase, type LoginReturnRecord, type LoginReturnHistory } from './login-return';

type Method = 'password' | 'passkey' | 'autofill' | 'continue';

// Browser ownership only: retiring a request cannot undo a server sign-in.
export class LoginAttempt {
  private active = true;
  private current: { method: Method; phase: LoginPhase } | null = null;
  private record: LoginReturnRecord | null = null;

  constructor(private readonly onUnknown?: (record: LoginReturnRecord) => void) {}

  snapshot() {
    return this.record;
  }

  private replaceable() {
    return !this.current || (this.current.method === 'autofill' && ['options', 'prompt'].includes(this.current.phase));
  }
  private pageGeneration = 0;

  // Choice changes and reads may replace conditional mediation, never a dispatched explicit operation.
  choose() {
    if (!this.active || !this.replaceable()) return false;
    this.cancel();
    this.pageGeneration += 1;
    return true;
  }

  begin(method: Method) {
    if (!this.active || !this.replaceable()) return null;
    this.cancel();
    this.pageGeneration += 1;
    const token = { method, phase: (method === 'password' ? 'dispatched' : 'options') as LoginPhase };
    const observe = (phase: LoginPhase) => {
      if (!isCurrent() || method === 'continue') return;
      token.phase = phase;
      this.record = { method, phase };
      if (phase === 'unknown') this.onUnknown?.(this.record);
    };
    this.current = token;
    const isCurrent = () => this.active && this.current === token;
    observe(token.phase);
    return {
      isCurrent,
      observe,
      finish: () => {
        if (!isCurrent()) return false;
        this.current = null;
        return true;
      },
    };
  }

  beginPageRead() {
    if (!this.choose()) return null;
    const generation = ++this.pageGeneration;
    let finished = false;
    const isCurrent = () => this.active && !finished && this.pageGeneration === generation;
    return {
      isCurrent,
      finish: () => {
        if (!isCurrent()) return false;
        finished = true;
        return true;
      },
      retire: () => {
        finished = true;
        if (this.pageGeneration === generation) this.pageGeneration += 1;
      },
    };
  }

  private cancel() {
    const previous = this.current;
    this.current = null;
    if (previous && (previous.method === 'passkey' || previous.method === 'autofill'))
      WebAuthnAbortService.cancelCeremony();
  }

  retire() {
    this.active = false;
    this.pageGeneration += 1;
    this.cancel();
  }
}

export function useLoginJourney() {
  const { history } = useRouter();
  const sequence = useRef(0);
  const [journey, setJourney] = useState<{
    key: number;
    query: string;
    attempt: LoginAttempt;
    restored: boolean;
  } | null>(null);
  const [records, setRecords] = useState<LoginReturnHistory>([]);
  useLayoutEffect(() => {
    let current: LoginAttempt | null = null;
    const remember = () => {
      const record = current?.snapshot();
      if (record) setRecords((previous) => retainLoginHistory(previous, record));
    };
    const replace = (restored = false) => {
      remember();
      current?.retire();
      current = new LoginAttempt((record) => setRecords((previous) => retainLoginHistory(previous, record)));
      setJourney({ key: ++sequence.current, query: history.location.search, attempt: current, restored });
    };
    const leave = () => {
      remember();
      current?.retire();
      current = null;
      setJourney(null);
    };
    const unsubscribe = history.subscribe(({ location }) => {
      if (location.pathname === '/login') replace();
      else leave();
    });
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted && history.location.pathname === '/login') replace(true);
    };
    // React must remove credential and private choice DOM before this event returns to the browser.
    const hide = () => flushSync(leave);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', restore);
    replace();
    return () => {
      current?.retire();
      unsubscribe();
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', restore);
    };
  }, [history]);
  return { journey, records, dismiss: () => setRecords([]) };
}
