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
import { Menu, type MenuEntry } from './menu.tsx';
import { Cover, coverRadius, listPresentationForCover, type CoverProps, type CoverRatio } from './cover.tsx';
import { coverWidths, defaultCoverRatio, ratioValue } from './cover-model.ts';
import { ContentItemFrame, ContentItemHeading, ContentItemTitleLink } from './content-item.tsx';
import { independentControlsClassName } from './content-interaction.ts';
import { ListRowControl } from './list-row.tsx';
import { ProgressRow } from './progress-row.tsx';

export type CoverDensity = 'small' | 'medium' | 'large';
const densityCoverSizes = { small: 'sm', medium: 'md', large: 'lg' } as const;
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
  'aria-label'?: string | undefined;
  className?: string | undefined;
  'data-slot'?: string | undefined;
  children: ReactNode;
}>;

export interface CoverCardProps {
  /** Omit for a card with no destination: its title is then plain text. */
  href?: string;
  /** The component that draws the title link, an anchor by default; a site passes its client-side router link. */
  link?: CoverCardLink;
  cover: Omit<CoverProps, 'size' | 'maxBlockSize'>;
  title: string;
  titleLang?: string;
  /** The link's accessible name when it says more than the title does ("Continue <title>"); it must contain the title. */
  linkLabel?: string;
  secondary?: ReactNode;
  state?: ReactNode;
  /** Replaces `state` with the card's progress row; a null value keeps the position label without a bar. */
  progress?: { value: number | null; label: string };
  menu?: ReactNode;
  menuEntries?: MenuEntry[];
  /** A caller-managed trigger placed at the end of the last row. */
  menuTrigger?: ReactNode;
  menuLabel?: string;
  /** Image-frame scale, inherited from its grid or row; medium by default. Large is an explicit opt-in. */
  density?: CoverDensity;
  status?: { label: string; href?: string };
  badge?: ReactNode;
  meta?: ReactNode;
  /** Essential statement metadata: a wrapping credit row with a compact cover and independent links. */
  essentialCredit?: ReactNode;
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
  progress,
  menu,
  menuEntries,
  menuTrigger,
  menuLabel,
  density: densityProp,
  status,
  badge,
  meta,
  essentialCredit,
  selectable = false,
  selected = false,
  onSelectedChange,
  onSelect,
  onPointerDown,
  onClick,
}: CoverCardProps) {
  const ratio = useContext(RatioContext);
  const contextDensity = useContext(DensityContext);
  const density = densityProp ?? contextDensity ?? 'medium';
  const small = density === 'small';
  const maxBlockSize = coverWidths[densityCoverSizes[density]] / ratioValue(defaultCoverRatio);
  const listPresentation = listPresentationForCover(cover.subject, cover.listPresentation);
  const Link = link ?? 'a';
  const credit = essentialCredit != null;
  const secondaryContent = meta ?? secondary;
  const titleClass = credit
    ? 'block text-base leading-snug font-semibold wrap-anywhere'
    : 'block text-center text-xs leading-snug font-semibold wrap-anywhere';
  const image = (
    <Cover
      {...cover}
      size="fill"
      maxBlockSize={maxBlockSize}
      {...(listPresentation ? { listPresentation } : {})}
      {...(ratio ? { ratio } : {})}
      decorative
      frameClassName="bg-transparent ring-0"
      className={`w-full self-center ${independentControlsClassName}`}
    />
  );
  const actions =
    menu != null || menuEntries != null || menuTrigger != null ? (
      <span
        data-slot="cover-card-actions"
        className="relative z-20 flex min-h-11 min-w-11 shrink-0 items-center justify-center [&_a]:min-h-11 [&_a]:min-w-11 [&_button]:min-h-11 [&_button]:min-w-11"
      >
        {menuTrigger ?? (
          <Menu
            title={menuLabel ?? `More actions for ${title}`}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="min-h-11 min-w-11 shrink-0"
                aria-label={menuLabel ?? `More actions for ${title}`}
              >
                <EllipsisIcon aria-hidden />
              </Button>
            }
            content={menu}
            entries={menuEntries}
          />
        )}
      </span>
    ) : null;
  // Cover tiles keep the focus ring while suppressing ListRow's hover fill.
  return (
    <ContentItemFrame
      as="article"
      onPointerDown={onPointerDown}
      data-slot="cover-card"
      className={`before:bg-transparent flex min-w-0 text-foreground focus-within:ring-2 focus-within:ring-ring ${credit ? 'items-start gap-4' : 'h-full flex-col'}`}
    >
      {credit ? (
        <div
          className={
            listPresentation?.imageAspect === 'landscape' ? 'w-24 shrink-0 sm:w-32' : 'w-[72px] shrink-0 sm:w-24'
          }
        >
          {image}
        </div>
      ) : (
        image
      )}
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
          {onSelect && (
            <button
              type="button"
              role="checkbox"
              aria-checked="false"
              aria-label={title}
              data-shelf-select
              onClick={onSelect}
              className="absolute top-0 left-0 z-20 flex size-11 items-start justify-start rounded-sm opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span aria-hidden className="mt-2 ml-2 size-5 rounded border bg-background" />
            </button>
          )}
        </>
      )}
      {badge != null && <div className="pointer-events-none absolute top-2 right-2 z-10">{badge}</div>}
      <div data-slot="cover-card-text" className={`flex min-w-0 flex-1 flex-col ${credit ? 'gap-2' : 'gap-1 p-2'}`}>
        <ContentItemHeading
          level={3}
          lang={titleLang}
          data-slot={selectable || href === undefined ? 'cover-card-title' : undefined}
          className={selectable || href === undefined ? titleClass : 'min-w-0'}
        >
          {selectable || href === undefined ? (
            title
          ) : (
            <ContentItemTitleLink
              as={Link}
              href={href}
              lang={titleLang}
              aria-label={linkLabel}
              title={small ? title : undefined}
              onClick={onClick}
              data-slot="cover-card-title"
              className={`${titleClass} outline-none ${credit ? 'underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring' : ''}`}
            >
              {title}
            </ContentItemTitleLink>
          )}
        </ContentItemHeading>
        {secondaryContent != null && (
          <div
            data-slot="cover-card-secondary"
            className={`min-w-0 text-center text-[11px] leading-4 text-muted-foreground whitespace-normal wrap-anywhere ${independentControlsClassName}`}
          >
            {secondaryContent}
          </div>
        )}
        {credit && (
          <ListRowControl className="z-20">
            <div
              data-slot="cover-card-essential-credit"
              className={`min-w-0 whitespace-normal text-sm leading-6 wrap-anywhere ${independentControlsClassName}`}
            >
              {essentialCredit}
            </div>
          </ListRowControl>
        )}
        {status != null && (
          <ListRowControl className="z-20">
            <div data-slot="cover-card-status-row" className="flex min-w-0 justify-center pt-0.5">
              {status.href !== undefined ? (
                <a
                  href={status.href}
                  aria-label={status.label}
                  data-slot="cover-card-status"
                  className="relative z-20 inline-flex min-h-11 min-w-11 max-w-full items-center justify-center whitespace-normal rounded-sm bg-muted px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground wrap-anywhere outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {status.label}
                </a>
              ) : (
                <span
                  aria-label={status.label}
                  data-slot="cover-card-status"
                  className="block min-w-0 max-w-full whitespace-normal rounded-sm bg-muted px-1.5 py-0.5 text-[10px] leading-4 text-muted-foreground wrap-anywhere"
                >
                  {status.label}
                </span>
              )}
            </div>
          </ListRowControl>
        )}
      </div>
      {(progress != null || state != null || actions != null) && (
        <div
          data-slot="cover-card-actions-row"
          className="mt-auto flex min-w-0 flex-wrap items-center justify-between gap-1 pt-0.5 pb-2 text-xs text-muted-foreground"
        >
          {(progress != null || state != null) && (
            <div data-slot="cover-card-state" className="min-w-0 flex-1 basis-20 pt-0.5 wrap-anywhere">
              <div data-slot="cover-card-state-content" className={independentControlsClassName}>
                {progress != null ? <ProgressRow value={progress.value} label={progress.label} /> : state}
              </div>
            </div>
          )}
          {actions != null && <div className="ml-auto">{actions}</div>}
        </div>
      )}
    </ContentItemFrame>
  );
}

