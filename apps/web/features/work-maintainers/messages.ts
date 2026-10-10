import { insert, materializeData } from 'native-i18n';
import { defineMessages, type UiLocale, withEnglish } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

const en = {
  heading: 'Maintainers',
  help: 'People who can edit this Work. Anyone listed can add a maintainer. Only the owner can remove one.',
  owner: 'Owner',
  addLabel: 'Add a maintainer',
  addHelp: 'Their handle, such as @lin_mei, or their address.',
  add: 'Add',
  remove: 'Remove',
  removeNamed: insert('Remove {{name}}', { name: String }),
  confirmTitle: insert('Remove {{name}}?', { name: String }),
  confirmBody: insert('{{name}} will no longer be able to edit this Work. What they have already written stays.', { name: String }),
  confirm: 'Remove',
  cancel: 'Cancel',
  saved: 'Maintainer list updated.',
  savedReplayed: 'This change was already recorded.',
  conflictTitle: 'This list changed since you opened it',
  conflictBody: 'Nothing further was written. Reload the latest list. What you typed stays here.',
  reload: 'Reload latest',
  continuityTitle: 'This Work keeps its last maintainer',
  continuityBody: 'Someone has to remain able to edit it.',
  deniedTitle: 'You can’t make this change',
  deniedBody: 'Only the owner can remove a maintainer. Any maintainer can add one.',
  signInTitle: 'Sign in again to change maintainers',
  invalidTitle: 'That wasn’t accepted',
  unavailableTitle: 'Couldn’t change the maintainers',
  unavailableBody: 'Nothing was changed. Try again in a moment.',
  loadFailed: 'Couldn’t load maintainers.',
  retry: 'Retry',
  loading: 'Loading maintainers',
  emptyQuery: 'Enter a handle or an address.',
  badTarget: 'Use a handle such as @lin_mei, or the identity’s address.',
  notFound: 'No identity uses that handle.',
  already: insert('{{name}} already maintains this Work.', { name: String }),
  self: 'You already maintain this Work.',
  mainSays: 'Reason',
};

export const englishMessages = en;
export type WorkMaintainerMessages = typeof en;

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

export const copyOf = (locale: UiLocale) => materializeData(messages[locale], { locale });
export type MaintainerCopy = ReturnType<typeof copyOf>;
