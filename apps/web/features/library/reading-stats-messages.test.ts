import { expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { messages } from './messages.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

test.each([
  ['en', messages, '1 book finished', '2 books finished', '1 chapter completed', '2 chapters completed'],
  ['de', de, 'Beendetes Buch: 1', 'Beendete Bücher: 2', 'Abgeschlossenes Kapitel: 1', 'Abgeschlossene Kapitel: 2'],
  ['es', es, 'Libro terminado: 1', 'Libros terminados: 2', 'Capítulo completado: 1', 'Capítulos completados: 2'],
  ['fr', fr, 'Livre terminé : 1', 'Livres terminés : 2', 'Chapitre terminé : 1', 'Chapitres terminés : 2'],
  ['ja', ja, '1冊読了', '2冊読了', '1章読了', '2章読了'],
  ['ko', ko, '책 1권 완독', '책 2권 완독', '챕터 1개 완료', '챕터 2개 완료'],
  ['zh-Hans', zhHans, '读完 1 本', '读完 2 本', '读完 1 章', '读完 2 章'],
  ['zh-Hant', zhHant, '已讀完 1 本書', '已讀完 2 本書', '已讀完 1 個章節', '已讀完 2 個章節'],
] as const)('%s reading totals use the locale’s singular and plural forms',
  (locale, copy, oneBook, twoBooks, oneChapter, twoChapters) => {
    const t = materializeData({ ...messages, ...copy }, { locale });
    expect(t.booksFinished(1)).toBe(oneBook);
    expect(t.booksFinished(2)).toBe(twoBooks);
    expect(t.chaptersFinished(1)).toBe(oneChapter);
    expect(t.chaptersFinished(2)).toBe(twoChapters);
  });

test('zero and large totals retain locale plural selection and number formatting', () => {
  const en = materializeData(messages, { locale: 'en' });
  const french = materializeData({ ...messages, ...fr }, { locale: 'fr' });
  expect(en.chaptersFinished(0)).toBe('0 chapters completed');
  expect(french.chaptersFinished(0)).toBe('Chapitre terminé : 0');
  expect(en.booksFinished(1000)).toBe('1,000 books finished');
});
