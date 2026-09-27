import type { DiscoveryLoader } from './query.ts';
import type { DiscoveryItem, DiscoveryPage, DiscoveryQuery, Loaded, ReadFailure } from './types.ts';

// Typed story data shaped like Main's discovery responses.

const id = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-3855-42be-84bb-88da77a5b247`;
const book = 'https://schema.org/Book';
const recipe = 'https://schema.org/Recipe';
const document = 'https://schema.org/DigitalDocument';

function item(n: number, title: string, language: string, types: string[],
  rating: { mean: number; count: number; max?: 5 | 10 } | null = null,
  summary: Partial<Pick<DiscoveryItem, 'tagline' | 'completionStatus' | 'chapterCount' | 'wordCount'>> = {}): DiscoveryItem {
  const max = rating?.max ?? 5;
  return { id: id(n), revision: id(n + 100), mainVersion: id(n + 200), types,
    primaryCredits: [], classifications: [],
    tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null, ...summary,
    title: { value: title, language, direction: 'ltr', basis: 'requested' },
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: `work-${n}`, resourceType: 'work' },
    rating: rating ? { context: id(900), count: rating.count, sum: Math.round(rating.mean * rating.count),
      mean: rating.mean, scale: { min: 1, max } } : null,
    match: { publication: 'public-main', type: null, classification: null } };
}

export const works = {
  pride: item(1, 'Pride and Prejudice', 'en', [book], { mean: 4.4, count: 12 }, { completionStatus: 'completed',
    chapterCount: 61, tagline: { value: 'A wry comedy of manners, first impressions and second thoughts.', language: 'en',
      direction: 'ltr', basis: 'requested' } }),
  journey: item(2, '西游记', 'zh-Hans', [book], { mean: 4.8, count: 31 }),
  jane: item(3, 'Jane Eyre', 'en', [book], { mean: 4.1, count: 7 }),
  dumplings: item(4, '韭菜鸡蛋饺子', 'zh-Hans', [recipe], { mean: 4.6, count: 5 }),
  bun: item(5, 'Bun — JavaScript runtime', 'en', [document], { mean: 3.9, count: 3 }),
  frankenstein: item(6, 'Frankenstein; or, The Modern Prometheus', 'en', [book], { mean: 4.0, count: 9 }),
  chamber: item(7, '红楼梦', 'zh-Hans', [book], { mean: 4.9, count: 40 }),
  pancakes: item(8, 'Weekend buttermilk pancakes', 'en', [recipe], { mean: 4.2, count: 4 }),
  serial: item(9, '雨夜书店 · 连载小说：一部关于深夜书店、未寄出的信和最后一班车的长篇连载', 'zh-Hans', [book],
    { mean: 3.7, count: 2 }, { completionStatus: 'ongoing', chapterCount: 3,
      tagline: { value: '深夜书店里，未寄出的信都在等一个人。', language: 'zh-Hans', direction: 'ltr', basis: 'requested' } }),
  fallback: { ...item(10, 'Alice’s Adventures in Wonderland', 'en', [book]),
    title: { value: 'Alice’s Adventures in Wonderland', language: 'en', direction: 'ltr', basis: 'fallback' } },
  tea: item(11, 'Ginger lemon tea', 'en', [recipe]),
  react: item(12, 'React — user interface library', 'en', [document]),
} satisfies Record<string, DiscoveryItem>;

export const classified = (source: 'local' | 'global', entry: DiscoveryItem): DiscoveryItem => ({ ...entry,
  match: { ...entry.match, classification: { sense: id(700), concept: id(701), decision: id(702), source,
    name: { value: 'Adventure', language: 'en', direction: 'ltr', basis: 'fallback' } } } });

export function page(items: DiscoveryItem[], options: { next?: boolean; seen?: number; context?: boolean } = {}):
  DiscoveryPage {
  const next = options.next ?? false;
  return { profile: 'discovery-works-v1', order: 'recent', scope: { kind: 'global', realm: null },
    matchedTerm: items[0]?.match.classification ?? null,
    context: options.context ? id(900) : null, items, nextCursor: next ? 'cursor-2' : null,
    sourcePosition: { dataEpoch: 'story', sequence: '47' },
    count: { value: items.length, kind: 'exact-page', total: null },
    matches: { value: (options.seen ?? 0) + items.length, kind: next ? 'lower-bound' : 'exact' } };
}

export const ok = <T>(data: T): Loaded<T> => ({ ok: true, data });
export const failed = <T>(failure: ReadFailure): Loaded<T> => ({ ok: false, failure });

/** A second page for "Show more", or a failure in its place. */
export function loader(second: DiscoveryItem[] | ReadFailure, seen = 6): DiscoveryLoader {
  return async (_query: DiscoveryQuery) => typeof second === 'string' ? failed(second)
    : ok(page(second, { seen }));
}
