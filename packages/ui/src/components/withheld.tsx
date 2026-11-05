import type { CSSProperties } from 'react';
import { AspectRatio } from '../shadcn/aspect-ratio.tsx';
import { cn } from '../utils.ts';

export const withheldLabels = { withheld: 'Withheld in response to a notice.' };
export type WithheldLabels = typeof withheldLabels;

export type WithheldProps = (
  | { shape: 'image'; ratio: number }
  | { shape: 'passage' }
  | { shape: 'field'; label: string }
) & {
  labels?: Partial<WithheldLabels>;
  /** Reserve the replaced part's known dimensions without passing its content. */
  className?: string;
  style?: CSSProperties;
};

/** A content-free replacement for one noticed part; shadcn has no withheld-content display. */
export function Withheld(props: WithheldProps) {
  const { shape, labels, className, style } = props;
  const message = { ...withheldLabels, ...labels }.withheld;
  const surface = cn('min-w-0 rounded-sm bg-muted text-sm text-muted-foreground', className);

  if (props.shape === 'image') {
    return (
      <AspectRatio
        ratio={props.ratio}
        data-slot="withheld"
        data-shape={shape}
        className={surface}
        style={{ '--ratio': props.ratio, ...style } as CSSProperties}
      >
        <p className="absolute inset-0 flex items-center justify-center p-3 text-center">{message}</p>
      </AspectRatio>
    );
  }

  if (props.shape === 'field') {
    return (
      <dl
        data-slot="withheld"
        data-shape={shape}
        className={cn(surface, 'flex flex-wrap gap-x-3 gap-y-1 p-3')}
        style={style}
      >
        <dt className="font-medium text-foreground">{props.label}</dt>
        <dd>{message}</dd>
      </dl>
    );
  }

  return (
    <div
      data-slot="withheld"
      data-shape={shape}
      className={cn(surface, 'flex min-h-24 items-center p-4')}
      style={style}
    >
      <p>{message}</p>
    </div>
  );
}
