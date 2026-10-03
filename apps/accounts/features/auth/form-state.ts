import type { FailureKind, Result } from '../api/errors.ts';
import type { AccountLocale } from '../api/account-data.ts';
import type { PolicyAcceptance } from '../api/client.ts';

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const passwordLength = { min: 12, max: 128 };

export type AuthStep = 'email' | 'password' | 'two-factor';
export type AuthFieldError =
  | 'emailRequired'
  | 'emailInvalid'
  | 'passwordRequired'
  | 'wrongPassword'
  | 'nameRequired'
  | 'passwordTooShort'
  | 'passwordTooLong'
  | 'passwordMismatch'
  | 'acceptRequired'
  | 'codeRequired'
  | 'backupCodeRequired'
  | 'codeWrong'
  | 'backupCodeWrong';

/** Only non-secret values may return in the HTML/Flight response. */
export interface AuthFormState {
  step?: AuthStep;
  email?: string;
  name?: string;
  accepted?: boolean;
  backup?: boolean;
  errors?: Partial<
    Record<'email' | 'name' | 'password' | 'confirm' | 'accept' | 'code', AuthFieldError>
  >;
  failure?: FailureKind | 'challenge-unavailable';
  outcome?: 'sent' | 'done';
}
export type AuthFormAction = (previous: AuthFormState, form: FormData) => Promise<AuthFormState>;
export const unchangedForm: AuthFormAction = async (previous) => previous;

export interface AuthFormContext {
  operations?: readonly string[];
  next?: string;
  signIn?: string;
  oauthQuery?: string;
  carry?: string;
  locale?: AccountLocale;
  policies?: PolicyAcceptance[];
  token?: string;
  /** Server-bound policy profile; never inferred from a submitted token. */
  localChallenge?: boolean;
}

export type AuthFormReply = AuthFormState | { redirect: string };
export type AuthFormCall = (
  path: string,
  body: Record<string, unknown>,
  captchaToken?: string,
) => Promise<Result<Record<string, unknown>>>;

export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
