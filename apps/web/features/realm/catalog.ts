import type { UiLocale } from '../../i18n/define.ts';
import { messages as english, type RealmMessages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import de from './messages/de.ts';
import fr from './messages/fr.ts';
import es from './messages/es.ts';

/** The Realm catalog a story renders in `locale`. */
const realmCatalogs = { en: {}, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja, ko, de, fr, es };
export const realmMessagesFor = (locale: UiLocale): RealmMessages => ({ ...english, ...realmCatalogs[locale] });

