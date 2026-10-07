import { asValue, insert, number, plural } from 'native-i18n';
import type { CatalogueMessages } from '../messages.ts';

export default {
  untitled: insert('作品 {{id}}', { id: String }),
  fallbackTitle: '标题以其他语言显示',
  ratingCount: plural({ other: insert('{{count}} 个评分') }, { count: asValue(number()) }),
  averageRating: insert('平均评分 {{mean}}（满分 {{max}}），{{count}}', { mean: String, max: String, count: String }),
  ownRating: insert('你的评分：{{value}}（满分 {{max}}）', { value: String, max: String }),
  yourRating: '你的评分',
  noRatings: '暂无评分',
  previous: '上一项', next: '下一项', seeAll: '查看全部',
  wantToRead: '想读', reading: '在读', read: '读过',
  removeFromShelf: '从我的书架移除',
  shelve: insert('将《{{title}}》加入书架', { title: String }),
  shelfOptions: '更多书架',
  signInToShelve: '登录后可保存阅读清单',
  rateThis: '为这部作品评分',
  signInToRate: '登录后可评分',
  saving: '正在保存…',
  saveFailed: '未能保存，请重试。',
  ratingProcessing: '你的评分仍在处理中。',
  refresh: '刷新',
  ongoing: '连载中', hiatus: '暂停更新',
  whyItsHere: '为何入选',
  openRecipe: '查看菜谱', install: '安装', copyPrompt: '复制提示词',
  promptCopied: '已复制提示词', copyFailed: '未能复制，请重试。',
} satisfies Partial<CatalogueMessages>;
