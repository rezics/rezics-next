import { CheckIcon, EllipsisIcon } from 'lucide-react';
import {
  createContext,
  useContext,
  type ComponentType,
  type MouseEvent,
  type PointerEventHandler,
  type ReactNode,
} from 'react';
import { Button } from '../shadcn/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../shadcn/dropdown-menu.tsx';
import { Cover, type CoverProps, type CoverRatio } from './cover.tsx';

export type CoverDensity = 'small' | 'medium' | 'large';
const DensityContext = createContext<CoverDensity | undefined>(undefined);

const RatioContext = createContext<CoverRatio | undefined>(undefined);

/** The frame shared by cards and tombstones in a cover collection. */
export function useCoverRatio() {
  return useContext(RatioContext);
}

/** What the card needs of the link that carries its title: a site passes its router link here. */
export type CoverCardLink = ComponentType<{
  href: string;
  lang?: string | undefined;
  title?: string | undefined;
  onClick?: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  className?: string | undefined;
  children: ReactNode;
}>;

export interface CoverCardProps {
  /** Omit for a card with no destination: its title is then plain text. */
  href?: string;
  /** The component that draws the title link, an anchor by default; a site passes its client-side router link. */
  link?: CoverCardLink;
  cover: Omit<CoverProps, 'size'>;
  title: string;
  titleLang?: string;
  /** The link's accessible name when it says more than the title does ("Continue <title>"); it must contain the title. */
  linkLabel?: string;
  secondary?: ReactNode;
  state?: ReactNode;
  menu?: ReactNode;
  menuLabel?: string;
  density?: CoverDensity;
  status?: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean, event: MouseEvent<HTMLButtonElement>) => void;
  onSelect?: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/** A subject card with a stretched title link; shadcn has no subject-cover card pattern. */
export function CoverCard({
  href,
  link,
  cover,
  title,
  titleLang,
  linkLabel,
  secondary,
  state,
  menu,
  menuLabel,
  density: densityProp,
  status,
  badge,
  meta,
  selectable = false,
  selected = false,
  onSelectedChange,
  onSelect,
  onPointerDown,
  onClick,
}: CoverCardProps) {
  const ratio = useContext(RatioContext);
  const contextDensity = useContext(DensityContext);
  const density = densityProp ?? contextDensity;
  const small = density === 'small';
  const Link = link ?? 'a';
  return (
    <article
      onPointerDown={onPointerDown}
      className="group relative min-w-0 overflow-hidden rounded-lg bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md focus-within:ring-2 focus-within:ring-ring"
    >
      <Cover
        {...cover}
        size="fill"
        {...(ratio ? { ratio } : {})}
        decorative
        caption={false}
        className="[&_[data-slot=aspect-ratio]]:rounded-none [&_[data-slot=aspect-ratio]]:ring-0 [&_button:not(.absolute)]:relative [&_button]:z-10"
      />
      {selectable ? (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={title}
          title={small ? title : undefined}
          onClick={(event) => onSelectedChange?.(!selected, event)}
          className="absolute inset-0 z-10 cursor-pointer outline-none"
        />
      ) : null}
      {selectable ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-2 left-2 z-20 flex size-5 items-center justify-center rounded border bg-background text-foreground"
        >
          {selected && <CheckIcon className="size-4" />}
        </span>
      ) : (
        <>
          {status != null && (
            <div
              className={`pointer-events-none absolute top-2 left-2 z-10 ${onSelect ? 'pointer-fine:group-hover:invisible pointer-fine:group-focus-within:invisible' : ''}`}
            >
              {status}
            </div>
          )}
          {onSelect && (
            <button
              type="button"
              role="checkbox"
              aria-checked="false"
              aria-label={title}
              data-shelf-select
              onClick={onSelect}
              className="absolute top-2 left-2 z-20 hidden size-5 items-center justify-center rounded border bg-background opacity-0 pointer-fine:flex group-hover:opacity-100 focus:opacity-100"
            />
          )}
        </>
      )}
      {small && (
        <div
          role="tooltip"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1 bottom-1 z-30 rounded bg-popover p-1 text-xs text-popover-foreground opacity-0 shadow group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {title}
        </div>
      )}
      {badge != null && <div className="pointer-events-none absolute top-2 right-2 z-10">{badge}</div>}
      <div className={small ? (state != null ? 'space-y-1 p-2 [&_.tabular-nums]:sr-only' : '') : 'space-y-1 p-3'}>
        {selectable ? (
          <span className={small ? 'sr-only' : 'line-clamp-2 text-sm font-semibold wrap-anywhere'} lang={titleLang}>
            {title}
          </span>
        ) : href === undefined ? (
          <div lang={titleLang} className={small ? 'sr-only' : 'line-clamp-2 text-sm font-semibold wrap-anywhere'}>
            {title}
          </div>
        ) : (
          <Link
            href={href}
            lang={titleLang}
            aria-label={linkLabel}
            title={small ? title : undefined}
            onClick={onClick}
            className={
              small
                ? 'absolute inset-0 z-[1] outline-none'
                : "line-clamp-2 text-sm font-semibold wrap-anywhere outline-none after:absolute after:inset-0 after:content-['']"
            }
          >
            {small ? <span className="sr-only">{title}</span> : title}
          </Link>
        )}
        {!small && (meta ?? secondary) != null && (
          <div className="line-clamp-1 text-xs text-muted-foreground">{meta ?? secondary}</div>
        )}
        {(state != null || menu != null) && (
          <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {menu != null && !small && !selectable && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="relative z-10 shrink-0"
                      aria-label={menuLabel ?? `More actions for ${title}`}
                    />
                  }
                >
                  <EllipsisIcon aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent>{menu}</DropdownMenuContent>
              </DropdownMenu>
            )}
            {state != null && <div className="min-w-0 flex-1">{state}</div>}
          </div>
        )}
      </div>
    </article>
  );
}

/** A responsive subject grid; shadcn does not provide this layout. */
const densityClasses: Record<CoverDensity, string> = {
  small:
    'grid-cols-4 @min-[640px]:grid-cols-6 @min-[1024px]:grid-cols-8 @min-[1280px]:grid-cols-10 @min-[1536px]:grid-cols-12',
  medium:
    'grid-cols-3 @min-[640px]:grid-cols-4 @min-[1024px]:grid-cols-6 @min-[1280px]:grid-cols-7 @min-[1536px]:grid-cols-8',
  large:
    'grid-cols-2 @min-[640px]:grid-cols-3 @min-[1024px]:grid-cols-4 @min-[1280px]:grid-cols-5 @min-[1536px]:grid-cols-6',
};

export function CoverGrid({
  ratio,
  density,
  children,
}: {
  ratio: CoverRatio;
  density?: CoverDensity;
  children: ReactNode;
}) {
  return (
    <RatioContext.Provider value={ratio}>
      <DensityContext.Provider value={density}>
        <div className="@container">
          <div
            className={`grid gap-4 ${density ? densityClasses[density] : 'grid-cols-2 @min-[30rem]:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]'}`}
          >
            {children}
          </div>
        </div>
      </DensityContext.Provider>
    </RatioContext.Provider>
  );
}

/** A keyboard-reachable, snapping subject row; shadcn does not provide this layout. */
export function CoverRow({ ratio, label, children }: { ratio: CoverRatio; label: string; children: ReactNode }) {
  return (
    <RatioContext.Provider value={ratio}>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto rounded-lg focus-visible:outline-2 focus-visible:outline-ring [&>*]:w-[7.5rem] [&>*]:shrink-0 [&>*]:snap-start"
      >
        {children}
      </div>
    </RatioContext.Provider>
  );
}
