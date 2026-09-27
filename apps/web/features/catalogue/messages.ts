import { asValue, insert, number, plural } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';

// Strings for the cover-first cards, shelves and reader actions that Discover,
// Search, the Work page and the home feed share. Components read them by UI
// locale, so each page does not have to load and pass them.
export const messages = defineMessages({
  en: {
    untitled: insert('Work {{id}}', { id: String }),
    fallbackTitle: 'Title shown in another language',
    ratingCount: plural({ one: insert('{{count}} rating'), other: insert('{{count}} ratings') },
      { count: asValue(number()) }),
    averageRating: insert('Average rating {{mean}} out of {{max}}, {{count}}', { mean: String, max: String, count: String }),
    ownRating: insert('Your rating: {{value}} out of {{max}}', { value: String, max: String }),
    yourRating: 'Your rating',
    noRatings: 'No ratings yet',
    previous: 'Previous', next: 'Next', seeAll: 'See all',
    wantToRead: 'Want to read', reading: 'Currently reading', read: 'Read',
    removeFromShelf: 'Remove from my shelves',
    shelve: insert('Shelve “{{title}}”', { title: String }),
    shelfOptions: 'More shelves',
    signInToShelve: 'Sign in to keep a reading list',
    rateThis: 'Rate this work',
    signInToRate: 'Sign in to rate this work',
    saving: 'Saving…',
    saveFailed: 'Couldn’t save. Try again.',
    ongoing: 'Ongoing', hiatus: 'On hiatus',
  },
  'zh-Hans': {
    untitled: insert('作品 {{id}}', { id: String }),
    fallbackTitle: '标题以其他语言显示',
    ratingCount: plural({ other: insert('{{count}} 个评分') }, { count: asValue(number()) }),
    averageRating: insert('平均评分 {{mean}}（满分 {{max}}），{{count}}', { mean: String, max: String, count: String }),
    ownRating: insert('你的评分：{{value}}（满分 {{max}}）', { value: String, max: String }),
    yourRating: '你的评分',
    noRatings: '暂无评分',
    previous: '上一组', next: '下一组', seeAll: '查看全部',
    wantToRead: '想读', reading: '在读', read: '读过',
    removeFromShelf: '从我的书架移除',
    shelve: insert('将《{{title}}》加入书架', { title: String }),
    shelfOptions: '更多书架',
    signInToShelve: '登录后可保存阅读清单',
    rateThis: '为这部作品评分',
    signInToRate: '登录后可评分',
    saving: '正在保存…',
    saveFailed: '未能保存，请重试。',
    ongoing: '连载中', hiatus: '暂停更新',
  },
});

export type CatalogueMessages = (typeof messages)['en'];
