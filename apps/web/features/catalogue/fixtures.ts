import type { ReaderActions, ReaderWorkState, ReadingStatus } from './reader-actions.tsx';
import type { CatalogueWork } from './work.ts';
import { authorHref } from '../author/route.ts';

// Story data: Works as catalogue cards show them, and a reader-actions adapter
// that keeps its state in memory, standing in for Main's reader state (G-285).

export const storyWorkId = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-3855-42be-84bb-88da77a5b247`;

function work(n: number, title: string, language: string, kind: CatalogueWork['kind'], authors: string[],
  rating: [mean: number, count: number] | null): CatalogueWork {
  return { id: storyWorkId(n), href: `/w/${storyWorkId(n).slice(-36)}`, kind,
    authors: authors.map(name => ({ name, href: name === 'Jane Austen'
      ? authorHref({ kind: 'external', key: '/authors/OL21594A' }) : null })),
    title: { value: title, language, direction: 'ltr', basis: 'requested' },
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: `work-${n}`, resourceType: 'work' },
    rating: rating ? { mean: rating[0], count: rating[1], max: 5 } : null };
}

export const classics: CatalogueWork[] = [
  { ...work(1, 'Pride and Prejudice', 'en', 'book', ['Jane Austen'], [4.29, 4_391_220]),
    tagline: { value: 'A wry comedy of manners, first impressions and second thoughts.', language: 'en', direction: 'ltr',
      basis: 'requested' } },
  work(2, 'Jane Eyre', 'en', 'book', ['Charlotte Brontë'], [4.15, 2_072_310]),
  work(3, 'Frankenstein; or, The Modern Prometheus', 'en', 'book', ['Mary Shelley'], [3.89, 1_784_002]),
  work(4, 'Middlemarch', 'en', 'book', ['George Eliot'], [4.02, 180_455]),
  work(5, 'Wuthering Heights', 'en', 'book', ['Emily Brontë'], [3.88, 1_604_981]),
  work(6, 'The Secret Garden', 'en', 'book', ['Frances Hodgson Burnett'], [4.16, 1_234_117]),
  work(7, 'Little Women', 'en', 'book', ['Louisa May Alcott'], [4.13, 2_498_004]),
  work(8, 'Great Expectations', 'en', 'book', ['Charles Dickens'], [3.79, 856_003]),
];

export const chinese: CatalogueWork[] = [
  work(21, '西游记', 'zh-Hans', 'book', ['吴承恩'], [4.2, 31]),
  work(22, '红楼梦', 'zh-Hans', 'book', ['曹雪芹'], [4.6, 40]),
  work(23, '聊斋志异', 'zh-Hans', 'book', ['蒲松龄'], [4.4, 18]),
  work(24, '三国演义', 'zh-Hans', 'book', ['罗贯中'], [4.3, 22]),
  { ...work(25, '雨夜书店 · 连载小说：一部关于深夜书店、未寄出的信和最后一班车的长篇连载', 'zh-Hans', 'book', ['林夜'], [3.7, 2]),
    completion: 'ongoing', tagline: { value: '深夜书店里，未寄出的信都在等一个人。', language: 'zh-Hans', direction: 'ltr',
      basis: 'requested' } },
  work(26, '水浒传', 'zh-Hans', 'book', [], null),
];

export const guides: CatalogueWork[] = [
  work(31, 'Bun — JavaScript runtime', 'en', 'document', [], [4.4, 12]),
  work(32, 'Elysia — TypeScript web framework', 'en', 'document', [], [4.1, 5]),
  work(33, 'React — user interface library', 'en', 'document', [], null),
  work(34, 'TypeScript — typed JavaScript', 'en', 'document', [], [4.6, 9]),
];

export const recipes: CatalogueWork[] = [
  work(41, '韭菜鸡蛋饺子', 'zh-Hans', 'recipe', [], [4.6, 5]),
  work(42, '番茄鸡蛋面', 'zh-Hans', 'recipe', [], [4.8, 7]),
  work(43, 'Weekend buttermilk pancakes', 'en', 'recipe', [], [4.2, 4]),
  work(44, 'Ginger lemon tea', 'en', 'recipe', [], null),
];

/**
 * Reader actions over an in-memory state. `fail` makes every write refuse, to
 * show how a control reports a write Main did not accept.
 */
export function memoryReaderActions(initial: Record<string, Partial<ReaderWorkState>> = {},
  options: { fail?: boolean; rate?: boolean; denied?: boolean } = {}): ReaderActions & { kind: 'ready' } {
  const states = new Map(Object.entries(initial).map(([work, state]) =>
    [work, { status: null, rating: null, ...state } satisfies ReaderWorkState]));
  const stateOf = (work: string): ReaderWorkState => states.get(work) ?? { status: null, rating: null };
  const settle = () => new Promise<boolean>(done => setTimeout(() => done(!options.fail), 150));
  return { kind: 'ready', ratingMax: 5, stateOf, available: () => !options.denied,
    async setStatus(work: string, status: ReadingStatus | null) {
      const saved = await settle();
      if (saved) states.set(work, { ...stateOf(work), status });
      return saved;
    },
    rate: options.rate === false ? null : async (work: string, rating: number | null) => {
      const saved = await settle();
      if (saved) states.set(work, { ...stateOf(work), rating });
      return saved;
    } };
}
