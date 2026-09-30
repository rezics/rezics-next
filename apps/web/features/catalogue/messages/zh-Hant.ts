import { asValue, insert, number, plural } from 'native-i18n';
import type { CatalogueMessages } from '../messages.ts';

export default {
  untitled: insert('作品 {{id}}', { id: String }),
  fallbackTitle: '標題以其他語言顯示',
  ratingCount: plural({ one: insert('{{count}} 則評分'), other: insert('{{count}} 則評分') },
    { count: asValue(number()) }),
  averageRating: insert('平均評分 {{mean}}（滿分 {{max}}），{{count}}', { mean: String, max: String, count: String }),
  ownRating: insert('你的評分：{{value}}（滿分 {{max}}）', { value: String, max: String }),
  yourRating: '你的評分',
  noRatings: '尚無評分',
  previous: '上一項', next: '下一項', seeAll: '查看全部',
  wantToRead: '想讀', reading: '正在讀', read: '已讀',
  removeFromShelf: '從我的書架移除',
  shelve: insert('將《{{title}}》加入書架', { title: String }),
  shelfOptions: '更多書架',
  signInToShelve: '登入以建立閱讀清單',
  rateThis: '為這部作品評分',
  signInToRate: '登入以為這部作品評分',
  saving: '儲存中…',
  saveFailed: '無法儲存，請再試一次。',
  ongoing: '連載中', hiatus: '暫停更新',
  whyItsHere: '入選原因', openRecipe: '打開食譜', install: '安裝', copyPrompt: '複製提示詞',
  promptCopied: '已複製提示詞', copyFailed: '無法複製，請再試一次。',
} satisfies Partial<CatalogueMessages>;
