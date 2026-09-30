import { indexCatalog } from '../../i18n/define.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

// Interface text of the language select only. Language names come from `Intl`.
const en = {
  language: 'Language',
  notSpecified: 'Language not specified',
  search: 'Find a language',
  searchHint: 'A language’s name, or a code such as pt-BR',
  suggested: 'Suggested',
  noMatch: 'No language matches. Try its code, such as pt-BR.',
};

export type ContentLanguageMessages = typeof en;

export const englishMessages = en;

export const contentLanguageText = indexCatalog(en, {
  'zh-Hant': zhHant, 'zh-Hans': zhHans, ja, ko, de, fr, es,
});
