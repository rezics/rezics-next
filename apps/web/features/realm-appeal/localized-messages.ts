import { withEnglish, type UiLocale } from '../../i18n/define.ts';
import { messages, type RealmAppealMessages } from './messages.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

const overlays: Partial<Record<UiLocale, Partial<RealmAppealMessages>>> = {
  de, es, fr, ja, ko, 'zh-Hans': zhHans, 'zh-Hant': zhHant,
};
export const realmAppealMessages = (locale: UiLocale) => withEnglish(messages, overlays[locale]);
