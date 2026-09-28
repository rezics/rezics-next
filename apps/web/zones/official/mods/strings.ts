// The Mods Zone's own words. Packages bring their strings; the platform
// passes the interface locale in `zone.locale`, and any other locale reads English.

const en = {
  official: 'Official REZICS Zone',
  tagline: 'Game mods, load orders and setup guides that keep your saves safe.',
  featured: 'Featured',
  alsoFeatured: 'Also featured',
  get: 'Get',
  by: (author: string) => `by ${author}`,
  untitled: 'Untitled',
  trending: 'Trending',
  intervals: { day: 'Today', week: 'This week', month: 'This month' },
  updatedThisWeek: (count: number) => `${count} updated this week`,
  updated: (ago: string) => `Updated ${ago}`,
  status: { ongoing: 'Active', completed: 'Complete', hiatus: 'Paused' },
  collection: 'Collection',
  count: (count: number) => count === 1 ? '1 pick' : `${count} picks`,
  more: 'See all',
  footerTitle: 'Mods on REZICS',
  footerNote: 'Every pick here is a public decision by the Mods moderators. Follow the stamp on any card to see why it is here.',
  works: 'Every mod and guide',
  decisions: 'Decision log',
  about: 'About and rules',
};

type Strings = typeof en;

const translations: Record<string, Strings> = {
  en,
  'zh-Hans': {
    official: 'REZICS 官方专区',
    tagline: '游戏模组、加载顺序和不会弄坏存档的安装指南。',
    featured: '精选',
    alsoFeatured: '更多精选',
    get: '获取',
    by: (author: string) => `作者 ${author}`,
    untitled: '未命名',
    trending: '热门趋势',
    intervals: { day: '今日', week: '本周', month: '本月' },
    updatedThisWeek: (count: number) => `本周更新 ${count} 项`,
    updated: (ago: string) => `${ago}更新`,
    status: { ongoing: '持续更新', completed: '已完成', hiatus: '暂停更新' },
    collection: '合集',
    count: (count: number) => `${count} 项`,
    more: '查看全部',
    footerTitle: 'REZICS 模组',
    footerNote: '这里的每一项推荐都来自模组版主的一项公开决定。点开卡片上的印章，就能看到它为什么在这里。',
    works: '全部模组与指南',
    decisions: '决定记录',
    about: '关于与规则',
  },
  'zh-Hant': {
    official: 'REZICS 官方專區',
    tagline: '遊戲模組、載入順序和不會弄壞存檔的安裝指南。',
    featured: '精選',
    alsoFeatured: '更多精選',
    get: '取得',
    by: (author: string) => `作者 ${author}`,
    untitled: '未命名',
    trending: '熱門趨勢',
    intervals: { day: '今日', week: '本週', month: '本月' },
    updatedThisWeek: (count: number) => `本週更新 ${count} 項`,
    updated: (ago: string) => `${ago}更新`,
    status: { ongoing: '持續更新', completed: '已完成', hiatus: '暫停更新' },
    collection: '合集',
    count: (count: number) => `${count} 項`,
    more: '查看全部',
    footerTitle: 'REZICS 模組',
    footerNote: '這裡的每一項推薦都來自模組版主的一項公開決定。點開卡片上的印章，就能看到它為什麼在這裡。',
    works: '全部模組與指南',
    decisions: '決定紀錄',
    about: '關於與規則',
  },
};

export function strings(locale: string): Strings {
  return translations[locale] ?? en;
}
