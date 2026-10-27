import { CopyrightIcon, EyeIcon } from 'lucide-react';
import { useCallback, useState, type CSSProperties } from 'react';
import { AspectRatio } from '../shadcn/aspect-ratio.tsx';
import { Button } from '../shadcn/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../shadcn/popover.tsx';
import { cn } from '../utils.ts';
import { initials } from './avatar-initials.tsx';
import {
  coverFallback,
  coverFit,
  coverRatio,
  coverSizes,
  coverSrcSet,
  coverWidths,
  intrinsicSize,
  objectPosition,
  placeholderColors,
  ratioValue,
  thumbhashImage,
  type CoverFormat,
  type CoverRatio,
  type CoverSize,
  type CoverSubject,
  type CoverSummary,
} from './cover-model.ts';

export { coverRatio, parseCoverRatio, placeholderColors, sharedRatio } from './cover-model.ts';
export type { CoverRatio, CoverSize, CoverSubject, CoverSummary } from './cover-model.ts';

export const coverLabels = {
  withheld: 'Sensitive cover',
  reveal: 'Show cover',
  credit: 'Cover credit',
  via: 'via',
} as const;

export type CoverLabels = { readonly [K in keyof typeof coverLabels]: string };

export interface CoverProps {
  subject: CoverSubject;
  /** The cover summary the kernel returned with the subject, or null when the reader may not see a cover. */
  cover: CoverSummary | null;
  size: CoverSize;
  /** The address of one variant, from the site's media route. `Cover` never builds addresses itself. */
  src: (media: string, format: CoverFormat, width: number) => string;
  /** A row's shared ratio; otherwise the ratio of the subject's type. */
  ratio?: CoverRatio;
  /** An empty text alternative, for a repeat next to the visible title. */
  decorative?: boolean;
  /** The page's own cover: eager, with high fetch priority. */
  priority?: boolean;
  /** The viewer's setting for covers withheld for suitability. */
  suitability?: 'blur' | 'show';
  /** Show the credit as a caption below the cover (the subject page, at lg and larger). */
  caption?: boolean;
  labels?: Partial<CoverLabels>;
  className?: string;
}

type Status = { media: string; value: 'loaded' | 'failed' };

/**
 * The image area of any subject, which always renders: the image fitted to a frame whose ratio comes from the
 * subject's type, or the typographic placeholder when there is no image, it fails to load or it was taken down.
 * shadcn has no cover or poster component; this one adds what a subject needs on top of its `AspectRatio` and
 * `Button`: the ThumbHash and colour painted while the image loads, the fit rule, the deterministic placeholder,
 * the suitability blur and the credit.
 */
