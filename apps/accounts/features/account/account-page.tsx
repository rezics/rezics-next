import type { ReactNode } from 'react';
import { AccountShell, type AccountSection, sectionPaths } from './account-shell.tsx';
import type { StepUpMethods } from './step-up.tsx';
import type { SignInMethods } from '../api/account-data.ts';
import { readMethods, readSession, type AccountSession, type Read } from '../api/server.ts';
import { accountsConfig } from '../config/env.ts';
import { ReadStatePanel } from '../shell/state-panel.tsx';
import type { UiLocale } from '../../i18n/locale.ts';
import { getTranslation, requestLocale } from '../../i18n/server.ts';

const accountMessages = (locale: UiLocale) => getTranslation('account', [locale]);

export interface AccountPageContext {
  session: AccountSession;
  methods: Read<SignInMethods>;
  locale: UiLocale;
  t: Awaited<ReturnType<typeof accountMessages>>['t'];
  now: Date;
}

/** Every account section: the shell, then the section's content for a signed-in
 * visitor or the matching state (signed out, unavailable) for anyone else.
 * `path` is where a sign-in returns to, for focused pages inside a section. */
export async function renderAccountPage(section: AccountSection,
  render: (context: AccountPageContext) => Promise<ReactNode> | ReactNode, path = sectionPaths[section]):
  Promise<ReactNode> {
  const [session, methods, locale] = await Promise.all([readSession(), readMethods(), requestLocale()]);
  const webOrigin = accountsConfig().WEB_ORIGIN;
  if (session.status !== 'ok') {
    return <AccountShell section={section} webOrigin={webOrigin}>
      <ReadStatePanel status={session.status} next={path} headingLevel={1} /></AccountShell>;
  }
  const { t } = await accountMessages(locale);
  // How the person can confirm it's them before a sensitive change.
  const stepUp: StepUpMethods = methods.status === 'ok'
    ? { password: methods.data.password, passkey: methods.data.passkeys.length > 0,
      totp: methods.data.totp?.verified === true }
    : { password: true, passkey: false, totp: session.data.user.twoFactorEnabled };
  return <AccountShell section={section} user={session.data.user} webOrigin={webOrigin} stepUp={stepUp}>
    {await render({ session: session.data, methods, locale, t, now: new Date() })}</AccountShell>;
}
