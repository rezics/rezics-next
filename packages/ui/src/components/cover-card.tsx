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
  'data-slot'?: string | undefined;
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
  /** A caller-managed trigger placed at the start of the state row. */
  menuTrigger?: ReactNode;
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
  menuTrigger,
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
      data-slot="cover-card"
      className="group relative min-w-0 rounded-sm bg-white text-slate-900 outline outline-1 outline-black/10 shadow-none transition-shadow hover:shadow-sm focus-within:ring-2 focus-within:ring-ring dark:bg-white dark:text-slate-900"
    >
      <Cover
        {...cover}
        size="fill"
        {...(ratio ? { ratio } : {})}
        decorative
        caption={false}
        className="w-full [&_[data-slot=aspect-ratio]]:rounded-none [&_[data-slot=aspect-ratio]]:rounded-t-sm [&_[data-slot=aspect-ratio]]:border-0 [&_[data-slot=aspect-ratio]]:bg-transparent [&_[data-slot=aspect-ratio]]:ring-0 [&_button:not(.absolute)]:relative [&_button]:z-10"
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
      {badge != null && <div className="pointer-events-none absolute top-2 right-2 z-10">{badge}</div>}
      <div data-slot="cover-card-text" className="flex min-w-0 flex-col gap-1 p-2">
        {selectable ? (
          <span
            data-slot="cover-card-title"
            className="line-clamp-2 text-center text-xs leading-snug font-semibold wrap-anywhere"
            lang={titleLang}
          >
            {title}
          </span>
        ) : href === undefined ? (
          <div
            data-slot="cover-card-title"
            lang={titleLang}
            className="line-clamp-2 text-center text-xs leading-snug font-semibold wrap-anywhere"
          >
            {title}
          </div>
        ) : (
          <Link
            href={href}
            lang={titleLang}
            aria-label={linkLabel}
            title={small ? title : undefined}
            onClick={onClick}
            data-slot="cover-card-title"
            className="relative z-[1] line-clamp-2 text-center text-xs leading-snug font-semibold wrap-anywhere outline-none after:absolute after:inset-0 after:content-['']"
          >
            {title}
          </Link>
        )}
        {(meta ?? secondary) != null && (
          <div
            data-slot="cover-card-secondary"
            className="line-clamp-1 text-center text-[11px] leading-4 text-slate-600 dark:text-slate-600"
          >
            {meta ?? secondary}
          </div>
        )}
        {(state != null || menu != null || menuTrigger != null) && (
          <div
            data-slot="cover-card-state"
            className="flex min-w-0 items-center gap-1 pt-0.5 text-xs text-slate-600 dark:text-slate-600"
          >
            {(menu != null || menuTrigger != null) && (
              <span data-slot="cover-card-actions" className="relative z-10 flex shrink-0 items-center">
                {menuTrigger ?? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="shrink-0"
                          aria-label={menuLabel ?? `More actions for ${title}`}
                        />
                      }
                    >
                      <EllipsisIcon aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>{menu}</DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
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
  small: 'grid-cols-[repeat(auto-fill,minmax(8rem,1fr))]',
  medium: 'grid-cols-[repeat(auto-fill,minmax(8.75rem,1fr))]',
  large: 'grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))]',
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
          <div data-slot="cover-grid" className={`grid gap-2 ${densityClasses[density ?? 'medium']}`}>
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
        data-slot="cover-row"
        className="flex snap-x snap-mandatory gap-2 overflow-x-auto rounded-lg focus-visible:outline-2 focus-visible:outline-ring [&>*]:w-[7.5rem] [&>*]:shrink-0 [&>*]:snap-start"
      >
        {children}
      </div>
    </RatioContext.Provider>
  );
}
