import {
  ArrowBigDownIcon,
  ArrowBigUpIcon,
  FrownIcon,
  HeartIcon,
  LaughIcon,
  LightbulbIcon,
  ThumbsUpIcon,
  type LucideIcon,
} from 'lucide-react';
import React from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Menu } from './menu.tsx';
import { cn } from '../utils.ts';

/** One reaction slot per person and target. Order is the display order. */
export const reactionKinds = ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'] as const;

export type ReactionKind = (typeof reactionKinds)[number];

export interface ReactionLabels {
  upvote: string;
  downvote: string;
  like: string;
  love: string;
  laugh: string;
  insightful: string;
  sad: string;
  /** Opens the list of reactions. */
  react: string;
  /** Names the row of counts. */
  reactions: string;
  /** Names the popover that lists every kind. */
  choose: string;
  /** Announced when saving a change fails. */
  failed: string;
}

export const reactionLabels: ReactionLabels = {
  upvote: 'Upvote',
  downvote: 'Downvote',
  like: 'Like',
  love: 'Love',
  laugh: 'Laugh',
  insightful: 'Insightful',
  sad: 'Sad',
  react: 'React',
  reactions: 'Reactions',
  choose: 'Choose a reaction',
  failed: 'The reaction change failed.',
};

const reactionIcons: Record<ReactionKind, LucideIcon> = {
  upvote: ArrowBigUpIcon,
  downvote: ArrowBigDownIcon,
  like: ThumbsUpIcon,
  love: HeartIcon,
  laugh: LaughIcon,
  insightful: LightbulbIcon,
  sad: FrownIcon,
};

export interface ReactionsProps {
  /** Counts for the target. A kind appears only when its count is above zero. */
  counts: Partial<Record<ReactionKind, number>>;
  /** The viewer's own reaction, or null when they have none. */
  value: ReactionKind | null;
  /**
   * Persists the viewer's one reaction. Resolve when it is saved.
   * Reject to roll the optimistic counts and selection back.
   */
  onChange: (kind: ReactionKind | null) => Promise<void>;
  /** Kind names and UI strings. Omitted strings keep the English defaults. */
  labels?: Partial<ReactionLabels>;
  /** Locale for compact counts. */
  locale: string;
  /** When set, the viewer is signed out: chips are read-only and React links here. */
  signInHref?: string;
  /** The kinds the target admits, in display order. Other kinds are neither shown nor offered. Defaults to all. */
  kinds?: readonly ReactionKind[];
  /**
   * Below the `sm` breakpoint the row shows only this many kinds, the most used ones, plus the viewer's own; the
   * other kinds stay in the picker, which lists the counts there. Wider screens show every kind.
   */
  collapse?: number;
  /** Turns the chips and the React trigger off, for example until the page has hydrated. */
  disabled?: boolean;
}

interface ReactionView {
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
}

/** Moves the viewer's one slot from `from` to `to`. */
export function applyReactionChange(
  counts: Partial<Record<ReactionKind, number>>,
  from: ReactionKind | null,
  to: ReactionKind | null,
): Partial<Record<ReactionKind, number>> {
  if (from === to) return counts;
  const next: Partial<Record<ReactionKind, number>> = { ...counts };
  if (from) next[from] = Math.max(0, (next[from] ?? 0) - 1);
  if (to) next[to] = (next[to] ?? 0) + 1;
  return next;
}

function resolveLabels(override?: Partial<ReactionLabels>): ReactionLabels {
  if (override === undefined) return reactionLabels;
  const resolved: ReactionLabels = { ...reactionLabels };
  for (const key of Object.keys(reactionLabels) as (keyof ReactionLabels)[]) {
    const value = override[key];
    if (value !== undefined) resolved[key] = value;
  }
  return resolved;
}

function formatCount(locale: string, count: number): string {
  return new Intl.NumberFormat(locale, { notation: 'compact' }).format(count);
}

// Pressed text is ink blue (`--primary`). Brand red is a mark and never colors text.
const chipClass = cn(
  buttonVariants({ variant: 'outline', size: 'sm' }),
  'relative rounded-full transition-none pointer-coarse:after:absolute pointer-coarse:after:-inset-2',
);

const pressedClass =
  'border-primary/40 bg-primary/10 text-primary hover:border-primary/40 hover:bg-primary/15 hover:text-primary';

/**
 * Reactions on a thread or post. shadcn has no reaction cluster (it offers `toggle-group` for exclusive choices and
 * `bubble` for chat reactions); this composes `button` chips and a `popover` and adds the one-slot rule on top.
 * Each person holds one kind: choosing another replaces it,
 * and choosing the current one clears it. Counts and the selection move at once, then roll
 * back if saving fails. Further choices wait until the one in flight settles.
 */
