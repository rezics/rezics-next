'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef } from 'react';
import type { Values, WriteState } from './write.ts';

type WriteAction = (previous: WriteState, form: FormData) => Promise<WriteState>;

const idle: WriteState = { status: 'idle' };

/**
 * One edit form's submit state. A recorded change refreshes the page so the lists read Main's new
 * state; a refusal leaves the typed values in `values` for the form to show again.
 */
export function useWrite(action: WriteAction) {
  const [state, run, pending] = useActionState(action, idle);
  const router = useRouter();
  const refreshed = useRef('');
  useEffect(() => {
    if (state.status === 'done' && refreshed.current !== state.nonce) {
      refreshed.current = state.nonce;
      router.refresh();
    }
  }, [state, router]);
  const values: Values = state.status === 'error' || state.status === 'pending' ? state.values : {};
  return { state, run, pending, values, reload: () => router.refresh(),
    /** Changes whenever the form should start empty again: after a recorded change. */
    formKey: state.status === 'done' ? state.nonce : 'open' };
}
