import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AspectRatio } from '../shadcn/aspect-ratio.tsx';
import { Button } from '../shadcn/button.tsx';
import { cn } from '../utils.ts';
import { useCoverRatio } from './cover-card.tsx';
import { ratioValue, type CoverRatio } from './cover-model.ts';
import { useLocale } from './locale.tsx';

export const tombstoneLabels = {
  deleted: 'This record was deleted.',
  withheld: 'This record is withheld.',
  restore: 'Restore',
  restoreUntil: (relative: string) => `Restore window ends ${relative}`,
};
export type TombstoneLabels = typeof tombstoneLabels;

export interface TombstoneProps {
  reason: 'deleted' | 'withheld';
  shape: 'post' | 'card' | 'row';
  /** Pass both owner props only for the owner. This component does not authorize a restore. */
  restoreUntil?: string | Date;
  onRestore?: () => void;
  labels?: Partial<TombstoneLabels>;
  /** Outside CoverGrid/CoverRow, supply the replaced card's frame ratio. */
  ratio?: CoverRatio;
  /** Match a surface's known item dimensions without passing any record content. */
  className?: string;
  style?: CSSProperties;
}

/** A content-free reference in the original slot; shadcn has no deleted-record display. */
export function Tombstone({ reason, shape, restoreUntil, onRestore, labels, ratio, className, style }: TombstoneProps) {
  const text = { ...tombstoneLabels, ...labels };
  const { locale } = useLocale();
  const collectionRatio = useCoverRatio();
  const deadline = restoreUntil === undefined ? NaN : new Date(restoreUntil).getTime();
  const [now, setNow] = useState(Date.now);
  const restorable = reason === 'deleted' && !!onRestore && Number.isFinite(deadline) && deadline > now;
  const content = useRef<HTMLDivElement>(null);
  const [reservedHeight, setReservedHeight] = useState<number>();

  // Keep the owner's occupied space when the deadline removes the controls, including wrapped labels.
  useEffect(() => {
    const element = content.current;
    if (!restorable || !element) return;
    const measure = () => setReservedHeight(element.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [restorable]);

  useEffect(() => {
    if (reason !== 'deleted' || !onRestore || !Number.isFinite(deadline)) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (deadline > time) timer = setTimeout(tick, Math.min(60_000, deadline - time));
    };
    tick();
    return () => clearTimeout(timer);
  }, [deadline, reason, onRestore]);

  const remaining = deadline - now;
  const unit =
    remaining >= 86_400_000 ? 'day' : remaining >= 3_600_000 ? 'hour' : remaining >= 60_000 ? 'minute' : 'second';
  const divisor = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1000 }[unit];

  return (
    <div
      data-slot="tombstone"
      data-shape={shape}
      className={cn(
        'min-w-0 rounded-lg bg-card text-card-foreground',
        shape === 'card' ? 'overflow-hidden shadow-sm' : 'flex items-center border p-4',
        shape === 'post' && 'min-h-32',
        shape === 'row' && 'min-h-16',
        className,
      )}
      style={style}
    >
      {shape === 'card' ? (
        <AspectRatio ratio={ratioValue(collectionRatio ?? ratio ?? '2:3')} aria-hidden className="bg-muted" />
      ) : null}
      <div
        ref={content}
        style={{ minHeight: reservedHeight }}
        className={cn('flex min-w-0 flex-col gap-2 text-sm', shape === 'card' && 'min-h-24 p-3')}
      >
        <p className="text-muted-foreground">{text[reason]}</p>
        {restorable ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (Date.now() < deadline) onRestore?.();
              }}
            >
              {text.restore}
            </Button>
            <time
              className="text-xs text-muted-foreground"
              dateTime={new Date(deadline).toISOString()}
              title={new Date(deadline).toLocaleString(locale)}
            >
              {text.restoreUntil(new Intl.RelativeTimeFormat(locale).format(Math.ceil(remaining / divisor), unit))}
            </time>
          </div>
        ) : null}
      </div>
    </div>
  );
}