/** A responsive subject grid; shadcn does not provide this layout. */
const densityClasses: Record<CoverDensity, string> = {
  small: 'grid-cols-[repeat(auto-fill,minmax(min(100%,8rem),1fr))]',
  medium: 'grid-cols-[repeat(auto-fill,minmax(min(100%,8.75rem),1fr))]',
  large: 'grid-cols-[repeat(auto-fill,minmax(min(100%,10.5rem),1fr))]',
};
const fixedDensityClasses: Record<CoverDensity, string> = {
  small: 'grid-cols-4 sm:grid-cols-[repeat(auto-fill,6rem)]',
  medium: 'grid-cols-3 sm:grid-cols-[repeat(auto-fill,7.5rem)]',
  large: 'grid-cols-2 sm:grid-cols-[repeat(auto-fill,9rem)]',
};

export function CoverGrid({
  ratio,
  density,
  fixedDensity = false,
  children,
}: {
  ratio: CoverRatio;
  density?: CoverDensity;
  fixedDensity?: boolean;
  children: ReactNode;
}) {
  return (
    <RatioContext.Provider value={ratio}>
      <DensityContext.Provider value={density}>
        <div className="@container min-w-0">
          <div
            data-slot="cover-grid"
            className={`grid min-w-0 gap-2 ${(fixedDensity ? fixedDensityClasses : densityClasses)[density ?? 'medium']}`}
          >
            {children}
          </div>
        </div>
      </DensityContext.Provider>
    </RatioContext.Provider>
  );
}

const coverRowDensityClasses: Record<CoverDensity, string> = {
  small: '[&>*]:w-[calc((100%-1.5rem)/4)] sm:[&>*]:w-[6rem]',
  medium: '[&>*]:w-[calc((100%-1rem)/3)] sm:[&>*]:w-[7.5rem]',
  large: '[&>*]:w-[calc((100%-0.5rem)/2)] sm:[&>*]:w-[9rem]',
};

/** A keyboard-reachable, snapping subject row; shadcn does not provide this layout. */
export function CoverRow({
  ratio,
  label,
  role = 'region',
  density = 'medium',
  children,
}: {
  ratio: CoverRatio;
  label: string;
  role?: 'region' | 'group';
  density?: CoverDensity;
  children: ReactNode;
}) {
  return (
    <RatioContext.Provider value={ratio}>
      <DensityContext.Provider value={density}>
        <div
          role={role}
          aria-label={label}
          tabIndex={0}
          data-slot="cover-row"
          className={`flex min-w-0 snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain ${coverRadius} focus-visible:outline-2 focus-visible:outline-ring ${coverRowDensityClasses[density]} [&>*]:shrink-0 [&>*]:snap-start`}
        >
          {children}
        </div>
      </DensityContext.Provider>
    </RatioContext.Provider>
  );
}
