import { materializeData } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface copy for writing a Zone's home page. The page the author writes is theirs, never this catalog.
const en = {
  sectionsLabel: 'Site sections',
  sectionHome: 'Home',
  homeTitle: 'Home page',
  homeHelp: 'Write the page readers see first. A draft stays private until you publish it.',
  editorLabel: 'Home page',
  statusPrivate: 'Only you can see this draft.',
  statusLive: 'Readers see this page.',
  statusBehind: 'Readers still see the published page.',
  save: 'Save draft',
  saving: 'Saving…',
  saved: 'Draft saved.',
  savedReplayed: 'Draft saved. The earlier save had already gone through.',
  preview: 'Preview',
  previewTitle: 'Draft preview',
  previewHelp: 'This is the saved draft, as readers will see it. Only people who can edit this Zone can open this preview.',
  previewEmptyTitle: 'No draft yet',
  previewEmptyBody: 'Save the home page, then come back to read it here.',
  backToEditor: 'Back to the editor',
  viewSite: 'View site',
  publish: 'Publish',
  publishing: 'Publishing…',
  published: 'Published. Readers see this page.',
  publishedReplayed: 'Published. The earlier publish had already gone through.',
  saveFirst: 'Save the draft before publishing. Readers get the saved page, not unsaved edits.',
  staleTitle: 'This page was saved somewhere else',
  staleBody: 'Your text is still here. You can save it over the other version, or load that version instead.',
  saveOver: 'Save my text',
  loadTheirs: 'Load the saved page',
  loaded: 'Loaded the saved page. Your unsaved text was replaced.',
  publishStaleTitle: 'The site changed before this publish',
  publishStaleBody: 'Your draft is still here. Refresh the site and publish again. Readers keep the page they already have.',
  refreshAndPublish: 'Refresh and publish',
  deniedTitle: 'You can’t edit this Zone',
  deniedBody: 'This Zone isn’t available for you to change.',
  unavailableTitle: 'The page couldn’t be reached',
  unavailableBody: 'REZICS didn’t answer. Try again. A publish that already went through won’t be repeated.',
  missingTitle: 'This Zone isn’t available',
  missingBody: 'It may have been removed, or it may not be open to you.',
  invalidTitle: 'That change wasn’t accepted',
  invalidBody: 'Check the page and try again.',
  conflictTitle: 'That save conflicted with another',
  conflictBody: 'Your text is still here. Try again.',
  signInTitle: 'Sign in to keep editing',
  signInBody: 'Your session ended. Sign in again, then save. Your text is still in this tab.',
  tryAgain: 'Try again',
  protectedTitle: 'This draft can’t be edited here',
  protectedBody: 'The saved page uses content this editor doesn’t change. It is shown as it will read, and it won’t be overwritten.',
  sectionNavigation: 'Navigation',
  navTitle: 'Navigation',
  navHelp: 'Choose the pages readers can open from this Zone, and the order they appear. Each link uses that page’s name.',
  linksLabel: 'Links',
  emptyLinks: 'No links yet. Home stays first. Add a page to give readers another way in.',
  addPage: 'Page',
  addPagePlaceholder: 'Find a page',
  addLink: 'Add link',
  pathLabel: 'Path',
  moveUp: 'Move up',
  moveDown: 'Move down',
  removeLink: 'Remove',
  noPageMatches: 'No page with that name.',
  navSaveFirst: 'Save the draft before publishing. Readers get the saved links, not unsaved edits.',
  navSaved: 'Draft saved.',
  navSavedHint: 'Publish the site for readers to see these links.',
  navStatus: 'Readers see these links when the site is published.',
  navStaleTitle: 'These links were saved somewhere else',
  navStaleBody: 'Your links are still here. You can save them over the other version, or load that version instead.',
  saveLinks: 'Save my links',
  loadLinks: 'Load the saved navigation',
  navLoaded: 'Loaded the saved links. Your unsaved changes were replaced.',
  privateLink: 'Private',
  pathInvalid: 'Use a short path of lowercase letters, numbers and hyphens.',
  duplicatePath: 'That path is already a link.',
};

export const englishMessages = en;
export type ZoneEditorMessages = typeof en;

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

/** The interface strings of one locale, ready to read (`copy.homeTitle`). */
export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type ZoneEditorCopy = ReturnType<typeof copyOf>;
