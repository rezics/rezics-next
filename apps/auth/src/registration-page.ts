import { createServerFn } from '@tanstack/react-start';
import { privateAuthRead } from './private-auth-read';
import { issuerSecurityRequest } from './security-inventory';
import { readTurnstileConfig } from './turnstile.ts';

export type RegistrationPageRequirements = {
  handle: { minLength: number; maxLength: number };
  email: { maxLength: number };
  password: { minLength: number; maxLength: number };
  verification: { provider: 'turnstile'; required: true };
};

export type RegistrationPage =
  | {
      kind: 'registration';
      viewer: null;
      requirements: RegistrationPageRequirements;
      verification: { configured: true };
      actions: { register: true; continue: false };
      siteKey: string;
      scriptUrl: string;
    }
  | {
      kind: 'already-signed-in';
      viewer: { account_id: string };
      requirements: RegistrationPageRequirements;
      verification: { configured: boolean };
      actions: { register: false; continue: true };
    }
  | {
      kind: 'unavailable';
      reason: 'verification';
      actions: { register: false; continue: false };
      viewer?: null;
      requirements?: RegistrationPageRequirements;
    }
  | { kind: 'unavailable'; reason: 'dependency'; actions: { register: false; continue: false } };

const noActions = { register: false, continue: false } as const;

function unavailable(reason: 'dependency' | 'verification'): RegistrationPage {
  return { kind: 'unavailable', reason, actions: noActions };
}

function verificationUnavailable(requirements?: RegistrationPageRequirements): RegistrationPage {
  return requirements
    ? { kind: 'unavailable', reason: 'verification', viewer: null, requirements, actions: noActions }
    : unavailable('verification');
}

type TurnstilePageConfig = { siteKey: string; scriptUrl: string };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function requirements(value: unknown): RegistrationPageRequirements | null {
  if (!record(value) || !record(value.handle) || !record(value.email) || !record(value.password)) return null;
  if (
    !positiveInteger(value.handle.minLength) ||
    !positiveInteger(value.handle.maxLength) ||
    value.handle.minLength > value.handle.maxLength ||
    !positiveInteger(value.email.maxLength) ||
    !positiveInteger(value.password.minLength) ||
    !positiveInteger(value.password.maxLength) ||
    value.password.minLength > value.password.maxLength ||
    !record(value.verification) ||
    value.verification.provider !== 'turnstile' ||
    value.verification.required !== true
  )
    return null;
  return {
    handle: { minLength: value.handle.minLength, maxLength: value.handle.maxLength },
    email: { maxLength: value.email.maxLength },
    password: { minLength: value.password.minLength, maxLength: value.password.maxLength },
    verification: { provider: 'turnstile', required: true },
  };
}

/** Treat a failed page read as unavailable; only the native writer accepts a registration. */
export function parseRegistrationPage(body: unknown, turnstile: TurnstilePageConfig): RegistrationPage {
  if (!record(body)) return unavailable('dependency');
  if (body.kind === 'unavailable') {
    if (body.reason !== 'verification') return unavailable('dependency');
    const pageRequirements = requirements(body.requirements);
    if (
      body.viewer !== null ||
      !record(body.actions) ||
      body.actions.register !== false ||
      body.actions.continue !== false ||
      !pageRequirements
    )
      return unavailable('dependency');
    return verificationUnavailable(pageRequirements);
  }
  const pageRequirements = requirements(body.requirements);
  if (!pageRequirements || !record(body.verification) || typeof body.verification.configured !== 'boolean')
    return unavailable('dependency');
  if (body.kind === 'already-signed-in') {
    if (
      !record(body.viewer) ||
      typeof body.viewer.account_id !== 'string' ||
      !body.viewer.account_id ||
      !record(body.actions) ||
      body.actions.register !== false ||
      body.actions.continue !== true
    )
      return unavailable('dependency');
    return {
      kind: 'already-signed-in',
      viewer: { account_id: body.viewer.account_id },
      requirements: pageRequirements,
      verification: { configured: body.verification.configured },
      actions: { register: false, continue: true },
    };
  }
  if (
    body.kind !== 'registration' ||
    body.viewer !== null ||
    !record(body.actions) ||
    body.actions.register !== true ||
    body.actions.continue !== false ||
    body.verification.configured !== true
  )
    return unavailable('dependency');
  if (!turnstile.siteKey) return verificationUnavailable(pageRequirements);
  return {
    kind: 'registration',
    viewer: null,
    requirements: pageRequirements,
    verification: { configured: true },
    actions: { register: true, continue: false },
    siteKey: turnstile.siteKey,
    scriptUrl: turnstile.scriptUrl,
  };
}

const registrationPageRead = createServerFn({ method: 'GET' }).handler(async (): Promise<RegistrationPage> => {
  let turnstile: TurnstilePageConfig = { siteKey: '', scriptUrl: '' };
  try {
    turnstile = await readTurnstileConfig();
  } catch {
    // Keep reading native viewer state; without a site key, signed-out registration stays unavailable.
  }
  try {
    const response = await issuerSecurityRequest('/registration-page');
    if (response.status !== 200) return unavailable('dependency');
    return parseRegistrationPage(await response.json(), turnstile);
  } catch {
    return unavailable('dependency');
  }
});

export async function readRegistrationPage(signal?: AbortSignal): Promise<RegistrationPage> {
  try {
    return await privateAuthRead((readSignal) => registrationPageRead({ signal: readSignal }), signal);
  } catch {
    return unavailable('dependency');
  }
}
