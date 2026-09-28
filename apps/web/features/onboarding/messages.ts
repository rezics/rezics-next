import { asValue, insert, number, plural } from 'native-i18n';
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
  languagesFull: 'Eight languages is the most you can keep.',
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
  noTopics: 'There are no topics to choose yet. You can pin topics from Home later.',
  typeBooks: 'Books & novels', typeGames: 'Games', typeSoftware: 'Software', typeMods: 'Mods',
  typeRecipes: 'Recipes', typePrompts: 'Prompts', typeSkills: 'AI skills', typeScreen: 'Film & TV',
  typeVideo: 'Video', typeMusic: 'Music', typeGuides: 'Guides',
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

export const messages = defineMessages({ en, 'zh-Hans': zhHans });

export type OnboardingMessages = typeof en;
