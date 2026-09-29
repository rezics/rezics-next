import { Badge } from '@rezics/ui/badge';
import { WorkCover } from '@rezics/ui/work-cover';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { localeNames, type UiLocale } from '../i18n/locales.ts';
import { Plate } from './Plate.tsx';
import { lantern } from './sample.ts';

/** One edition of an invented book: cover, formats, language, price and rights side by side. */
export function EditionOnSale({ words, locale }: { words: IllustrationCopy; locale: UiLocale }) {
  const price = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(8.99);
  return (
    <Plate className="flex gap-5">
      <WorkCover
        kind="book"
        id={lantern.editions[0].id}
        title={lantern.editions[0].title}
        lang="en"
        authors={[lantern.author]}
        className="w-28 shrink-0 self-start rounded-md sm:w-36"
      />
      <div className="flex min-w-0 flex-col gap-3">
        <h3 lang="en" className="font-work-title text-xl font-semibold leading-snug">
          {lantern.editions[0].title}
        </h3>
        <div className="flex flex-wrap gap-2">
          <Badge variant="soft">{words.ebook}</Badge>
          <Badge variant="soft">{words.paperback}</Badge>
          <Badge variant="outline" lang="en">
            {localeNames.en}
          </Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{words.price}</dt>
          <dd className="font-semibold">{price}</dd>
          <dt className="text-muted-foreground">{words.rights}</dt>
          <dd>{words.rightsHeld}</dd>
        </dl>
      </div>
    </Plate>
  );
}