export function Cover({
  subject,
  cover,
  size,
  src,
  ratio,
  decorative = false,
  priority = false,
  suitability = 'blur',
  caption = false,
  labels,
  className,
}: CoverProps) {
  const text = { ...coverLabels, ...labels };
  const frameRatio = ratio ?? coverRatio(subject.types);
  const image = cover && cover.variants.length > 0 ? cover : null;
  const [status, setStatus] = useState<Status | null>(null);
  const [backdrop, setBackdrop] = useState<{ media: string; src: string } | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);

  const withheld = image?.withheld === 'suitability' && suitability !== 'show' && revealed !== image.media;
  const outcome = image && status?.media === image.media ? status.value : null;
  const state = !image || outcome === 'failed' ? 'placeholder' : withheld ? 'withheld' : outcome ? 'loaded' : 'loading';
  const fit = image ? coverFit(image, frameRatio) : null;

  // An image that finished before this component hydrated fires no event; read its state when it mounts.
  const track = useCallback(
    (element: HTMLImageElement | null) => {
      if (!element || !image || !element.complete) return;
      setStatus({ media: image.media, value: element.naturalWidth > 0 ? 'loaded' : 'failed' });
      if (element.naturalWidth > 0) setBackdrop({ media: image.media, src: element.currentSrc });
    },
    [image?.media],
  );

  const colors = placeholderColors(subject);
  const large = size === 'lg' || size === 'xl' || size === 'fill';
  const credit = image?.credit && (state === 'loading' || state === 'loaded') ? image.credit : null;
  const dimensions = intrinsicSize(size, frameRatio);
  const width: CSSProperties = size === 'fill' ? { width: '100%' } : { width: coverWidths[size] };

  const frame = (
    <div
      className={cn('relative max-w-full shrink-0', className)}
      data-slot="cover"
      data-state={state}
      data-ratio={frameRatio}
      data-size={size}
      data-fit={fit ?? undefined}
      role={state === 'placeholder' && !decorative ? 'img' : undefined}
      aria-label={state === 'placeholder' && !decorative ? subject.title : undefined}
      aria-hidden={state === 'placeholder' && decorative ? true : undefined}
      style={width}
    >
      <AspectRatio
        ratio={ratioValue(frameRatio)}
        className="@container overflow-hidden rounded-lg bg-muted ring-1 ring-foreground/10"
      >
        {state === 'placeholder' ? (
          <Placeholder subject={subject} size={size} colors={colors} />
        ) : (
          <>
            <div className="absolute inset-0" style={{ backgroundColor: image!.placeholder.color }} />
            {fit === 'cover' || state === 'withheld' ? (
              <Thumbhash hash={image!.placeholder.thumbhash} blurred={state === 'withheld'} />
            ) : null}
            {state === 'withheld' ? (
              <Withheld text={text} />
            ) : (
              <>
                <picture>
                  {(['avif', 'webp'] as const).map((format) =>
                    image!.variants.some((variant) => variant.format === format) ? (
                      <source
                        key={format}
                        type={`image/${format}`}
                        srcSet={coverSrcSet(image!.media, image!.variants, format, src)}
                        sizes={coverSizes(size)}
                      />
                    ) : null,
                  )}
                  <img
                    ref={track}
                    className={cn(
                      'absolute inset-0 z-[1] size-full',
                      fit === 'cover' ? 'object-cover' : 'object-contain',
                    )}
                    style={{ objectPosition: objectPosition(subject.types, image!.focalPoint) }}
                    src={coverFallback(
                      image!.media,
                      image!.variants,
                      image!.variants.some((variant) => variant.format === 'webp') ? 'webp' : 'avif',
                      size,
                      src,
                    )}
                    srcSet={coverSrcSet(
                      image!.media,
                      image!.variants,
                      image!.variants.some((variant) => variant.format === 'webp') ? 'webp' : 'avif',
                      src,
                    )}
                    sizes={coverSizes(size)}
                    width={dimensions.width}
                    height={dimensions.height}
                    alt={decorative ? '' : subject.title}
                    loading={priority ? 'eager' : 'lazy'}
                    fetchPriority={priority ? 'high' : undefined}
                    decoding="async"
                    onLoad={(event) => {
                      setStatus({ media: image!.media, value: 'loaded' });
                      setBackdrop({ media: image!.media, src: event.currentTarget.currentSrc });
                    }}
                    onError={() => setStatus({ media: image!.media, value: 'failed' })}
                  />
                </picture>
                {fit === 'contain' && (
                  <div
                    aria-hidden="true"
                    data-slot="cover-backdrop"
                    className="absolute inset-0 scale-110 bg-cover bg-center blur-xl brightness-50"
                    style={{
                      backgroundImage:
                        backdrop?.media === image!.media ? `url(${JSON.stringify(backdrop.src)})` : undefined,
                    }}
                  />
                )}
              </>
            )}
          </>
        )}
        {large && credit && !caption ? <CreditControl credit={credit} text={text} fill={size === 'fill'} /> : null}
        {state === 'withheld' ? <RevealButton text={text} onReveal={() => setRevealed(image!.media)} /> : null}
      </AspectRatio>
    </div>
  );

  if (!caption || !large || !credit) return frame;
  return (
    <figure className="m-0 w-fit max-w-full" style={size === 'fill' ? { width: '100%' } : undefined}>
      {frame}
      <figcaption className="mt-1.5 text-xs text-muted-foreground">
        <CreditText credit={credit} text={text} />
      </figcaption>
    </figure>
  );
}

function Thumbhash({ hash, blurred }: { hash: string; blurred: boolean }) {
  const url = thumbhashImage(hash);
  if (!url) return null;
  return (
    <div
      className={cn('absolute inset-0 bg-cover bg-center', blurred && 'scale-125 blur-xl')}
      style={{ backgroundImage: `url(${url})` }}
    />
  );
}

