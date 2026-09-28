// The AI Workshop Zone's own words. Packages bring their strings; the platform
// passes the interface locale in `zone.locale`, and any other locale reads English.

const en = {
  official: 'Official REZICS Zone',
  tagline: 'Prompts, skills and small tools for reading and writing with AI.',
  browse: 'Browse every prompt and skill',
  featured: 'Featured',
  copyLink: 'Copy link',
  copied: 'Link copied',
  copyFailed: 'Could not copy the link',
  tryIt: 'Try it',
  by: (author: string) => `by ${author}`,
  untitled: 'Untitled',
  collection: 'Collection',
  count: (count: number) => count === 1 ? '1 prompt or skill' : `${count} prompts and skills`,
  more: 'See all',
  footerTitle: 'AI Workshop on REZICS',
  footerNote: 'Every prompt and skill here was placed by a public decision. Follow the stamp on any card to see why.',
  works: 'Every prompt and skill',
  decisions: 'Decision log',
  about: 'About and rules',
};

type Strings = typeof en;

const translations: Record<string, Strings> = {
  en,
  'zh-Hans': {
    official: 'REZICS 官方专区',
    tagline: '用 AI 读书和写作的提示词、技能与小工具。',
    browse: '浏览全部提示词与技能',
    featured: '精选',
    copyLink: '复制链接',
    copied: '链接已复制',
    copyFailed: '无法复制链接',
    tryIt: '试一试',
    by: (author: string) => `作者 ${author}`,
    untitled: '未命名',
    collection: '合集',
    count: (count: number) => `${count} 个提示词与技能`,
    more: '查看全部',
    footerTitle: 'REZICS AI 工作坊',
    footerNote: '这里的每条提示词和技能都来自一项公开决定。点开卡片上的印章，就能看到它为什么在这里。',
    works: '全部提示词与技能',
    decisions: '决定记录',
    about: '关于与规则',
  },
  'zh-Hant': {
    official: 'REZICS 官方專區',
    tagline: '用 AI 讀書和寫作的提示詞、技能與小工具。',
    browse: '瀏覽全部提示詞與技能',
    featured: '精選',
    copyLink: '複製連結',
    copied: '連結已複製',
    copyFailed: '無法複製連結',
    tryIt: '試一試',
    by: (author: string) => `作者 ${author}`,
    untitled: '未命名',
    collection: '合集',
    count: (count: number) => `${count} 個提示詞與技能`,
    more: '查看全部',
    footerTitle: 'REZICS AI 工作坊',
    footerNote: '這裡的每條提示詞和技能都來自一項公開決定。點開卡片上的印章，就能看到它為什麼在這裡。',
    works: '全部提示詞與技能',
    decisions: '決定紀錄',
    about: '關於與規則',
  },
};

export function strings(locale: string): Strings {
  return translations[locale] ?? en;
}
