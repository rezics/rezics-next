// The Books Zone's own words. Packages bring their strings; the platform
// passes the interface locale in `zone.locale`, and any other locale reads English.

const en = {
  official: 'Official REZICS Zone',
  tagline: 'Public-domain classics and the editions worth reading, chosen in public by the Books editors.',
  coverStory: 'Cover story',
  inThisIssue: 'In this issue',
  byline: (author: string) => `by ${author}`,
  startReading: 'Start reading',
  untitled: 'Untitled',
  column: 'The column',
  previous: 'Previous',
  next: 'Next',
  more: 'More',
  spotlight: 'Author spotlight',
  readTheirBooks: 'See their books',
  colophon: 'Colophon',
  footerNote: 'Every book in this Zone is here by a public decision. Follow the stamp beside any title to read why.',
  works: 'Every book',
  decisions: 'Decision log',
  about: 'About and rules',
};

type Strings = typeof en;

const translations: Record<string, Strings> = {
  en,
  'zh-Hans': {
    official: 'REZICS 官方专区',
    tagline: '公版经典和值得读的版本，由图书编辑部公开甄选。',
    coverStory: '封面故事',
    inThisIssue: '本期目录',
    byline: (author: string) => `${author} 著`,
    startReading: '开始阅读',
    untitled: '未命名',
    column: '专栏',
    previous: '上一页',
    next: '下一页',
    more: '更多',
    spotlight: '作者聚焦',
    readTheirBooks: '看看作者的书',
    colophon: '版权页',
    footerNote: '本专区的每一本书都来自一项公开决定。点开书名旁的印章，就能读到它为什么在这里。',
    works: '全部图书',
    decisions: '决定记录',
    about: '关于与规则',
  },
  'zh-Hant': {
    official: 'REZICS 官方專區',
    tagline: '公版經典和值得讀的版本，由圖書編輯部公開甄選。',
    coverStory: '封面故事',
    inThisIssue: '本期目錄',
    byline: (author: string) => `${author} 著`,
    startReading: '開始閱讀',
    untitled: '未命名',
    column: '專欄',
    previous: '上一頁',
    next: '下一頁',
    more: '更多',
    spotlight: '作者聚焦',
    readTheirBooks: '看看作者的書',
    colophon: '版權頁',
    footerNote: '本專區的每一本書都來自一項公開決定。點開書名旁的印章，就能讀到它為什麼在這裡。',
    works: '全部圖書',
    decisions: '決定紀錄',
    about: '關於與規則',
  },
};

export function strings(locale: string): Strings {
  return translations[locale] ?? en;
}
