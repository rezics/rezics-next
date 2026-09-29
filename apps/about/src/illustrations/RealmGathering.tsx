import { Badge } from '@rezics/ui/badge';
import { WorkCover, type WorkCoverKind } from '@rezics/ui/work-cover';
import { UsersRound } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { lantern } from './sample.ts';

/** One story as each platform carries it: a web serial, a light novel, a manga, an anime and a game, in different languages. */
const versions = [
  {
    key: 'webSerial',
    kind: 'document',
    id: '7a3b4c5d-e6f7-4801-9a2b-3c4d5e6f7a8b',
    lang: 'ja',
    title: '灯籠の書庫',
  },
  { key: 'lightNovel', kind: 'book', id: lantern.id, lang: 'zh-Hant', title: '燈籠書庫' },
  {
    key: 'manga',
    kind: 'book',
    id: '8b4c5d6e-f708-4912-ab3c-4d5e6f7a8b9c',
    lang: 'fr',
    title: 'Les Archives des lanternes',
  },
  {
    key: 'anime',
    kind: 'document',
    id: '9c5d6e7f-0819-4a23-bc4d-5e6f7a8b9cad',
    lang: 'en',
    title: 'The Lantern Archive',
  },
  {
    key: 'game',
    kind: 'package',
    id: 'ad6e7f80-192a-4b34-8d5e-6f7a8b9cadbe',
    lang: 'ko',
    title: '등롱 서고',
  },
] as const satisfies readonly {
  key: keyof IllustrationCopy['realm'];
  kind: WorkCoverKind;
  id: string;
  lang: string;
  title: string;
}[];

/** Fans who met the story in different places, in their own languages. Handles and posts are invented. */
const fans = [
  {
    by: 'つきよみ',
    from: 'serial',
    lang: 'ja',
    text: '連載一話目から追ってます。書籍版の加筆も最高。',
  },
  {
    by: 'mira.reads',
    from: 'anime',
    lang: 'en',
    text: 'The anime sent me here. The novels kept me.',
  },
  {
    by: '霧港讀者',
    from: 'edition',
    lang: 'zh-Hant',
    text: '第六集的中文版終於出了，大家一起讀吧！',
  },
  {
    by: 'hollow_oak',
    from: 'game',
    lang: 'en',
    text: 'Played the game first. Now the lamplighters make sense.',
  },
] as const;

/**
 * Fans of one story meeting from every platform: the web serial, light novel, manga, anime
 * and game (each in another language) lead into one Realm, where readers, viewers and
 * players talk in their own languages. Static; parts arrive as it scrolls into view.
 */
export function RealmGathering({ words }: { words: IllustrationCopy }) {
  const realm = words.realm;
  return (
    <div aria-hidden="true" data-illustration className="realm-gathering w-full">
      <ol className="grid grid-cols-5 gap-2 sm:gap-4">
        {versions.map((version, index) => (
          <li
            key={version.key}
            data-arrive
            style={{ '--at': index * 6 } as CSSProperties}
            className="flex flex-col items-center gap-2"
          >
            <div className="flex aspect-[2/3] w-full items-end justify-center">
              <WorkCover
                kind={version.kind}
                id={version.id}
                title={version.title}
                lang={version.lang}
                className="w-full rounded-[6px] shadow-[0_18px_30px_-18px_rgb(0_0_0/0.6)]"
              />
            </div>
            <span className="max-w-full text-center text-xs font-semibold text-muted-foreground [overflow-wrap:anywhere] sm:text-sm">
              {realm[version.key]}
            </span>
          </li>
        ))}
      </ol>
      <svg
        className="realm-funnel"
        viewBox="0 0 100 24"
        preserveAspectRatio="none"
        fill="none"
        stroke="currentColor"
      >
        {versions.map((version, index) => (
          <path
            key={version.key}
            d={`M ${10 + index * 20} 0 C ${10 + index * 20} 12, 50 10, 50 24`}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div
        data-arrive
        style={{ '--at': 30 } as CSSProperties}
        className="rounded-[1.75rem] border border-border bg-card p-5 text-card-foreground shadow-(--aura-shadow-float) sm:p-6"
      >
        <div className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <UsersRound className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="font-work-title text-xl font-semibold">{realm.name}</p>
            <p className="text-sm text-muted-foreground">{realm.members}</p>
          </div>
        </div>
        <ul className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {fans.map((fan, index) => (
            <li
              key={fan.by}
              data-arrive
              style={{ '--at': 40 + index * 6 } as CSSProperties}
              className="rounded-xl border border-border bg-background px-3.5 py-3"
            >
              <p className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-semibold">{fan.by}</span>
                <Badge
                  variant="soft"
                  size="sm"
                  className="h-auto max-w-full whitespace-normal py-0.5"
                >
                  {realm.cameFrom[fan.from]}
                </Badge>
              </p>
              <p lang={fan.lang} className="type-body mt-1.5">
                {fan.text}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