/**
 * The typographic placeholder: the title in the Work title face and the byline in the interface face, on the
 * subject's own colour. Below 64 px a set title is unreadable, so it shows the initials; a `fill` frame switches
 * on its own width.
 */
function Placeholder({
  subject,
  size,
  colors,
}: {
  subject: CoverSubject;
  size: CoverSize;
  colors: { background: string; foreground: string };
}) {
  const letters = (
    <span
      className={cn(
        'font-work-title font-semibold leading-none',
        size === 'fill' ? 'hidden @max-[63px]:flex' : 'flex',
        'absolute inset-0 items-center justify-center',
      )}
      style={{ fontSize: '38cqw' }}
    >
      {initials(subject.title)}
    </span>
  );
  const title = (
    <div
      className={cn(
        'absolute inset-0 flex flex-col justify-between gap-[6cqw] p-[8cqw]',
        size === 'fill' && '@max-[63px]:hidden',
      )}
    >
      <p
        className="line-clamp-6 font-work-title leading-[1.2] font-semibold wrap-anywhere text-balance"
        style={{ fontSize: 'clamp(0.75rem, 10cqw, 1.625rem)' }}
      >
        {subject.title}
      </p>
      {subject.byline ? (
        <p
          className="line-clamp-2 border-t pt-[4cqw] font-sans font-medium wrap-anywhere"
          style={{ fontSize: 'clamp(0.625rem, 6.5cqw, 0.9375rem)', borderColor: `${colors.foreground}66` }}
        >
          {subject.byline}
        </p>
      ) : null}
    </div>
  );
  return (
    <div className="absolute inset-0" style={{ backgroundColor: colors.background, color: colors.foreground }}>
      {size === 'xs' ? (
        letters
      ) : size === 'fill' ? (
        <>
          {letters}
          {title}
        </>
      ) : (
        title
      )}
    </div>
  );
}

/** The label of a withheld cover, over its blurred ThumbHash; the reveal control sits beside it. */
function Withheld({ text }: { text: CoverLabels }) {
  return (
    <div className="absolute inset-0 bg-black/20">
      <span className="sr-only @max-[119px]:block @min-[120px]:not-sr-only @min-[120px]:absolute @min-[120px]:inset-x-2 @min-[120px]:top-[18%] @min-[120px]:mx-auto @min-[120px]:w-fit @min-[120px]:max-w-[calc(100%-1rem)] @min-[120px]:rounded-md @min-[120px]:bg-background/95 @min-[120px]:px-2 @min-[120px]:py-1 @min-[120px]:text-center @min-[120px]:text-xs @min-[120px]:font-medium @min-[120px]:text-foreground">
        {text.withheld}
      </span>
    </div>
  );
}

function RevealButton({ text, onReveal }: { text: CoverLabels; onReveal: () => void }) {
  return (
    <div className="absolute inset-x-0 bottom-[16%] flex justify-center @max-[119px]:inset-0 @max-[119px]:bottom-0 @max-[119px]:items-center">
      <Button type="button" variant="secondary" size="sm" onClick={onReveal} aria-label={text.reveal}>
        <EyeIcon aria-hidden />
        <span className="@max-[119px]:hidden">{text.reveal}</span>
      </Button>
    </div>
  );
}

type Credit = NonNullable<CoverSummary['credit']>;

function CreditText({ credit, text }: { credit: Credit; text: CoverLabels }) {
  return (
    <>
      <span>© {credit.rightsHolder}</span>
      {credit.via ? (
        <>
          {' · '}
          {text.via}{' '}
          <a className="text-primary underline underline-offset-2" href={credit.via.url} rel="noreferrer noopener">
            {credit.via.name}
          </a>
        </>
      ) : null}
      {credit.license ? ` · ${credit.license}` : null}
    </>
  );
}

/** The credit of a large cover, one control away: the rights holder, the source it came through and the licence. */
function CreditControl({ credit, text, fill }: { credit: Credit; text: CoverLabels; fill: boolean }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            aria-label={text.credit}
            className={cn('absolute right-2 bottom-2 z-10 shadow-sm', fill && 'hidden @min-[240px]:inline-flex')}
          />
        }
      >
        <CopyrightIcon aria-hidden />
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-64 gap-1 text-xs" align="end" side="top">
        <CreditText credit={credit} text={text} />
      </PopoverContent>
    </Popover>
  );
}
