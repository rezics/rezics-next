export interface DemoPerson { id: string; name: string; handle: string; email: string; password: string }
export interface DemoWork { id: string; title: string; type: 'book' | 'document' | 'recipe';
  language: 'en' | 'zh-Hans'; excerpt?: string; tagline?: string;
  completionStatus?: 'ongoing' | 'completed' | 'hiatus' }

export const people: readonly DemoPerson[] = [
  { id: 'mei', handle: 'lin_mei', name: 'Lin Mei 林梅', email: 'rezics-demo-mei@example.test', password: 'Rezics-demo-2026-mei' },
  { id: 'daniel', handle: 'daniel_chen', name: 'Daniel Chen 陈丹尼', email: 'rezics-demo-daniel@example.test', password: 'Rezics-demo-2026-daniel' },
  { id: 'an', handle: 'an_wu', name: 'An Wu 吴安', email: 'rezics-demo-an@example.test', password: 'Rezics-demo-2026-an' },
  { id: 'sophie', handle: 'sophie_li', name: 'Sophie Li 李素菲', email: 'rezics-demo-sophie@example.test', password: 'Rezics-demo-2026-sophie' },
  { id: 'jun', handle: 'jun_zhang', name: 'Jun Zhang 张俊', email: 'rezics-demo-jun@example.test', password: 'Rezics-demo-2026-jun' },
  { id: 'aria', handle: 'aria_wang', name: 'Aria Wang 王雅', email: 'rezics-demo-aria@example.test', password: 'Rezics-demo-2026-aria' },
  { id: 'leo', handle: 'leo_sun', name: 'Leo Sun 孙乐', email: 'rezics-demo-leo@example.test', password: 'Rezics-demo-2026-leo' },
];

