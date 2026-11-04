import { useEffect, useState } from 'react';
import { privateAuthRead } from './private-auth-read';
import { parseSignInPage, type SignInPageViewer } from './signin-page';

export type RecoveryPageStage = 'start' | 'complete' | 'step-up';
export type RecoveryPage = {
  stage: RecoveryPageStage;
  viewer: SignInPageViewer;
  methods: { email: boolean; password: boolean; passkey: boolean };
  requirements: { email_max_length: number; password_min_length: number; password_max_length: number };
  continuation: 'sign-in' | 'authenticate-before-review';
  actions: { start: boolean; complete: boolean; authenticate: boolean };
};
export type RecoveryPageResult = { kind: 'ready'; page: RecoveryPage } | { kind: 'unavailable' };
const maxResponseBytes = 4096;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>) => Object.keys(value).sort().join(',');

export function parseRecoveryPage(value: unknown, stage: RecoveryPageStage): RecoveryPage | null {
  if (
    !record(value) ||
    keys(value) !== 'actions,continuation,methods,requirements,stage,viewer' ||
    value.stage !== stage
  )
    return null;
  const { methods, actions, requirements } = value;
  if (
    !record(methods) ||
    keys(methods) !== 'email,passkey,password' ||
    !Object.values(methods).every((flag) => typeof flag === 'boolean') ||
    !record(actions) ||
    keys(actions) !== 'authenticate,complete,start' ||
    actions.start !== (stage === 'start') ||
    actions.complete !== (stage === 'complete') ||
    actions.authenticate !== (stage === 'step-up') ||
    value.continuation !== (stage === 'step-up' ? 'authenticate-before-review' : 'sign-in') ||
    !record(requirements) ||
    keys(requirements) !== 'email_max_length,password_max_length,password_min_length' ||
    !Object.values(requirements).every(
      (limit) => Number.isSafeInteger(limit) && Number(limit) > 0 && Number(limit) <= 1024,
    ) ||
    Number(requirements.password_min_length) > Number(requirements.password_max_length)
  )
    return null;
  // Reuse the existing private viewer parser without accepting a return URL from
  // this read. Browser-retained operations are checked separately at return.
  const parsed = parseSignInPage(
    {
      methods: { password: methods.password, passkey: methods.passkey },
      viewer: value.viewer,
      continuation: { href: '/security', requires_sign_in: true },
    },
    'https://auth.invalid',
  );
  if (!parsed || (stage !== 'step-up' && parsed.viewer.kind !== 'signed-out')) return null;
  return {
    stage,
    viewer: parsed.viewer,
    methods: { email: methods.email as boolean, ...parsed.methods },
    requirements: {
      email_max_length: Number(requirements.email_max_length),
      password_min_length: Number(requirements.password_min_length),
      password_max_length: Number(requirements.password_max_length),
    },
    continuation: stage === 'step-up' ? 'authenticate-before-review' : 'sign-in',
    actions: { start: stage === 'start', complete: stage === 'complete', authenticate: stage === 'step-up' },
  };
}

export async function loadRecoveryPage(stage: RecoveryPageStage, caller?: AbortSignal): Promise<RecoveryPageResult> {
  try {
    const page = await privateAuthRead(async (signal) => {
      const response = await fetch('/recovery/page', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ stage }),
        signal,
      });
      if (response.status !== 200 || Number(response.headers.get('content-length')) > maxResponseBytes) return null;
      const reader = response.body?.getReader();
      if (!reader) return null;
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxResponseBytes) return null;
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return parseRecoveryPage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), stage);
    }, caller);
    return page ? { kind: 'ready', page } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Focus/visibility refresh removes old account advice before starting another
 * read. Departure or replacement cannot publish an old viewer or method list.
 */
export function useRecoveryPage(stage: RecoveryPageStage | null) {
  const [generation, setGeneration] = useState(0);
  const [bound, setBound] = useState<{
    stage: RecoveryPageStage;
    generation: number;
    result: RecoveryPageResult;
  } | null>(null);
  const retry = () => setGeneration((value) => value + 1);
  useEffect(() => {
    const focus = () => setGeneration((value) => value + 1);
    const visible = () => {
      if (document.visibilityState === 'visible') focus();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  useEffect(() => {
    setBound(null);
    if (!stage) return;
    const controller = new AbortController();
    void loadRecoveryPage(stage, controller.signal).then((result) => {
      if (!controller.signal.aborted) setBound({ stage, generation, result });
    });
    return () => controller.abort();
  }, [stage, generation]);
  return {
    state: bound?.stage === stage && bound.generation === generation ? bound.result : { kind: 'loading' as const },
    retry,
  };
}
