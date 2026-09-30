'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import type { Values, WriteState } from './write.ts';

type WriteAction = (previous: WriteState, form: FormData) => Promise<WriteState>;

const idle: WriteState = { status: 'idle' };

/**
 * One edit form's submit state. A recorded change refreshes the page so the lists read Main's new
 * state; a refusal leaves the typed values in `values` for the form to show again. After a moved
 * head, `reload` reads the page again and then clears the refusal, so the next submit carries the
 * new head and the typed values are still there.
 */
export function useWrite(action: WriteAction) {
  const [state, run, pending] = useActionState(action, idle);
  const router = useRouter();
  const refreshed = useRef('');
  const [reloading, startReload] = useTransition();
  const [dismissed, setDismissed] = useState<WriteState | null>(null);
  const wasReloading = useRef(false);
  useEffect(() => {
    if (state.status === 'done' && refreshed.current !== state.nonce) {
      refreshed.current = state.nonce;
      router.refresh();
    }
  }, [state, router]);
  useEffect(() => {
    if (wasReloading.current && !reloading) setDismissed(state);
    wasReloading.current = reloading;
  }, [reloading, state]);
  const values: Values = state.status === 'error' || state.status === 'pending' ? state.values : {};
  return { state: state === dismissed ? idle : state, run, pending, values, reloading,
    reload: () => startReload(() => { router.refresh(); }),
    /** Changes whenever the form should start empty again: after a recorded change. */
    formKey: state.status === 'done' ? state.nonce : 'open' };
}
