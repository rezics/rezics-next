import { indexCatalog } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

const en = {
  title: 'Create a post',
  intro: 'Start a conversation in a community.',
  community: 'Community',
  communitySearch: 'Find a community',
  communityChange: 'Change community',
  work: 'Work',
  workSearch: 'Search for a Work',
  workChange: 'Change Work',
  titleLabel: 'Title',
  body: 'Your post',
  edit: 'Write',
  preview: 'Preview',
  showSpoiler: 'Show spoiler',
  bodyHelp: 'Write the details, questions or ideas you want to discuss.',
  spoiler: 'Mark as spoiler',
  spoilerHelp: 'The post will warn readers before showing its body.',
  rules: 'Community rules',
  noRules: 'This community has not published rules yet.',
  reviewRequired: 'This community reviews posts before publication. Direct posting is unavailable here.',
  joinRequired: 'Join this community before posting.',
  viewCommunity: 'View community',
  post: 'Post',
  posting: 'Posting…',
  draftSaved: 'Draft saved on this device',
  failed: 'Could not publish. Your draft is still here; try again.',
  refused: 'This community did not accept the post. Check its rules and settings.',
  unavailable: 'Could not load this community. Try again.',
  noCommunity: 'No matching communities',
  noWork: 'No matching Works',
  signIn: 'Sign in to post',
  agentNeeded: 'Choose a person profile before posting.',
  createWork: 'Create a Work',
};

export type PostMessages = typeof en;

export const englishMessages = en;

export const postText = indexCatalog(en, {
  'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko, de, fr, es,
});
