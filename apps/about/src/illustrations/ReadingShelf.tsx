import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import { BookOpen, Check } from 'lucide-react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';
import { lantern } from './sample.ts';

const shelf = [
  {
    id: 'b7f1c2d3-11aa-4e21-9c10-aa01bb02cc03',
    title: 'Northern Lights Atlas',
    lang: 'en',
    authors: ['J. Alder'],
  },
  {
    id: lantern.editions[0].id,
    title: lantern.editions[0].title,
    lang: 'en',
    authors: [lantern.author],
  },
  {
    id: lantern.editions[2].id,
    title: lantern.editions[2].title,
    lang: 'ja',
    authors: ['佐藤 澪'],
  },
  {
    id: 'c4d5e6f7-22bb-4f32-8d21-bb12cc23dd34',
    title: 'Tidewater',
    lang: 'en',
    authors: ['R. Voss'],
  },
  {
    id: lantern.editions[1].id,
    title: lantern.editions[1].title,
    lang: 'zh-Hant',
    authors: ['佐藤美拉'],
  },
] as const;

/** A shelf of covers and, under it, the three copies of one work with their state. */
export function ReadingShelf({ words }: { words: IllustrationCopy }) {
  const copies = [
    { label: words.paperback, state: words.owned, icon: BookOpen },
    { label: words.ebook, state: words.read, icon: Check },
    { label: words.translation, state: words.next, icon: BookOpen },
  ];
  return (
    <Plate>
      <div className="flex items-end justify-center gap-3 border-b-4 border-border px-2 pb-0 sm:gap-4">
        {shelf.map((work, index) => (
          <WorkCover
            key={work.id}
            kind="book"
            id={work.id}
            title={work.title}
            lang={work.lang}
            authors={work.authors}
            className={
              index === 1
                ? 'w-[22%] max-w-32 rounded-md'
                : 'hidden w-[17%] max-w-24 rounded-md sm:block'
            }
          />
        ))}
        <WorkCover
          kind="book"
          id={shelf[0].id}
          title={shelf[0].title}
          lang="en"
          authors={shelf[0].authors}
          className="w-[22%] max-w-32 rounded-md sm:hidden"
        />
      </div>
      <ul className="mt-5 flex flex-wrap gap-2">
        {copies.map(({ label, state, icon: Icon }) => (
          <li key={label}>
            <Badge variant="outline" size="lg" className="gap-1.5">
              <Icon aria-hidden />
              {label}
              <span className="text-muted-foreground">{state}</span>
            </Badge>
          </li>
        ))}
      </ul>
    </Plate>
  );
}
