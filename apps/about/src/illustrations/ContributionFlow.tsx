import { Badge } from '@rezics/ui/badge';
import { cn } from '@rezics/ui/utils';
import { Bot, Check, History, Quote, Receipt, Undo2, X } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { fill } from '../i18n/fill.ts';
import type { IllustrationCopy } from '../i18n/messages/illustrations.ts';
import { Plate } from './Plate.tsx';

export type ContributionStage = 'propose' | 'review' | 'apply' | 'undo';

const realm = 'Salt Marsh Readers';
const reviewer = 'Hana Mori';
/** A reader's post, the passages the agent quoted, and the tags they support. */
const post = {
  before: 'Just finished volume 3. The archive was ',
  home: 'the first place Kaede felt at home',
  middle: ', and the keeper’s ledgers turn into ',
  slow: 'a slow, patient friendship',
  after: '. I spent the whole evening in ',
  marsh: 'the marsh chapters',
  end: '.',
};
const tags = [
  { tag: 'found family', quote: post.home, confidence: 88, decision: 'accept' },
  { tag: 'slow burn', quote: post.slow, confidence: 71, decision: 'accept' },
  { tag: 'marsh', quote: post.marsh, confidence: 64, decision: 'reject' },
] as const;

function Header({ words, children }: { words: IllustrationCopy; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Bot aria-hidden className="size-4 text-primary" />
        <span>{fill(words.agent.runBy, { name: realm })}</span>
      </p>
      {children ?? (
        <Badge variant="info" size="sm">
          {words.agent.automated}
        </Badge>
      )}
    </div>
  );
}

function Post({ highlight }: { highlight: boolean }) {
  const mark = (text: string) =>
    highlight ? <mark className="rounded bg-warning/25 px-0.5 text-foreground">{text}</mark> : text;
  return (
    <p lang="en" className="font-work-title leading-relaxed">
      {post.before}
      {mark(post.home)}
      {post.middle}
      {mark(post.slow)}
      {post.after}
      {mark(post.marsh)}
      {post.end}
    </p>
  );
}

function Propose({ words }: { words: IllustrationCopy }) {
  return (
    <>
      <Header words={words} />
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold">{words.agent.proposal}</p>
        <p className="text-sm text-muted-foreground">{fill(words.agent.readRevision, { n: 3 })}</p>
      </div>
      <ul className="flex flex-col gap-2.5">
        {tags.map((item, index) => (
          <li
            key={item.tag}
            data-arrive
            style={{ '--at': index * 6 } as CSSProperties}
            className="rounded-2xl border border-border bg-background p-3"
          >
            <div className="flex items-center justify-between gap-3">
              <Badge variant="outline" size="md" lang="en">
                {item.tag}
              </Badge>
              <span className="text-sm tabular-nums text-muted-foreground">
                {fill(words.agent.confidence, { n: item.confidence })}
              </span>
            </div>
            <p className="mt-2 flex gap-2 text-sm text-muted-foreground">
              <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span lang="en" className="font-work-title italic">
                {item.quote}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

function Review({ words }: { words: IllustrationCopy }) {
  return (
    <>
      <Header words={words} />
      <div className="rounded-2xl border border-border bg-background p-4">
        <Post highlight />
      </div>
      <ul className="flex flex-col gap-2">
        {tags.map((item, index) => (
          <li
            key={item.tag}
            data-arrive
            style={{ '--at': index * 6 } as CSSProperties}
            className="flex items-center justify-between gap-3"
          >
            <Badge variant="outline" size="md" lang="en">
              {item.tag}
            </Badge>
            <span className="flex flex-wrap gap-1.5 text-sm">
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-3 py-1',
                  item.decision === 'accept'
                    ? 'bg-primary font-semibold text-primary-foreground'
                    : 'border border-border',
                )}
              >
                <Check aria-hidden className="size-3.5" />
                {words.agent.accept}
              </span>
              <span className="rounded-full border border-border px-3 py-1">
                {words.agent.edit}
              </span>
              <span
                className={cn(
                  'flex items-center gap-1 rounded-full px-3 py-1',
                  item.decision === 'reject'
                    ? 'bg-foreground font-semibold text-background'
                    : 'border border-border',
                )}
              >
                <X aria-hidden className="size-3.5" />
                {words.agent.reject}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Apply({ words }: { words: IllustrationCopy }) {
  return (
    <>
      <div className="rounded-2xl border border-border bg-background p-4">
        <Post highlight={false} />
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {tags
            .filter((item) => item.decision === 'accept')
            .map((item) => (
              <li key={item.tag}>
                <Badge variant="soft" size="md" lang="en">
                  <Bot aria-hidden />
                  {item.tag}
                </Badge>
              </li>
            ))}
        </ul>
      </div>
      <div data-arrive className="rounded-2xl border-2 border-success/40 bg-success/5 p-4">
        <p className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-semibold text-success-foreground">
            <Check aria-hidden className="size-4" />
            {words.agent.accepted}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Receipt aria-hidden className="size-4" />
            <span translate="no">{fill(words.agent.receipt, { id: 'r-7f3a' })}</span>
          </span>
        </p>
        <p className="mt-3 text-sm">{fill(words.agent.runBy, { name: realm })}</p>
        <p className="mt-1 text-sm">{fill(words.agent.reviewedBy, { name: reviewer })}</p>
      </div>
    </>
  );
}

function Undo({ words }: { words: IllustrationCopy }) {
  const rows = [
    { n: 4, icon: Bot, text: words.agent.historyApplied },
    { n: 5, icon: History, text: fill(words.agent.historyHuman, { name: reviewer }) },
    { n: 6, icon: Undo2, text: words.agent.historyReversed },
  ];
  return (
    <>
      <ol className="flex flex-col gap-2.5">
        {rows.map((row, index) => (
          <li
            key={row.n}
            data-arrive={index === 2 ? '' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-2xl border p-3',
              index === 2 ? 'border-primary bg-accent' : 'border-border bg-background',
            )}
          >
            <row.icon aria-hidden className="size-4 shrink-0 text-primary" />
            <span className="flex-1 text-sm">{row.text}</span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {fill(words.serial.revision, { n: row.n })}
            </span>
          </li>
        ))}
      </ol>
      <div className="rounded-2xl border border-border bg-background p-4">
        <ul className="flex flex-wrap gap-1.5">
          {tags
            .filter((item) => item.decision === 'accept')
            .map((item) => (
              <li key={item.tag}>
                <Badge variant="outline" size="md" lang="en" className="line-through opacity-70">
                  {item.tag}
                </Badge>
              </li>
            ))}
          <li>
            <Badge variant="soft" size="md" lang="en">
              comfort read
            </Badge>
          </li>
        </ul>
        <p className="mt-3 flex items-center gap-1.5 text-sm text-success-foreground">
          <Check aria-hidden className="size-4" />
          {words.agent.keptEdits}
        </p>
      </div>
    </>
  );
}

/**
 * One contribution's journey through the open protocol, in four stages: an agent proposes
 * tags with quoted evidence, a person reviews them against the post, the accepted ones
 * apply with a receipt, and reversing the agent's change keeps the human edit made since.
 */
export function ContributionFlow({
  words,
  stage,
  className,
}: {
  words: IllustrationCopy;
  stage: ContributionStage;
  className?: string;
}) {
  const Stage = { propose: Propose, review: Review, apply: Apply, undo: Undo }[stage];
  return (
    <Plate className={cn('flex flex-col gap-4', className)}>
      <Stage words={words} />
    </Plate>
  );
}
