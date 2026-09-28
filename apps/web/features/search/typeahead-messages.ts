import { asValue, insert, number, plural } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';

// The title typeahead sits in the site header as well as on /search, so it
// carries its few strings in every locale rather than asking each host page
// to load and pass the search catalog.

const en = {
  suggestions: 'Suggested works',
  byAuthor: insert('by {{name}}', { name: String }),
  alsoTitled: insert('Also titled {{title}}', { title: String }),
  found: plural({ one: insert('{{count}} suggestion. Use the arrow keys to choose it.'),
    other: insert('{{count}} suggestions. Use the arrow keys to choose one.') }, { count: asValue(number()) }),
};

export type TypeaheadMessages = typeof en;

export const typeaheadMessages = defineMessages({
  en,
  'zh-Hans': {
    suggestions: '推荐作品', byAuthor: insert('{{name}} 著', { name: String }),
    alsoTitled: insert('又名 {{title}}', { title: String }),
    found: plural({ one: insert('{{count}} 条建议，可用方向键选择。'), other: insert('{{count}} 条建议，可用方向键选择。') }, { count: asValue(number()) }),
  },
  'zh-Hant': {
    suggestions: '推薦作品', byAuthor: insert('{{name}} 著', { name: String }),
    alsoTitled: insert('又名 {{title}}', { title: String }),
    found: plural({ one: insert('{{count}} 則建議，可用方向鍵選擇。'), other: insert('{{count}} 則建議，可用方向鍵選擇。') }, { count: asValue(number()) }),
  },
  ja: {
    suggestions: 'おすすめの作品', byAuthor: insert('{{name}} 著', { name: String }),
    alsoTitled: insert('別題：{{title}}', { title: String }),
    found: plural({ one: insert('候補が {{count}} 件あります。矢印キーで選べます。'), other: insert('候補が {{count}} 件あります。矢印キーで選べます。') }, { count: asValue(number()) }),
  },
  ko: {
    suggestions: '추천 작품', byAuthor: insert('{{name}} 지음', { name: String }),
    alsoTitled: insert('다른 제목: {{title}}', { title: String }),
    found: plural({ one: insert('추천 {{count}}개. 화살표 키로 고를 수 있습니다.'), other: insert('추천 {{count}}개. 화살표 키로 고를 수 있습니다.') }, { count: asValue(number()) }),
  },
  de: {
    suggestions: 'Vorgeschlagene Werke', byAuthor: insert('von {{name}}', { name: String }),
    alsoTitled: insert('Auch: {{title}}', { title: String }),
    found: plural({ one: insert('{{count}} Vorschlag. Mit den Pfeiltasten auswählen.'),
      other: insert('{{count}} Vorschläge. Mit den Pfeiltasten auswählen.') }, { count: asValue(number()) }),
  },
  fr: {
    suggestions: 'Œuvres suggérées', byAuthor: insert('de {{name}}', { name: String }),
    alsoTitled: insert('Aussi intitulé {{title}}', { title: String }),
    found: plural({ one: insert('{{count}} suggestion. Choisissez-la avec les flèches.'),
      other: insert('{{count}} suggestions. Choisissez avec les flèches.') }, { count: asValue(number()) }),
  },
  es: {
    suggestions: 'Obras sugeridas', byAuthor: insert('de {{name}}', { name: String }),
    alsoTitled: insert('También titulado {{title}}', { title: String }),
    found: plural({ one: insert('{{count}} sugerencia. Elígela con las flechas.'),
      other: insert('{{count}} sugerencias. Elige con las flechas.') }, { count: asValue(number()) }),
  },
});
