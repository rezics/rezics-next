import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { CalendarClock, CircleCheck, Pencil } from 'lucide-react';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { fill } from '../i18n/messages/illustrations.ts';
import type { UiLocale } from '../i18n/locales.ts';
import { Plate } from './Plate.tsx';

/** Chapter list of an invented serial, dated in the reader's own locale. */
export function ChapterSchedule({ words, locale }: { words: IllustrationCopy; locale: UiLocale }) {
  const when = (day: number) =>
    new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 9, day, 9, 0)));
  const rows = [
    { n: 41, kind: 'published' as const, note: '' },
    { n: 42, kind: 'published' as const, note: words.resumeHere },
    { n: 43, kind: 'scheduled' as const, note: when(10) },
    { n: 44, kind: 'scheduled' as const, note: when(17) },
    { n: 45, kind: 'draft' as const, note: '' },
  ];
  const icon = { published: CircleCheck, scheduled: CalendarClock, draft: Pencil };
  const label = { published: words.published, scheduled: words.scheduled, draft: words.draft };
  return (
    <Plate>
      <ul className="divide-y divide-border">
        {rows.map((row) => {
          const Icon = icon[row.kind];
          return (
            <li
              key={row.n}
              className={cn(
                'flex items-center gap-3 py-3',
                row.note === words.resumeHere && '-mx-2 rounded-xl bg-accent px-2',
              )}
            >
              <Icon
                aria-hidden
                className={cn(
                  'size-5 shrink-0',
                  row.kind === 'published' ? 'text-success-foreground' : 'text-muted-foreground',
                )}
              />
              <span className="flex-1 font-medium">{fill(words.chapter, row.n)}</span>
              {row.note && (
                <span
                  className={cn(
                    'text-sm',
                    row.note === words.resumeHere
                      ? 'font-semibold text-accent-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  {row.note}
                </span>
              )}
              <Badge
                variant={
                  row.kind === 'published'
                    ? 'success'
                    : row.kind === 'scheduled'
                      ? 'info'
                      : 'outline'
                }
                size="sm"
              >
                {label[row.kind]}
              </Badge>
            </li>
          );
        })}
      </ul>
    </Plate>
  );
}
