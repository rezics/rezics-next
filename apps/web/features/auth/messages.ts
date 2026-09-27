import { defineMessages } from '../../i18n/define.ts';
import zhHans from './messages/zh-Hans.ts';

// Sign-in, acting identity and account menu strings. `{agent}` placeholders
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
  profileSettings: 'Profile settings',
  chooseHandle: 'Choose a handle',
};

export type AuthMessages = typeof en;

export const englishMessages = en;

export const messages = defineMessages({ en, 'zh-Hans': zhHans });

export function formatMessage(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
