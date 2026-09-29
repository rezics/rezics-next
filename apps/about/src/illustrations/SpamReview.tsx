import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { Bot, Megaphone, PenLine } from 'lucide-react';
import type { CSSProperties } from 'react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';

/**
 * The spam and advertising reviewer's queue: an unsolicited ad and an author announcing
 * their own book, each with the passages that decided the label and its confidence. The
 * moderator's buttons, not the agent, remove or keep a post.
 */
export function SpamReview({ words, className }: { words: IllustrationCopy; className?: string }) {
  const w = words.agent;
  const items = [
    {
      handle: 'lantern_deals',
      label: w.unsolicitedAd,
      icon: Megaphone,
      confidence: 94,
      parts: ['All nine volumes free, ', 'DM me for the link', '. ', 'Offer ends tonight', '.'],
      suggested: 'remove',
    },
    {
      handle: 'mio_sato',
      label: w.ownWork,
      icon: PenLine,
      confidence: 91,
      parts: [
        '',
        'Volume 7 of my series comes out Friday',
        '. Thank you for reading this far, ',
        'the ferry scene was for you',
        '.',
      ],
      suggested: 'keep',
    },
  ] as const;
  return (
    <Plate className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{w.queue}</p>
        <Badge variant="info" size="sm">
          <Bot aria-hidden />
          {w.automated}
        </Badge>
      </div>
      <ul className="flex flex-col gap-3">
        {items.map((item, index) => (
          <li
            key={item.handle}
            data-arrive
            style={{ '--at': index * 8 } as CSSProperties}
            className="rounded-2xl border border-border bg-background p-4"
          >
            <p className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span translate="no" className="font-semibold">
                @{item.handle}
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <item.icon aria-hidden className="size-4" />
                {item.label}
                <span className="tabular-nums">{fill(w.confidence, { n: item.confidence })}</span>
              </span>
            </p>
            <p lang="en" className="mt-2 leading-relaxed">
              {item.parts.map((part, partIndex) =>
                partIndex % 2 === 1 ? (
                  <mark key={partIndex} className="rounded bg-warning/25 px-0.5 text-foreground">
                    {part}
                  </mark>
                ) : (
                  <span key={partIndex}>{part}</span>
                ),
              )}
            </p>
            <p className="mt-3 flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{w.moderatorDecides}</span>
              <span className="flex gap-1.5">
                <span
                  className={cn(
                    'rounded-full px-3 py-1',
                    item.suggested === 'remove'
                      ? 'bg-foreground font-semibold text-background'
                      : 'border border-border',
                  )}
                >
                  {w.remove}
                </span>
                <span
                  className={cn(
                    'rounded-full px-3 py-1',
                    item.suggested === 'keep'
                      ? 'bg-primary font-semibold text-primary-foreground'
                      : 'border border-border',
                  )}
                >
                  {w.keep}
                </span>
              </span>
            </p>
          </li>
        ))}
      </ul>
    </Plate>
  );
}
