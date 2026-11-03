import {
  ArrowBigDownIcon,
  ArrowBigUpIcon,
  FrownIcon,
  HeartIcon,
  LaughIcon,
  LightbulbIcon,
  SmilePlusIcon,
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
  /** The same one-slot queue, presented as up / score / down. Other admitted kinds keep their chips and picker. */
  presentation?: 'chips' | 'vote' | 'vote-plain';
}

interface ReactionView {
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
}

interface ReactionQueue {
  active: boolean;
  tail: Promise<void>;
  pendingJobs: number;
  overlay: ReactionView | null;
  failure: string | null;
}

interface QueueView {
  queue: ReactionQueue;
  overlay: ReactionView | null;
  failure: string | null;
  busy: boolean;
}

interface CurrentReactionProps {
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
  disabled: boolean | undefined;
  signInHref: string | undefined;
  kinds: readonly ReactionKind[] | undefined;
}

interface ReactionVisit {
  admission: AdmissionSignal;
  queue: ReactionQueue;
}

interface AdmissionSignal {
  disabled: boolean;
  signInHref: string | undefined;
  kinds: string;
}

function admittedKinds(kinds?: readonly ReactionKind[]): ReactionKind[] {
  return kinds === undefined ? [...reactionKinds] : reactionKinds.filter((kind) => kinds.includes(kind));
}

function admissionSignal(props: ReactionsProps): AdmissionSignal {
  return {
    disabled: props.disabled === true,
    signInHref: props.signInHref,
    kinds: admittedKinds(props.kinds).join('\u001f'),
  };
}

function sameAdmission(left: AdmissionSignal, right: AdmissionSignal): boolean {
  return left.disabled === right.disabled && left.signInHref === right.signInHref && left.kinds === right.kinds;
}

function newReactionQueue(): ReactionQueue {
  return { active: true, tail: Promise.resolve(), pendingJobs: 0, overlay: null, failure: null };
}

const useClientLayoutEffect = typeof document === 'undefined' ? React.useEffect : React.useLayoutEffect;

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

function formatExactCount(locale: string, count: number): string {
  return new Intl.NumberFormat(locale).format(count);
}