export const works: readonly DemoWork[] = [
  { id: 'pride', title: 'Pride and Prejudice', type: 'book', language: 'en',
    tagline: 'Elizabeth Bennet meets a proud stranger, and first impressions begin to unravel.',
    completionStatus: 'completed',
    excerpt: 'Chapter 1\nIt is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.' },
  { id: 'pride-ch2', title: 'Pride and Prejudice — Chapter 2', type: 'document', language: 'en',
    excerpt: 'Chapter 2\nMr. Bennet was among the earliest of those who waited on Mr. Bingley.' },
  { id: 'alice', title: "Alice's Adventures in Wonderland", type: 'book', language: 'en',
    excerpt: 'Chapter I. Down the Rabbit-Hole\nAlice was beginning to get very tired of sitting by her sister on the bank.' },
  { id: 'alice-pool', title: "Alice's Adventures in Wonderland — The Pool of Tears", type: 'document', language: 'en',
    excerpt: 'Chapter II. The Pool of Tears\n“Curiouser and curiouser!” cried Alice.' },
  { id: 'sherlock', title: 'The Adventures of Sherlock Holmes', type: 'book', language: 'en' },
  { id: 'sherlock-scandal', title: 'A Scandal in Bohemia', type: 'document', language: 'en' },
  { id: 'jane-eyre', title: 'Jane Eyre', type: 'book', language: 'en' },
  { id: 'frankenstein', title: 'Frankenstein; or, The Modern Prometheus', type: 'book', language: 'en' },
  { id: 'little-women', title: 'Little Women', type: 'book', language: 'en' },
  { id: 'secret-garden', title: 'The Secret Garden', type: 'book', language: 'en' },
  { id: 'journey-west', title: '西游记', type: 'book', language: 'zh-Hans',
    tagline: '一场西行取经之旅，从石猴出世开始。', completionStatus: 'completed',
    excerpt: '第一回 灵根育孕源流出 心性修持大道生\n诗曰：混沌未分天地乱，茫茫渺渺无人见。' },
  { id: 'journey-west-ch2', title: '西游记 · 第二回 悟彻菩提真妙理', type: 'document', language: 'zh-Hans' },
  { id: 'red-chamber', title: '红楼梦', type: 'book', language: 'zh-Hans',
    excerpt: '第一回 甄士隐梦幻识通灵 贾雨村风尘怀闺秀\n满纸荒唐言，一把辛酸泪！' },
  { id: 'red-chamber-ch2', title: '红楼梦 · 第二回 贾夫人仙逝扬州城', type: 'document', language: 'zh-Hans' },
  { id: 'strange-tales', title: '聊斋志异', type: 'book', language: 'zh-Hans' },
  { id: 'painted-skin', title: '聊斋志异 · 画皮', type: 'document', language: 'zh-Hans' },
  { id: 'three-kingdoms', title: '三国演义', type: 'book', language: 'zh-Hans' },
  { id: 'water-margin', title: '水浒传', type: 'book', language: 'zh-Hans' },
  { id: 'serial', title: '雨夜书店 · 连载小说', type: 'book', language: 'zh-Hans',
    tagline: '一封没有地址的信，把雨夜书店带向二十年前的秘密。', completionStatus: 'ongoing',
    excerpt: '第一章 雨夜\n雨停在书店打烊前。林梅在门口发现一封没有地址的信。' },
  { id: 'serial-ch2', title: '雨夜书店 · 第二章 未寄出的信', type: 'document', language: 'zh-Hans',
    excerpt: '第二章 未寄出的信\n信封里只有一张旧车票，日期是二十年前。' },
  { id: 'serial-ch3', title: '雨夜书店 · 第三章 最后一班车', type: 'document', language: 'zh-Hans',
    excerpt: '第三章 最后一班车\n末班车到站时，整座站台只有她一个人。' },
  { id: 'pride-zh', title: '傲慢与偏见 · 中文译读', type: 'book', language: 'zh-Hans' },
  { id: 'bun', title: 'Bun — JavaScript runtime', type: 'document', language: 'en',
    excerpt: 'Bun is a JavaScript runtime. Start with a small script, then compare its tooling with the needs of your project.' },
  { id: 'elysia', title: 'Elysia — TypeScript web framework', type: 'document', language: 'en',
    excerpt: 'Elysia provides a way to define HTTP routes with TypeScript. Check the request and response contract before adding a handler.' },
  { id: 'react', title: 'React — user interface library', type: 'document', language: 'en',
    excerpt: 'React builds interfaces from components. A small component is a useful place to test states and keyboard behavior.' },
  { id: 'typescript', title: 'TypeScript — typed JavaScript', type: 'document', language: 'en',
    excerpt: 'TypeScript adds static types to JavaScript. Describe the data shape at an API boundary, then check callers against it.' },
  { id: 'dumplings', title: '韭菜鸡蛋饺子', type: 'recipe', language: 'zh-Hans' },
  { id: 'noodles', title: '番茄鸡蛋面', type: 'recipe', language: 'zh-Hans' },
  { id: 'pancakes', title: 'Weekend buttermilk pancakes', type: 'recipe', language: 'en' },
  { id: 'tea', title: 'Ginger lemon tea', type: 'recipe', language: 'en' },
  { id: 'prompt', title: 'Bilingual book club discussion prompt', type: 'document', language: 'en',
    excerpt: 'Ask each reader to choose one passage, explain its meaning in their preferred language, and compare interpretations.' },
  { id: 'skill', title: 'Recipe scaling assistant skill', type: 'document', language: 'en',
    excerpt: 'Ask for the original servings and the desired servings. Show the new quantities and flag ingredients that need judgment.' },
  { id: 'mod-guide', title: 'Mod setup checklist', type: 'document', language: 'en',
    excerpt: 'Record the game version, required dependencies, load order, and a way to restore the previous setup before changing mods.' },
];

export const realms = [
  { id: 'fiction', name: 'Fiction · 小说', preset: 'serial',
    featured: ['serial', 'journey-west', 'red-chamber'] },
  { id: 'books', name: 'Books · 图书', preset: 'editorial',
    featured: ['pride', 'alice', 'jane-eyre', 'little-women'] },
  { id: 'mods', name: 'Mods · 模组', preset: 'vibrant',
    featured: ['mod-guide'] },
  { id: 'ai-workshop', name: 'AI Workshop · AI 工作坊', preset: 'clean',
    featured: ['prompt', 'skill'] },
  { id: 'software', name: 'Software · 软件', preset: 'clean',
    featured: ['bun', 'elysia', 'react', 'typescript'] },
  { id: 'kitchen', name: 'Kitchen · 厨房', preset: 'editorial',
    featured: ['dumplings', 'noodles', 'pancakes', 'tea'] },
] as const;

export function seedKey(kind: string, id: string): string {
  return `dev-seed:v1:${kind}:${id}`;
}

export function semanticTypes(type: DemoWork['type']): string[] {
  return [type === 'book' ? 'https://schema.org/Book'
    : type === 'recipe' ? 'https://schema.org/Recipe' : 'https://schema.org/DigitalDocument'];
}
