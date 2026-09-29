import { Badge } from '@rezics/ui/badge';
import { Check } from 'lucide-react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { fill } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';

/** A wiki page of an invented world, with numbered sources and its revision history. */
export function WikiPage({ words }: { words: IllustrationCopy }) {
  return (
    <Plate className="grid gap-6 sm:grid-cols-[1fr_11rem]">
      <article lang="en">
        <h3 className="font-work-title text-2xl font-semibold">The Lantern Archive</h3>
        <p className="mt-3 font-work-title leading-relaxed">
          The archive stands at the edge of the salt marsh<sup className="text-primary">[1]</sup>.
          Its keepers light one lantern for every book that is lent and put it out when the book
          comes home<sup className="text-primary">[2]</sup>.
        </p>
      </article>
      <aside className="flex flex-col gap-4 text-sm">
        <div>
          <p className="font-semibold">{words.sources}</p>
          <ol className="mt-1 list-decimal ps-5 text-muted-foreground">
            <li lang="en">Marsh Almanac, 412</li>
            <li lang="ja">灯籠の書庫、二章</li>
          </ol>
        </div>
        <div>
          <p className="font-semibold">{words.history}</p>
          <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
            {[14, 13, 12].map((n, index) => (
              <li key={n} className="flex items-center gap-2">
                {index === 0 ? (
                  <Badge variant="success" size="sm">
                    <Check aria-hidden />
                    {words.reviewed}
                  </Badge>
                ) : (
                  <span className="w-full">{fill(words.revision, n)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </Plate>
  );
}
