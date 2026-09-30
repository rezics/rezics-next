import { indexCatalog } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

const en = {
  title: 'Communities',
  intro: 'Find people reading and discussing what you love.',
  search: 'Search communities',
  searchAction: 'Search',
  topics: 'Topics',
  topicSearch: 'Find a topic',
  topicApply: 'Apply topic',
  topicRemove: 'Remove topic',
  topicUnavailable: 'Topics could not load. Try another search.',
  topicNone: 'No matching topics',
  sort: 'Sort communities',
  active: 'Active',
  popular: 'Popular',
  growing: 'Growing this week',
  new: 'New',
  create: 'Create a community',
  empty: 'No communities found',
  emptyBody: 'Try another search, or start a community.',
  unavailable: 'Communities could not load',
  unavailableBody: 'Try again in a moment.',
  members: 'members',
  review: 'Posts are reviewed',
  next: 'Next page',
  first: 'First page',
  createTitle: 'Create a community',
  createIntro: 'Give your community a home. You can change its details in Manage later.',
  name: 'Community name',
  nameLanguage: 'Name language',
  languageHelp: 'The language the name, description and rules are written in. Add translations of the name below.',
  translation: 'Translation',
  translationLanguage: 'Translation language',
  translationName: 'Translated name',
  translationDescription: 'Translated description (optional)',
  addTranslation: 'Add a translation',
  removeTranslation: 'Remove translation',
  translationError: 'Use different, valid language tags and enter each translated name.',
  handle: 'Community handle',
  handleHelp: '3–30 lowercase letters, numbers or hyphens. The handle cannot be changed.',
  description: 'Description',
  visibility: 'Who can take part?',
  public: 'Public',
  publicHelp: 'Anyone can read, join and post.',
  restricted: 'Restricted',
  restrictedHelp: 'Anyone can read. You decide who can join and post.',
  rules: 'Community rules',
  ruleTitle: 'Rule title',
  ruleBody: 'What does this rule mean?',
  addRule: 'Add a rule',
  removeRule: 'Remove rule',
  icon: 'Community icon',
  banner: 'Banner image',
  imageHelp: 'Optional JPEG, PNG or WebP, up to 4 MB.',
  imageDrop: 'Drop an image here',
  imageChoose: 'or choose one from your device',
  iconCrop: 'A square image works best; the center appears as a circle.',
  bannerCrop: 'A wide image works best; edges may be cropped on phones.',
  submitCreate: 'Create community',
  creating: 'Creating your community…',
  createFailed: 'Could not create this community. Check the details and try again.',
  handleTaken: 'This handle is already taken. Choose another.',
  configureFailed: 'The community was created, but its details could not be saved. Try again or finish in Manage.',
  setupTitle: 'Set up your community',
  setupHelp: 'A few steps help people feel at home. Skip anything you want to do later.',
  firstPost: 'Write the first post',
  invite: 'Share an invite link',
  copyInvite: 'Copy link',
  setupGo: 'Open',
  setupSkip: 'Skip',
  manage: 'Open Manage',
  signIn: 'Sign in to create a community',
  agentNeeded: 'Choose a person profile before creating a community.',
};

export type CommunityMessages = typeof en;

export const englishMessages = en;

export const communityText = indexCatalog(en, {
  'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko, de, fr, es,
});
