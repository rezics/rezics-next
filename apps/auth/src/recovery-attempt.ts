import { useRouter } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { RecoveryReturnController } from './recovery-return';

// Retiring an attempt only discards browser work; the native mutation may still finish.
export class RecoveryAttempt {
  private active = true;
  private pending = false;
  scrubbingFragment = false;
  readonly returned;

  constructor(readonly outcomes = new RecoveryReturnController()) {
    this.returned = outcomes.summary;
  }

  get available() {
    return this.active && !this.pending;
  }

  begin() {
    if (!this.available) return null;
    this.pending = true;
    return () => {
      if (!this.active) return false;
      this.pending = false;
      return true;
    };
  }

  retire() {
    this.active = false;
  }

  removeFragment() {
    // Browser history also notifies the router. This replacement belongs to this journey.
    this.scrubbingFragment = true;
    try {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    } finally {
      this.scrubbingFragment = false;
    }
  }
}

export function useRecoveryAttempt() {
  const { history } = useRouter();
  const sequence = useRef(0);
  const [journey, setJourney] = useState<{ key: number; attempt: RecoveryAttempt } | null>(null);

  useLayoutEffect(() => {
    let current: RecoveryAttempt | null = null;
    const outcomes = new RecoveryReturnController();
    const replace = () => {
      current?.retire();
      current = new RecoveryAttempt(outcomes);
      setJourney({ key: ++sequence.current, attempt: current });
    };
    const leave = () => {
      current?.retire();
      current = null;
      // Unmount the form, including all private inputs, even in a cached document.
      flushSync(() => setJourney(null));
    };
    const unsubscribe = history.subscribe(({ location }) => {
      if (current?.scrubbingFragment) return;
      if (location.pathname === '/recovery') replace();
      else leave();
    });
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted && window.location.pathname === '/recovery') replace();
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
