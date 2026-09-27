import { defineMessages } from '../../i18n/define.ts';
import zhHans from './messages/zh-Hans.ts';


const en = {
  welcome: 'Welcome to REZICS',
  welcomeHelp: 'Choose a handle for your profile. Your public name appears alongside it.',
  displayName: 'Display name',
  displayNameHelp: 'This name came from your REZICS Account.',
  handle: 'Your handle',
  handleHelp: 'Use 3–30 letters, numbers or underscores. Handles are not case-sensitive.',
  checking: 'Checking availability…',
  available: 'This handle is available.',
  current: 'This is your current handle.',
  taken: 'This handle is already in use. Try another.',
  reserved: 'This handle cannot be used. Try another.',
  invalid: 'Use 3–30 letters, numbers or underscores.',
  checkFailed: 'Could not check this handle. Try again.',
  continue: 'Continue to home',
  pending: 'Your profile is being prepared',
  pendingHelp: 'This usually takes a moment. Your sign-in is saved.',
  retry: 'Try again',
  failed: 'We could not finish setting up your profile. Try again.',
  changeConflict: 'That handle changed or became unavailable. Check it again.',
  interestsLater: 'You can choose topics and communities to follow later.',
};

export const englishMessages = en;

export const messages = defineMessages({ en, 'zh-Hans': zhHans });

export type OnboardingMessages = typeof en;
