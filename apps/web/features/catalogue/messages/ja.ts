import { asValue, insert, number, plural } from 'native-i18n';
import type { CatalogueMessages } from '../messages.ts';

export default {
  untitled: insert('作品 {{id}}', { id: String }),
  fallbackTitle: '別の言語のタイトルを表示しています',
  ratingCount: plural({ one: insert('{{count}} 件の評価'), other: insert('{{count}} 件の評価') },
    { count: asValue(number()) }),
  averageRating: insert('平均評価 {{mean}} / {{max}}、{{count}}', { mean: String, max: String, count: String }),
  ownRating: insert('あなたの評価：{{value}} / {{max}}', { value: String, max: String }),
  yourRating: 'あなたの評価',
  noRatings: 'まだ評価はありません',
  previous: '前へ', next: '次へ', seeAll: 'すべて見る',
  wantToRead: '読みたい', reading: '読書中', read: '読了',
  removeFromShelf: '本棚から削除',
  shelve: insert('『{{title}}』を本棚に追加', { title: String }),
  shelfOptions: 'ほかの本棚',
  signInToShelve: 'ログインして読書リストを保存',
  rateThis: 'この作品を評価',
  signInToRate: 'ログインしてこの作品を評価',
  saving: '保存中…',
  saveFailed: '保存できませんでした。もう一度お試しください。',
  ongoing: '連載中', hiatus: '休載中',
} satisfies Partial<CatalogueMessages>;
