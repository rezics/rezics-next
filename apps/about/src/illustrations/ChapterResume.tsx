import { cn } from '@rezics/ui/utils';
import { Laptop, MessageSquare, Smartphone } from 'lucide-react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { serial } from './sample.ts';

const paragraphs = [
  'The tide map had been wrong for eleven years, and Wren was the only one who knew why.',
  'She folded it along her mother’s old creases and slid it back into the drawer, as if nothing had changed.',
  'Downstairs, the ferry bell rang twice. Someone had come looking for the cartographer.',
];

/** The laptop the reader left: the same chapter drawn as lines, with the same paragraph marked. */
function LaptopPage({ words }: { words: IllustrationCopy }) {
  return (
    <div className="col-start-1 col-end-11 row-start-1 self-start rounded-[1.75rem] border border-border bg-card p-5 shadow-(--aura-shadow-card)">
      <p className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{fill(words.shelf.chapter, { n: serial.chapter })}</span>
        <Laptop aria-hidden className="size-4" />
      </p>
      <div className="mt-5 flex flex-col gap-2.5">
        {[92, 100, 64, 0, 100, 96, 88, 0, 100, 72].map((width, index) =>
          width === 0 ? (
            <span key={index} className="h-2" />
          ) : (
            <span
              key={index}
              className={cn(
                'h-2 rounded-full',
                index >= 4 && index <= 6 ? 'bg-primary/35' : 'bg-muted',
              )}
              style={{ width: `${width}%` }}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** The phone the reader picks up: it opens at the marked paragraph. */
function PhonePage({ words }: { words: IllustrationCopy }) {
  return (
    <div className="rounded-[2rem] border-2 border-border bg-card p-5 text-card-foreground shadow-(--aura-shadow-float)">
      <p className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{fill(words.shelf.chapter, { n: serial.chapter })}</span>
        <Smartphone aria-hidden className="size-4" />
      </p>
      <p lang="en" className="mt-1 font-work-title text-lg font-semibold">
        {serial.title}
      </p>
      <div lang="en" className="mt-4 flex flex-col gap-3 font-work-title leading-relaxed">
        {paragraphs.map((text, index) => (
          <p
            key={index}
            className={cn('relative', index === 1 && '-mx-2 rounded-lg bg-accent/70 px-2 py-1')}
          >
            {text}
            {index === 1 ? <span className="ribbon absolute -end-3 -top-1 h-10 w-2.5" /> : null}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * A web serial read on two devices: the paragraph the reader stopped at on the laptop is
 * where the phone opens, marked by the ribbon, with the chapter's discussion one tap away.
 */
export function ChapterResume({
  words,
  className,
}: {
  words: IllustrationCopy;
  className?: string;
}) {
  return (
    <div aria-hidden="true" data-illustration className={cn('grid w-full grid-cols-12', className)}>
      <LaptopPage words={words} />
      <div data-arrive className="col-start-3 col-end-13 row-start-1 mt-12 sm:col-start-5">
        <PhonePage words={words} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground">
            {words.serial.stoppedHere}
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm">
            <MessageSquare aria-hidden className="size-4" />
            {words.serial.comments}
          </span>
        </div>
      </div>
    </div>
  );
}