export const Reactions = (props: ReactionsProps) => {
  const labels = resolveLabels(props.labels);
  const signInHref = props.signInHref;
  const signedOut = signInHref !== undefined;
  const kinds = props.kinds === undefined ? reactionKinds : reactionKinds.filter((kind) => props.kinds!.includes(kind));
  const disabled = props.disabled === true;
  const propsRef = React.useRef(props);
  propsRef.current = props;
  const labelsRef = React.useRef(labels);
  labelsRef.current = labels;

  const [overlay, setOverlay] = React.useState<ReactionView | null>(null);
  const overlayRef = React.useRef<ReactionView | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const pendingJobs = React.useRef(0);
  const gate = React.useRef(Promise.resolve());

  // Drop the optimistic view once the controlled props echo it and nothing is queued.
  React.useEffect(() => {
    if (busy) return;
    const current = overlayRef.current;
    if (current && current.value === props.value) {
      overlayRef.current = null;
      setOverlay(null);
    }
  }, [busy, props.value, props.counts]);

  const shown = overlay ?? { counts: props.counts, value: props.value };
  // The kinds that stay in the row on a phone: the most used (ties keep the display order) and the viewer's own.
  const phoneRow =
    props.collapse === undefined
      ? null
      : new Set<ReactionKind>([
          ...kinds
            .filter((kind) => (shown.counts[kind] ?? 0) > 0)
            .toSorted((a, b) => (shown.counts[b] ?? 0) - (shown.counts[a] ?? 0))
            .slice(0, props.collapse),
          ...(shown.value ? [shown.value] : []),
        ]);
  const phoneHidden = (kind: ReactionKind) => phoneRow !== null && !phoneRow.has(kind);

  const select = (kind: ReactionKind) => {
    if (propsRef.current.signInHref !== undefined || propsRef.current.disabled === true) return;
    pendingJobs.current += 1;
    setBusy(true);
    const job = gate.current.then(async () => {
      const previous = overlayRef.current;
      const base = previous ?? { counts: propsRef.current.counts, value: propsRef.current.value };
      const next = base.value === kind ? null : kind;
      const pending: ReactionView = {
        counts: applyReactionChange(base.counts, base.value, next),
        value: next,
      };
      overlayRef.current = pending;
      setOverlay(pending);
      setFailure(null);
      try {
        await propsRef.current.onChange(next);
      } catch {
        if (overlayRef.current === pending) {
          overlayRef.current = previous;
          setOverlay(previous);
          setFailure(labelsRef.current.failed);
        }
      }
    });
    // The next click chains onto this job, so it waits until the change settles.
    gate.current = job.then(
      () => {
        pendingJobs.current -= 1;
        if (pendingJobs.current === 0) setBusy(false);
      },
      () => {
        pendingJobs.current -= 1;
        if (pendingJobs.current === 0) setBusy(false);
      },
    );
  };

  return (
    <div
      aria-busy={busy}
      aria-label={labels.reactions}
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-slot="reactions"
      role="group"
    >
      {kinds.map((kind) => {
        const count = shown.counts[kind] ?? 0;
        if (count <= 0) return null;
        const pressed = shown.value === kind;
        const formatted = formatCount(props.locale, count);
        const Icon = reactionIcons[kind];
        const name = `${labels[kind]} ${formatted}`;
        if (signedOut) {
          return (
            <span
              aria-label={name}
              className={cn(chipClass, pressed && pressedClass, phoneHidden(kind) && 'max-sm:hidden')}
              data-pressed={pressed ? 'true' : 'false'}
              data-slot="reaction-chip"
              key={kind}
              role="img"
            >
              <Icon aria-hidden className={cn(pressed && 'fill-current')} />
              <span aria-hidden className="tabular-nums">
                {formatted}
              </span>
            </span>
          );
        }
        return (
          <Button
            aria-pressed={pressed}
            className={cn(chipClass, pressed && pressedClass, phoneHidden(kind) && 'max-sm:hidden')}
            data-pressed={pressed ? 'true' : 'false'}
            data-slot="reaction-chip"
            disabled={disabled}
            key={kind}
            onClick={() => select(kind)}
            size="sm"
            variant="outline"
          >
            <Icon aria-hidden className={cn(pressed && 'fill-current')} />
            <span className="sr-only">{labels[kind]}</span>
            <span className="tabular-nums">{formatted}</span>
          </Button>
        );
      })}
      {signedOut ? (
        <a className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'rounded-full')} href={signInHref}>
          {labels.react}
        </a>
      ) : (
        <Menu
          title={labels.choose}
          trigger={
            <Button className="rounded-full" disabled={disabled} size="sm" variant="outline">
              {labels.react}
            </Button>
          }
          content={
            <div className="flex w-64 flex-col gap-1 p-3">
              {kinds.map((kind) => {
                const Icon = reactionIcons[kind];
                const pressed = shown.value === kind;
                const count = shown.counts[kind] ?? 0;
                return (
                  <Button
                    aria-pressed={pressed}
                    className={cn('relative w-full justify-start px-3 transition-none', pressed && pressedClass)}
                    key={kind}
                    onClick={() => select(kind)}
                    size="sm"
                    variant="ghost"
                  >
                    <Icon aria-hidden className={cn(pressed && 'fill-current')} />
                    {labels[kind]}
                    {phoneRow !== null && count > 0 && (
                      <span className="ms-auto tabular-nums sm:hidden">{formatCount(props.locale, count)}</span>
                    )}
                  </Button>
                );
              })}
            </div>
          }
        />
      )}
      {failure !== null && (
        <p aria-label={failure} className="basis-full text-foreground text-sm" role="status">
          {failure}
        </p>
      )}
    </div>
  );
};
