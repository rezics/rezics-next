'use client';

import { useRouter } from 'next/navigation';
import { type RefObject, useActionState, useEffect, useRef, useState, useTransition } from 'react';
import type { Values, WriteState } from './write.ts';

type WriteAction = (previous: WriteState, form: FormData) => Promise<WriteState>;

const idle: WriteState = { status: 'idle' };

/**
 * One edit form's submit state. A recorded change refreshes the page so the lists read Main's new
 * state; a refusal leaves the typed values in `values` for the form to show again. After a moved
 * head, `reload` reads the page again and then clears the refusal, so the next submit carries the
 * new head and the typed values are still there.
 */
const controls = 'input:not([type=hidden]), select, textarea, button';

/**
 * Where focus goes after a refusal: the first invalid control of the form that was submitted
 * (a `data-form` element named by the submitted intent, else the whole editor), or the refusal's
 * alert when no control is to blame.
 */
export function focusRefusal(root: HTMLElement, state: Extract<WriteState, { status: 'error' }>) {
  const form = state.values.intent === 'update' ? `update:${state.values.occurrence}` : state.values.intent ?? '';
  const scope = (form && [...root.querySelectorAll<HTMLElement>('[data-form]')].find(item => item.dataset.form === form)) || root;
  const field = state.field;
  const named = field ? scope.querySelector<HTMLElement>(`[data-field="${field}"], [name="${field}"]:not([type=hidden])`) : null;
  const target = named ? (named.matches(controls) ? named : named.querySelector<HTMLElement>(controls))
    : root.querySelector<HTMLElement>('[data-write-alert]');
  target?.focus();
}

export function useWrite(action: WriteAction): {
  state: WriteState; run: (form: FormData) => void; pending: boolean; values: Values; reloading: boolean; reload: () => void;
  formKey: string; root: RefObject<HTMLDivElement | null>;
} {
  const [state, run, pending] = useActionState(action, idle);
  const router = useRouter();
  const refreshed = useRef('');
  const [reloading, startReload] = useTransition();
  const [dismissed, setDismissed] = useState<WriteState | null>(null);
  const wasReloading = useRef(false);
  const root = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (state.status === 'error' && state !== dismissed && root.current) focusRefusal(root.current, state);
  }, [state, dismissed]);
  const values: Values = state.status === 'error' || state.status === 'pending' ? state.values : {};
  return { state: state === dismissed ? idle : state, run, pending, values, reloading,
    reload: () => startReload(() => { router.refresh(); }),
    /** Changes whenever the form should start empty again: after a recorded change. */
    formKey: state.status === 'done' ? state.nonce : 'open', root };
}
