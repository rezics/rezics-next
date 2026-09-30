import { asValue, insert, number, plural } from 'native-i18n';
import { defineMessages, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';


const en = {
  welcome: 'Welcome to REZICS',
  welcomeHelp: 'Choose the public name and handle for your profile. Nothing is public until you continue.',
  displayName: 'Public name',
  displayNameHelp: 'Shown on your profile and contributions.',
  invalidName: 'Enter a public name of up to 200 characters.',
  handle: 'Your handle',
  handleHelp: 'Use 3–30 letters, numbers or underscores. Handles are not case-sensitive.',
  checking: 'Checking availability…',
  available: 'This handle is available.',
  current: 'This is your current handle.',
  taken: 'This handle is already in use. Try another.',
  held: 'Kept for its previous owner. If it was yours, you can take it back.',
  reserved: 'This handle cannot be used. Try another.',
  invalid: 'Use 3–30 letters, numbers or underscores.',
  checkFailed: 'Could not check this handle. Try again.',
  continue: 'Continue',
  pending: 'Your profile is being prepared',
  pendingHelp: 'This usually takes a moment. Your sign-in is saved.',
  retry: 'Try again',
  failed: 'We could not finish setting up your profile. Try again.',
  changeConflict: 'That handle changed or became unavailable. Check it again.',
  topicsLater: 'Next, choose the languages you read and a few topics for your Home.',

  // The first-minute setup (/welcome): languages, topics that become Home tabs, communities
  setupTitle: 'Set up your Home', skipSetup: 'Skip setup',
  step: insert('Step {{step}} of {{total}}', { step: String, total: String }),
  languagesTitle: 'Which languages do you read?',
  languagesBody: 'Posts in these languages fill your Home. You can change this any time in Settings.',
  yourLanguages: 'Your languages, first choice first',
  languagesOrder: 'Titles and names show in the first of these a work has.',
  allLanguages: 'None chosen: Home shows every language.',
  languagesFull: 'Twenty languages is the most you can keep.',
  suggestedLanguages: 'Suggested', addLanguage: 'Add another language',
  addLanguageHint: 'A language’s name, or a code such as pt-BR',
  addLanguageNamed: insert('Add {{language}}', { language: String }),
  moveEarlier: insert('Move {{language}} up', { language: String }),
  removeLanguage: insert('Remove {{language}}', { language: String }),
  noLanguageMatch: 'No language matches. Try its code, such as pt-BR.',
  topicsTitle: 'Pick a few topics',
  topicsBody: 'Each topic you pick becomes a tab on your Home, and brings its posts to Following.',
  topicsChosen: plural({ one: insert('{{count}} of 8 chosen'), other: insert('{{count}} of 8 chosen') },
    { count: asValue(number()) }),
  topicsFull: 'Eight topics fill your Home’s tabs. Unpick one to choose another.',
  inTopic: insert('in {{topic}}', { topic: String }),
  typeOther: 'Other topics',
  noTopics: 'There are no topics to choose yet. You can pin topics from Home later.',
  communitiesTitle: 'Follow a few communities',
  communitiesBody: 'Picked for what you chose. Untick any you don’t want.',
  findingCommunities: 'Finding communities…',
  noSuggestions: 'No communities to suggest yet. You’ll find more in Discover.',
  reasonTopic: insert('For {{topic}}', { topic: String }),
  reasonLanguage: insert('Popular in {{language}}', { language: String }),
  reasonPopular: 'Popular on REZICS',
  members: plural({ one: insert('{{count}} member'), other: insert('{{count}} members') }, { count: asValue(number()) }),
  membersAbout: plural({ one: insert('About {{count}} member'), other: insert('About {{count}} members') },
    { count: asValue(number()) }),
  back: 'Back', next: 'Next', skip: 'Skip', finish: 'Finish',
  followAndFinish: plural({ one: insert('Follow {{count}} and finish'), other: insert('Follow {{count}} and finish') },
    { count: asValue(number()) }),
  saveFailed: 'Couldn’t save your choices. Try again.',
};

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

export type OnboardingMessages = typeof en;
