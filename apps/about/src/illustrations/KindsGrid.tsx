import { WorkCover } from '@rezics/ui/work-cover';
import { UsersRound } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { kindsOfStory, moreKinds, type KindKey, type Name } from './sample.ts';

/** The order kinds are listed in: stories first, then what grows around them. */
const order: readonly KindKey[] = [
  'webSerial',
  'lightNovel',
  'book',
  'visualNovel',
  'anime',
  'manga',
  'game',
  'software',
  'aiPrompt',
  'recipe',
  'wiki',
  'community',
];

const examples = new Map<
  KindKey,
  { cover: 'book' | 'document' | 'recipe' | 'package' | null; id: string; name: Name }
>([
  ...kindsOfStory.map((kind) => [kind.key, { ...kind, name: kind.names[0] }] as const),
  ...moreKinds.map((kind) => [kind.key, kind] as const),
]);

/**
 * Every kind of story REZICS gives a page, each with one invented example in its own
 * language and one fact its page shows: the same parts, different facts. The names and
 * facts are content; the covers are decoration. Cards arrive as the grid scrolls in.
 */
export function KindsGrid({ words }: { words: IllustrationCopy }) {
  return (
    <ul className="kinds-grid">
      {order.map((key, index) => {
        const example = examples.get(key)!;
        return (
          <li
            key={key}
            data-arrive
            style={{ '--at': (index % 4) * 5 } as CSSProperties}
            className="kind-card"
          >
            <div aria-hidden="true" className="kind-cover">
              {example.cover ? (
                <WorkCover
                  kind={example.cover}
                  id={example.id}
                  title={example.name.text}
                  lang={example.name.lang}
                  className="w-14 rounded-[4px] shadow-[0_10px_20px_-12px_rgb(0_0_0/0.5)] lg:w-20"
                />
              ) : (
                <span className="grid size-16 place-items-center rounded-full bg-primary text-primary-foreground">
                  <UsersRound className="size-7" />
                </span>
              )}
            </div>
            <div className="min-w-0">
              <h3 className="font-bold">{words.kinds[key].name}</h3>
              <p
                lang={example.name.lang}
                className="mt-1 truncate font-work-title text-[0.9375rem]"
              >
                {example.name.text}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{words.kinds[key].fact}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
