import type { SignInPageViewer } from './signin-page.ts';

export type RecoveryPageStage = 'start' | 'complete' | 'step-up';
export type RecoveryPage = {
  stage: RecoveryPageStage;
  viewer: SignInPageViewer;
  methods: { email: true; password: true; passkey: true };
  requirements: { email_max_length: 254; password_min_length: number; password_max_length: number };
  continuation: 'sign-in' | 'authenticate-before-review';
  actions: { start: boolean; complete: boolean; authenticate: boolean };
};

export function isRecoveryPageStage(value: unknown): value is RecoveryPageStage {
  return value === 'start' || value === 'complete' || value === 'step-up';
}

/** Installed handlers, never credential inventory or recovery eligibility.
 * Anonymous reads do no account, email, token or credential I/O. Completion
 * remains the only observer of submitted recovery proof validity and expiry.
 */
export function recoveryPage(
  stage: RecoveryPageStage,
  password: { minPasswordLength: number; maxPasswordLength: number },
  viewer: SignInPageViewer = { kind: 'signed-out' },
): RecoveryPage {
  const page: RecoveryPage = {
    stage,
    viewer: stage === 'step-up' ? viewer : { kind: 'signed-out' },
    methods: { email: true, password: true, passkey: true },
    requirements: {
      email_max_length: 254,
      password_min_length: password.minPasswordLength,
      password_max_length: password.maxPasswordLength,
    },
    continuation: stage === 'step-up' ? 'authenticate-before-review' : 'sign-in',
    actions: { start: stage === 'start', complete: stage === 'complete', authenticate: stage === 'step-up' },
  };
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 4096)
    throw new Error('Recovery page unavailable');
  return page;
}

/** Bound the whole authorized observation, including native proof rereads.
 * Timeout never certifies a signed-out viewer or an empty method inventory.
 */
export async function observeRecoveryViewer<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Recovery page unavailable')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
