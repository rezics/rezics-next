import { safeReturnPath } from '../api/oauth-query.ts';
import { authorizationAfterCreate } from './auth-query.ts';
import { acceptanceAfterSignIn, acceptanceSignInPath, acceptanceContinuation } from './policies.ts';
import {
  emailPattern,
  passwordLength,
  formText,
  type AuthFormCall,
  type AuthFormContext,
  type AuthFormReply,
  type AuthFormState,
} from './form-state.ts';

const providerRedirect = (body: Record<string, unknown>) =>
  body.redirect === true && typeof body.url === 'string' ? body.url : undefined;

/** The HTML adapter calls the same Account operations as the enhanced forms.
 * Account still owns credentials, policies, country, challenge and OAuth checks. */
export async function submitAuthForm(
  context: AuthFormContext,
  previous: AuthFormState,
  form: FormData,
  call: AuthFormCall,
): Promise<AuthFormReply> {
  const requested = formText(form, 'operation');
  const operation =
    requested === 'consent' && formText(form, 'decision') === 'switch' ? 'switch' : requested;
  if (context.operations && !context.operations.includes(operation)) return { failure: 'failed' };
  const email = formText(form, 'email').trim();
  const password = formText(form, 'password');
  const oauth = context.oauthQuery ? { oauth_query: context.oauthQuery } : {};
  const next = safeReturnPath(context.next);
  const state: AuthFormState = {
    email,
    ...(operation === 'sign-up'
      ? { name: formText(form, 'name'), accepted: form.has('accept-policies') }
      : {}),
  };
  if (operation === 'email-reset') return { step: 'email', email: previous.email ?? '' };
  if (operation === 'two-factor' && form.has('method-switch'))
    return {
      email: previous.email,
      step: 'two-factor',
      backup: formText(form, 'method-switch') === 'backup-code',
    };
  if (['email', 'password', 'sign-up', 'recover'].includes(operation)) {
    if (!email || !emailPattern.test(email))
      return {
        ...state,
        step: 'email',
        errors: { email: !email ? 'emailRequired' : 'emailInvalid' },
      };
  }
  if (operation === 'email') return { email, step: 'password' };
  if (operation === 'password' && !password)
    return { email, step: 'password', errors: { password: 'passwordRequired' } };
  if (operation === 'sign-up' || operation === 'reset') {
    const errors: AuthFormState['errors'] = {};
    if (operation === 'sign-up' && !state.name?.trim()) errors.name = 'nameRequired';
    if (password.length < passwordLength.min) errors.password = 'passwordTooShort';
    if (password.length > passwordLength.max) errors.password = 'passwordTooLong';
    if (formText(form, 'confirm') !== password) errors.confirm = 'passwordMismatch';
    if (operation === 'sign-up' && !state.accepted) errors.accept = 'acceptRequired';
    if (Object.keys(errors).length) return { ...state, errors };
    if (operation === 'sign-up' && !context.policies?.length)
      return { ...state, failure: 'unavailable' };
  }
  const backup = formText(form, 'method') === 'backup-code';
  const code = formText(form, backup ? 'backup-code' : 'code').trim();
  if (operation === 'two-factor' && (backup ? !code : !/^\d{6}$/.test(code))) {
    return {
      email: previous.email,
      step: 'two-factor',
      backup,
      errors: { code: backup ? 'backupCodeRequired' : 'codeRequired' },
    };
  }
  const captcha = formText(form, 'cf-turnstile-response');
  if (['sign-up', 'recover'].includes(operation) && !captcha && !context.localChallenge) {
    return { ...state, failure: 'challenge-unavailable' };
  }
  const commands: Record<string, { path: string; body: Record<string, unknown> }> = {
    password: {
      path: '/api/auth/sign-in/email',
      body: { email, password, rememberMe: true, ...oauth },
    },
    'two-factor': {
      path: `/api/auth/two-factor/verify-${backup ? 'backup-code' : 'totp'}`,
      body: { code, trustDevice: form.has('trust-device'), ...oauth },
    },
    'sign-up': {
      path: '/api/auth/sign-up/email',
      body: {
        name: state.name?.trim(),
        email,
        password,
        locale: context.locale,
        minimumAgeConfirmed: state.accepted,
        acceptedPolicies: context.policies,
        callbackURL: `/verify-email${context.carry ? `?${context.carry}` : ''}`,
        ...oauth,
      },
    },
    recover: {
      path: '/api/auth/request-password-reset',
      body: { email, redirectTo: '/reset-password' },
    },
    reset: {
      path: '/api/auth/reset-password',
      body: { token: context.token, newPassword: password },
    },
    unsubscribe: {
      path: `/api/account/mail/unsubscribe?${new URLSearchParams({ token: context.token ?? '' })}`,
      body: { 'List-Unsubscribe': 'One-Click' },
    },
    accept: {
      path: '/api/account/policies/acceptance',
      body: { acceptedPolicies: context.policies },
    },
    decline: { path: '/api/auth/sign-out', body: {} },
    consent: {
      path: '/api/auth/oauth2/consent',
      body: { accept: formText(form, 'decision') === 'allow', ...oauth },
    },
    switch: { path: '/api/auth/sign-out', body: {} },
  };
  if (!Object.hasOwn(commands, operation)) return { failure: 'failed' };
  const command = commands[operation];
  if (!command) return { failure: 'failed' };
  const result = await call(command.path, command.body, captcha || undefined);
  if (!result.ok) {
    if (['decline', 'switch'].includes(operation) && result.kind === 'unauthenticated') {
      return {
        redirect:
          operation === 'switch'
            ? `/sign-in?${context.oauthQuery ?? ''}`
            : acceptanceSignInPath(context.signIn ?? null),
      };
    }
    if (
      result.kind === 'policy-acceptance-required' &&
      ['password', 'two-factor', 'consent'].includes(operation)
    ) {
      return { redirect: acceptanceAfterSignIn(context.oauthQuery, next, context.carry) };
    }
    if (operation === 'password')
      return {
        email,
        step: 'password',
        ...(result.kind === 'invalid-credentials'
          ? { errors: { password: 'wrongPassword' } }
          : { failure: result.kind }),
      };
    if (operation === 'two-factor')
      return {
        email: previous.email,
        step: result.kind === 'stale' ? 'password' : 'two-factor',
        backup,
        ...(['invalid-code', 'invalid-credentials'].includes(result.kind)
          ? { errors: { code: backup ? 'backupCodeWrong' : 'codeWrong' } }
          : { failure: result.kind }),
      };
    if (
      operation === 'sign-up' &&
      ['password-too-short', 'password-too-long'].includes(result.kind)
    ) {
      return {
        ...state,
        errors: {
          password: result.kind === 'password-too-short' ? 'passwordTooShort' : 'passwordTooLong',
        },
      };
    }
    return { ...state, failure: result.kind };
  }
  if (operation === 'recover') return { email, outcome: 'sent' };
  if (operation === 'reset' || operation === 'unsubscribe') return { outcome: 'done' };
  if (operation === 'decline') return { redirect: acceptanceSignInPath(context.signIn ?? null) };
  if (operation === 'switch') return { redirect: `/sign-in?${context.oauthQuery ?? ''}` };
  if (operation === 'accept')
    return {
      redirect: next.startsWith('/api/auth/oauth2/authorize?')
        ? acceptanceContinuation(next)
        : next,
    };
  if (operation === 'password' && result.data.twoFactorRedirect === true)
    return { email, step: 'two-factor' };
  const redirect = providerRedirect(result.data);
  if (operation === 'consent') return redirect ? { redirect } : { failure: 'failed' };
  if (operation === 'sign-up')
    return redirect || result.data.token
      ? { redirect: redirect ?? next }
      : { email, outcome: 'sent' };
  return {
    redirect:
      authorizationAfterCreate(context.oauthQuery) ??
      redirect ??
      (context.oauthQuery ? next : acceptanceAfterSignIn(undefined, next, context.carry)),
  };
}
