export type RegistrationPasswordLimits = {
  minLength: number;
  maxLength: number;
};

export const REGISTRATION_EMAIL_MAX_LENGTH = 254;

export type RegistrationPageRequirements = {
  handle: { minLength: 3; maxLength: 64 };
  email: { maxLength: 254 };
  password: RegistrationPasswordLimits;
  verification: { provider: 'turnstile'; required: true };
};

export type NativeRegistrationPage =
  | {
      kind: 'registration';
      viewer: null;
      requirements: RegistrationPageRequirements;
      verification: { configured: true };
      actions: { register: true; continue: false };
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
      viewer: null;
      requirements: RegistrationPageRequirements;
      actions: { register: false; continue: false };
    }
  | {
      kind: 'unavailable';
      reason: 'dependency';
      actions: { register: false; continue: false };
    };

const noActions = { register: false, continue: false } as const;

function boundedRequirements(password: RegistrationPasswordLimits): RegistrationPageRequirements | null {
  if (
    !Number.isSafeInteger(password.minLength) ||
    !Number.isSafeInteger(password.maxLength) ||
    password.minLength < 1 ||
    password.maxLength < password.minLength
  )
    return null;
  return {
    handle: { minLength: 3, maxLength: 64 },
    email: { maxLength: REGISTRATION_EMAIL_MAX_LENGTH },
    password: { minLength: password.minLength, maxLength: password.maxLength },
    verification: { provider: 'turnstile', required: true },
  };
}

function unavailable(
  reason: 'verification' | 'dependency',
  requirements?: RegistrationPageRequirements,
): NativeRegistrationPage {
  return reason === 'verification' && requirements
    ? { kind: 'unavailable', reason, viewer: null, requirements, actions: noActions }
    : { kind: 'unavailable', reason: 'dependency', actions: noActions };
}

/** A bounded, no-store observation used to render registration advice only. */
export async function readRegistrationPage(input: {
  readSession(): Promise<Response>;
  passwordLimits(): Promise<RegistrationPasswordLimits>;
  verificationConfigured: boolean;
}): Promise<NativeRegistrationPage> {
  let requirements: RegistrationPageRequirements | null;
  try {
    requirements = boundedRequirements(await input.passwordLimits());
  } catch {
    return unavailable('dependency');
  }
  if (!requirements) return unavailable('dependency');

  let session: Response;
  try {
    session = await input.readSession();
  } catch {
    return unavailable('dependency');
  }

  let accountId: string | null = null;
  if (session.status === 200) {
    let body: unknown;
    try {
      body = await session.json();
    } catch {
      return unavailable('dependency');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('account_id' in body))
      return unavailable('dependency');
    if (typeof body.account_id !== 'string' || !body.account_id) return unavailable('dependency');
    accountId = body.account_id;
  } else if (session.status !== 401) {
    return unavailable('dependency');
  }

  if (accountId) {
    return {
      kind: 'already-signed-in',
      viewer: { account_id: accountId },
      requirements,
      verification: { configured: input.verificationConfigured },
      actions: { register: false, continue: true },
    };
  }
  if (!input.verificationConfigured) return unavailable('verification', requirements);
  return {
    kind: 'registration',
    viewer: null,
    requirements,
    verification: { configured: true },
    actions: { register: true, continue: false },
  };
}
