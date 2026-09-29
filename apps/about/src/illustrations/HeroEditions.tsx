import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { fill } from '../i18n/messages/illustrations.ts';
import { localeNames, type UiLocale } from '../i18n/locales.ts';
import { Plate } from './Plate.tsx';
import { lantern } from './sample.ts';

/**
 * The home page's picture: one work in three languages and formats, with the
 * reader's place in each. It shows the product's premise in its own components.
 */
export function HeroEditions({ words }: { words: IllustrationCopy }) {
  const rows = [
    { edition: lantern.editions[0], format: words.paperback, progress: 62 },
    { edition: lantern.editions[1], format: words.translation, progress: 100 },
    { edition: lantern.editions[2], format: words.ebook, progress: 18 },
  ];
  return (
    <Plate className="mx-auto w-full max-w-lg lg:ms-auto lg:me-0">
      <div className="flex flex-col gap-3">
        {rows.map(({ edition, format, progress }, index) => (
          <div
            key={edition.id}
            className="flex items-center gap-4 rounded-2xl border border-border/70 bg-background p-4"
            style={{ marginInlineStart: `${index * 0.75}rem` }}
          >
            <WorkCover
              kind="book"
              id={edition.id}
              title={edition.title}
              lang={edition.lang}
              authors={[lantern.author]}
              className="w-16 rounded-md sm:w-24"
            />
            <div className="min-w-0 flex-1">
              <p
                lang={edition.lang}
                className="truncate font-work-title text-lg font-semibold leading-snug sm:text-xl"
              >
                {edition.title}
              </p>
              <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="soft" size="sm" lang={edition.lang}>
                  {localeNames[edition.lang as UiLocale]}
                </Badge>
                {format}
              </p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {progress === 100 ? words.read : fill(words.progress, progress)}
              </p>
            </div>
          </div>
        ))}
      </div>
    </Plate>
  );
}
