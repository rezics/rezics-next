// The Fiction Zone's own words. Packages bring their strings; the platform
// passes the interface locale in `zone.locale`, and any other locale reads English.

const en = {
  tagline: 'Web serials, light novels and originals, picked in public by the Fiction editors.',
  official: 'Official REZICS Zone',
  podium: 'Top of the chart',
  more: 'Full chart',
  footerTitle: 'Fiction on REZICS',
  footerNote: 'Every pick in this Zone is a public decision. Follow the stamp on any work to see why it is here.',
  decisions: 'Decision log',
  about: 'About and rules',
  works: 'Every work',
};

type Strings = typeof en;

const translations: Record<string, Strings> = {
  en,
  'zh-Hans': {
    tagline: '网络连载、轻小说与原创作品，由小说编辑部公开甄选。',
    official: 'REZICS 官方专区',
    podium: '榜单前三',
    more: '完整榜单',
    footerTitle: 'REZICS 小说',
    footerNote: '本专区的每一部推荐都来自一项公开决定。点开作品旁的印章，就能看到它为什么在这里。',
    decisions: '决定记录',
    about: '关于与规则',
    works: '全部作品',
  },
  'zh-Hant': {
    tagline: '網路連載、輕小說與原創作品，由小說編輯部公開甄選。',
    official: 'REZICS 官方專區',
    podium: '榜單前三',
    more: '完整榜單',
    footerTitle: 'REZICS 小說',
    footerNote: '本專區的每一部推薦都來自一項公開決定。點開作品旁的印章，就能看到它為什麼在這裡。',
    decisions: '決定紀錄',
    about: '關於與規則',
    works: '全部作品',
  },
};

export function strings(locale: string): Strings {
  return translations[locale] ?? en;
}