function formatAccessibleCount(locale: string, count: number): string {
  const compact = formatCount(locale, count);
  const exact = formatExactCount(locale, count);
  return compact === exact ? compact : `${compact} (${exact})`;
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
  const kinds = admittedKinds(props.kinds);
  const disabled = props.disabled === true;
  const currentPropsRef = React.useRef<CurrentReactionProps>({
    counts: props.counts,
    value: props.value,
    disabled: props.disabled,
    signInHref: props.signInHref,
    kinds: props.kinds,
  });
  const failedLabelRef = React.useRef(labels.failed);

  const queueRef = React.useRef<ReactionQueue | null>(null);
  const [view, setView] = React.useState<QueueView | null>(null);
  const nextAdmission = admissionSignal(props);
  const [visit, setVisit] = React.useState<ReactionVisit>(() => ({
    admission: nextAdmission,
    queue: newReactionQueue(),
  }));
  if (!sameAdmission(visit.admission, nextAdmission)) {
    // Admission changes describe a new visit. Derive its empty queue during render so stale optimistic state is never
    // shown for the newly committed props; the layout cleanup below retires the predecessor before Promise jobs run.
    setVisit({ admission: nextAdmission, queue: newReactionQueue() });
  }
  const queue = visit.queue;

  useClientLayoutEffect(() => {
    currentPropsRef.current = {
      counts: props.counts,
      value: props.value,
      disabled: props.disabled,
      signInHref: props.signInHref,
      kinds: props.kinds,
    };
    failedLabelRef.current = labels.failed;
  }, [props.counts, props.value, props.disabled, props.signInHref, props.kinds, labels.failed]);

  const isCurrent = (candidate: ReactionQueue, kind?: ReactionKind) => {
    const current = currentPropsRef.current;
    if (
      !candidate.active ||
      queueRef.current !== candidate ||
      current.disabled === true ||
      current.signInHref !== undefined
    )
      return false;
    return kind === undefined || admittedKinds(current.kinds).includes(kind);
  };

  const publish = (candidate: ReactionQueue) => {
    if (!isCurrent(candidate)) return;
    setView({
      queue: candidate,
      overlay: candidate.overlay,
      failure: candidate.failure,
      busy: candidate.pendingJobs > 0,
    });
  };

  useClientLayoutEffect(() => {
    // Retire the previous visit at commit, before another browser event or queued Promise job can use it.
    const previous = queueRef.current;
    if (previous && previous !== queue) previous.active = false;
    queueRef.current = queue;
    // Re-enable the current queue on Strict Mode's development-only effect replay.
    queue.active = true;
    return () => {
      queue.active = false;
      if (queueRef.current === queue) queueRef.current = null;
    };
  }, [queue]);

  const currentView: QueueView =
    view?.queue === queue
      ? view
      : { queue, overlay: queue.overlay, failure: queue.failure, busy: queue.pendingJobs > 0 };
  const { overlay, failure, busy } = currentView;

  // Drop the optimistic view once the controlled props echo it and nothing is queued.
  React.useEffect(() => {
    if (!isCurrent(queue) || queue.pendingJobs > 0) return;
    const current = queue.overlay;
    if (current && current.value === props.value) {
      queue.overlay = null;
      publish(queue);
    }
  }, [busy, overlay, props.value, props.counts, queue]);

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
    if (!isCurrent(queue, kind)) return;
    const onChange = props.onChange;
    queue.pendingJobs += 1;
    publish(queue);
    const job = queue.tail.then(async () => {
      if (!isCurrent(queue, kind)) return;
      const previous = queue.overlay;
      const current = currentPropsRef.current;
      const base = previous ?? { counts: current.counts, value: current.value };
      const next = base.value === kind ? null : kind;
      const pending: ReactionView = {
        counts: applyReactionChange(base.counts, base.value, next),
        value: next,
      };
      queue.overlay = pending;
      queue.failure = null;
      publish(queue);
      try {
        await onChange(next);
      } catch {
        if (isCurrent(queue) && queue.overlay === pending) {
          queue.overlay = previous;
          queue.failure = failedLabelRef.current;
          publish(queue);
        }
      }
    });
    // The next click chains onto this job, so it waits until the change settles.
    queue.tail = job.then(
      () => {
        queue.pendingJobs = Math.max(0, queue.pendingJobs - 1);
        publish(queue);
      },
      () => {
        queue.pendingJobs = Math.max(0, queue.pendingJobs - 1);
        publish(queue);
      },
    );
  };

  const votes =
    props.presentation !== undefined &&
    props.presentation !== 'chips' &&
    kinds.includes('upvote') &&
    kinds.includes('downvote');
  const pickerClass = cn(
    'rounded-full',
    votes && 'min-h-11 min-w-11 px-0 sm:min-h-8 sm:min-w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
  );
  const pickerLabel = votes ? (
    <>
      <SmilePlusIcon aria-hidden className="size-4" />
      <span className="sr-only">{labels.react}</span>
    </>
  ) : (
    labels.react
  );
  // Native count maps omit zero kinds. An admitted map is a complete projection, not a generic click count.
  const score = (shown.counts.upvote ?? 0) - (shown.counts.downvote ?? 0);
  const voteArrow = (kind: 'upvote' | 'downvote') => {
    const Icon = reactionIcons[kind];
    const pressed = shown.value === kind;
    const count = shown.counts[kind] ?? 0;
    const className = cn(
      'inline-flex min-h-11 min-w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:min-w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
      pressed ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent',
    );
    return signedOut ? (
      <a href={signInHref} aria-label={`${labels[kind]} ${formatExactCount(props.locale, count)}`} className={className}>
        <Icon aria-hidden className="size-5" />
      </a>
    ) : (
      <button
        type="button"
        aria-label={`${labels[kind]} ${formatExactCount(props.locale, count)}`}
        aria-pressed={pressed}
        className={className}
        disabled={disabled}
        onClick={() => select(kind)}
      >
        <Icon aria-hidden className={cn('size-5', pressed && 'fill-current')} />
      </button>
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
      {votes ? (
        <div
          data-slot="vote-control"
          className={cn('inline-flex items-center rounded-full', props.presentation !== 'vote-plain' && 'bg-muted/70')}
        >
          {voteArrow('upvote')}
          <output
            aria-label={formatAccessibleCount(props.locale, score)}
            aria-live="polite"
            className="min-w-8 px-1 text-center text-sm font-semibold tabular-nums"
          >
            {formatCount(props.locale, score)}
          </output>
          {voteArrow('downvote')}
        </div>
      ) : null}
      {kinds.map((kind) => {
        if (votes && (kind === 'upvote' || kind === 'downvote')) return null;
        const count = shown.counts[kind] ?? 0;
        if (count <= 0) return null;
        const pressed = shown.value === kind;
        const formatted = formatCount(props.locale, count);
        const Icon = reactionIcons[kind];
        const name = `${labels[kind]} ${formatAccessibleCount(props.locale, count)}`;
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
            aria-label={name}
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
        <a className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), pickerClass)} href={signInHref}>
          {pickerLabel}
        </a>
      ) : (
        <Menu
          title={labels.choose}
          trigger={
            <Button className={pickerClass} disabled={disabled} size="sm" variant="outline">
              {pickerLabel}
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
                    aria-label={`${labels[kind]} ${formatAccessibleCount(props.locale, count)}`}
                    aria-pressed={pressed}
                    className={cn('relative w-full justify-start px-3 transition-none', pressed && pressedClass)}
                    disabled={disabled}
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
