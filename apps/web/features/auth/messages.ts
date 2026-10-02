import { defineMessages, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Sign-in, acting identity and account menu strings. Pages read them by UI
// locale, so every locale is registered here, not only in the lazy catalogs. `{agent}` placeholders
// are filled with `formatMessage`, so the catalog is plain strings.

const en = {
  // Sign in and create account.
  signInHeading: 'Sign in to REZICS',
  createAccountHeading: 'Create your REZICS account',
  accountHelp: 'Use your account to work with versions and contributions.',
  nameLabel: 'Name', email: 'Email', password: 'Password',
  accountFailed: 'Account sign-in failed', connecting: 'Connecting…',
  createAccount: 'Create account', signIn: 'Sign in',
  newHere: 'New to REZICS?', alreadyHaveAccount: 'Already have an account?',
  createAccountLink: 'Create an account',
  consentDeclined: 'REZICS was not given access to your account. Sign in again to continue.',
  consentHeading: 'Sign-in was not completed', signInAgain: 'Try signing in again',
  // Callback failures: what actually failed, never a bare status line.
  signInFailedHeading: 'Sign-in failed',
  failedState: 'The sign-in took too long or was started in another browser, so it was not accepted.',
  failedIssuer: 'The reply did not come from your REZICS Account service, so it was not accepted.',
  failedCode: 'The sign-in code was already used or has expired.',
  failedExchange: 'REZICS could not reach your Account service to finish signing in.',
  failedConfig: 'Sign-in is not available on this site right now.',
  failedSession: 'The Account that signed in did not match the one REZICS received. Nothing was saved.',
  failedProvider: 'Your Account service reported an error while signing in.',
  failedUnknown: 'Sign-in could not be completed.',
  providerCode: 'Error code: {code}',
  // Choosing the session Agent.
  chooseAgentHeading: 'Choose who you act as',
  chooseAgentHelp: 'Your account can act as these Agents. The one you choose is shown as signed in across REZICS and proposed for what you do there. Each action is still checked when you take it.',
  agentsLegend: 'Agents you can act as',
  agentFallback: 'Agent {agent}',
  representedPath: 'Represented Agent', directPath: 'Your own Agent',
  personAgent: 'Person', penNameAgent: 'Pen name',
  organizationAgent: 'Organization', serviceAgent: 'Service',
  currentAgent: 'Current', defaultAgent: 'Default',
  saveDefault: 'Make this my default',
  saveDefaultHelp: 'New sign-ins start with it, and new Works propose it.',
  useAgent: 'Use this Agent',
  ineligibleAgent: 'You were acting as {agent}, which you can no longer use. Nothing was switched for you: choose an Agent to continue.',
  ineligibleDefault: 'Your saved default {agent} is no longer available. Choose a new default when you are ready.',
  noAgents: 'You do not have a profile to use yet.',
  setUpProfile: 'Set up your profile',
  agentsUnavailable: 'Your Agents cannot be listed right now. Try again in a moment.',
  invalidAgent: 'That Agent is not available to you. Choose one from the list.',
  staleDefault: 'Your default was changed somewhere else. Review the list and try again.',
  staleSession: 'Your session Agent changed in another tab. Review the current choice and try again.',
  defaultNotSaved: 'You now act as the chosen Agent, but your default could not be saved.',
  // Account menu.
  accountMenu: 'Account menu', actingAs: 'Acting as', switchAgent: 'Switch Agent',
  chooseAgent: 'Choose an Agent', agentNotEligible: 'Agent no longer available',
  noAgent: 'No Agent yet', agentUnverified: 'Agent not checked', signOut: 'Sign out',
  manageAccount: 'Manage your REZICS Account',
  profile: 'Profile',
  library: 'Library',
  studio: 'Studio',
  notifications: 'Notifications',
  language: 'Language',
  appearance: 'Appearance',
  contentPreferences: 'Content preferences',
  settings: 'Settings',
  back: 'Back',
  profileSettings: 'Profile settings',
  chooseHandle: 'Choose a handle',
};

export type AuthMessages = typeof en;

export const englishMessages = en;

export const messages = defineMessages({
  en,
  'zh-Hant': withEnglish(en, zhHant),
  'zh-Hans': withEnglish(en, zhHans),
  ja: withEnglish(en, ja),
  ko: withEnglish(en, ko),
  de: withEnglish(en, de),
  fr: withEnglish(en, fr),
  es: withEnglish(en, es),
});

export function formatMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
