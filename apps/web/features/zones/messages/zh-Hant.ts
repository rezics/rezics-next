import { asValue, insert, number, plural } from 'native-i18n';
import type { ZoneMessages } from '../messages.ts';

export default {
  more: '查看更多', shuffle: '換一批',
  whyHere: insert('《{{title}}》為何在此', { title: String }),
  untitled: '未命名作品',
  rank: insert('第 {{rank}} 名', { rank: String }),
  day: '今日', week: '本週', month: '本月', completed: '已完結',
  newChapter: insert('最新章節：{{chapter}}', { chapter: String }),
  heroLabel: '精選', previous: '上一個', next: '下一個',
  slide: insert('第 {{index}} 張，共 {{count}} 張', { index: String, count: String }),
  read: '開始閱讀', readWork: '查看作品',
  dismiss: '關閉', announcement: '公告',
  adopted: insert('收錄《{{title}}》', { title: String }), adoptedUnknown: '收錄了一部作品',
  classified: insert('將《{{title}}》分類', { title: String }), classifiedUnknown: '將一部作品分類',
  classificationRejected: insert('否決了《{{title}}》的分類', { title: String }),
  classificationRejectedUnknown: '否決了一項分類',
  ruleChanged: '社群規範有變更',
  quoteBy: insert('{{reader}} 的話', { reader: String }),
  replies: plural({ one: insert('{{count}} 則回覆'), other: insert('{{count}} 則回覆') },
    { count: asValue(number()) }),
  failed: insert('無法載入{{module}}', { module: String }), retry: '再試一次',
  lookLabel: '頁面樣式', lookZone: '社群設計', lookStandard: '標準樣式',
  lookHelp: '標準樣式適用於所有社群。',
  lookSaveFailed: '無法儲存頁面樣式，請再試一次。',
  safeModeTitle: '目前顯示此社群的標準版面',
  safeModeBody: '此頁已關閉社群自訂設計，因此所有內容都以平台內建元件呈現。',
  showDesign: '顯示完整設計',
  // The default layout's module titles.
  picks: '精選', genres: '類型', latest: '最新作品', newChapters: '新章節',
  newlyAdded: '新收錄', recentlyCompleted: '近期完結', rankings: '排行榜',
  quotes: '讀者摘錄', rising: '新作與人氣上升', decisions: '近期決策',
} satisfies Partial<ZoneMessages>;
