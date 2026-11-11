import { useId, type ComponentType, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { cn } from '../utils.ts';
import { ListRow, ListRowControl, ListRowLink, listRowFrameClassName } from './list-row.tsx';
import { independentControlsClassName } from './content-interaction.ts';

export type ContentItemHeadingLevel = 2 | 3 | 4;

/** A shared semantic heading for row and tile titles. */
export interface ContentItemHeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  level?: ContentItemHeadingLevel;
}

export function ContentItemHeading({ level = 2, ...props }: ContentItemHeadingProps) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  return <Heading {...props} data-content-item-slot="title" />;
}

type ContentItemLinkProps = {
  href: string;
  lang?: string | undefined;
  title?: string | undefined;
  'aria-label'?: string | undefined;
  onClick?: ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  className?: string | undefined;
  'data-slot'?: string | undefined;
  children: ReactNode;
};

export type ContentItemLinkComponent = 'a' | ComponentType<ContentItemLinkProps>;

/** A real primary title link; tile mode stretches its hit area without wrapping any controls. */
export interface ContentItemTitleLinkProps extends ContentItemLinkProps {
  as?: ContentItemLinkComponent;
  stretch?: boolean;
}

export function ContentItemTitleLink({
  as: Link = 'a',
  stretch = true,
  className,
  ...props
}: ContentItemTitleLinkProps) {
  return (
    <Link
      {...props}
      className={cn(stretch && "after:absolute after:inset-0 after:z-[1] after:content-['']", className)}
    />
  );
}

/** A ContentItem frame can use article semantics in a tile while sharing the list-row interaction surface. */
export interface ContentItemFrameProps extends HTMLAttributes<HTMLElement> {
  as?: 'article' | 'div';
  forceOverlay?: boolean;
}

export function ContentItemFrame({
  as: Frame = 'article',
  forceOverlay = false,
  className,
  ...props
}: ContentItemFrameProps) {
  return (
    <Frame
      {...props}
      data-overlay={forceOverlay ? 'visible' : undefined}
      className={cn(listRowFrameClassName, className)}
    />
  );
}

export interface ContentItemProps extends Omit<HTMLAttributes<HTMLLIElement>, 'title' | 'children'> {
  title: string;
  href?: string;
  /** Optional exact accessible name for the primary link when its supplied summary needs more context. */
  primaryLinkLabel?: string;
  titleLang?: string;
  /** Optional adapter selector on the visible heading. */
  titleDataSlot?: string;
  headingLevel?: ContentItemHeadingLevel;
  visual?: ReactNode;
  context?: ReactNode;
  metadata?: ReactNode;
  preview?: ReactNode;
  state?: ReactNode;
  actions?: ReactNode;
  trailing?: ReactNode;
  forceOverlay?: boolean;
}

function hasSlot(value: ReactNode): boolean {
  return value !== null && value !== undefined && typeof value !== 'boolean';
}

/** A semantic content-list item built on the shared hover, focus and press behavior. */
export function ContentItem({
  title,
  href,
  primaryLinkLabel,
  titleLang,
  titleDataSlot,
  headingLevel = 2,
  visual,
  context,
  metadata,
  preview,
  state,
  actions,
  trailing,
  forceOverlay = false,
  className,
  ...liProps
}: ContentItemProps) {
  const titleId = useId();
  const hasRail = hasSlot(state) || hasSlot(actions) || hasSlot(trailing);
  const hasPrimaryLinkLabel = primaryLinkLabel !== undefined && primaryLinkLabel.trim() !== '';

  return (
    <ListRow
      {...liProps}
      forceOverlay={forceOverlay}
      className={cn('@container/content-item flex min-w-0 items-start gap-3 py-3 sm:gap-4 sm:py-4', className)}
    >
      {href !== undefined && (
        <ListRowLink
          href={href}
          lang={titleLang}
          aria-label={hasPrimaryLinkLabel ? primaryLinkLabel : undefined}
          aria-labelledby={hasPrimaryLinkLabel ? undefined : titleId}
        >
          {title}
        </ListRowLink>
      )}
      {hasSlot(visual) && (
        <div data-content-item-slot="visual" className={cn('shrink-0', independentControlsClassName)}>
          {visual}
        </div>
      )}
      <div
        className={cn(
          'min-w-0 flex-1 wrap-anywhere',
          hasRail &&
            '@min-[40rem]/content-item:grid @min-[40rem]/content-item:grid-cols-[minmax(0,1fr)_fit-content(40%)] @min-[40rem]/content-item:items-start @min-[40rem]/content-item:gap-x-4',
        )}
      >
        <div className="min-w-0">
          {hasSlot(context) && (
            <div
              data-content-item-slot="context"
              className={cn(
                'mb-2 min-w-0 whitespace-normal text-[13px] leading-snug text-muted-foreground sm:text-sm',
                independentControlsClassName,
              )}
            >
              {context}
            </div>
          )}
          <ContentItemHeading
            level={headingLevel}
            id={titleId}
            lang={titleLang}
            data-slot={titleDataSlot}
            className="whitespace-normal text-[17px] leading-snug font-semibold wrap-anywhere sm:text-lg md:text-xl"
          >
            {title}
          </ContentItemHeading>
          {hasSlot(metadata) && (
            <div
              data-content-item-slot="metadata"
              className={cn(
                'mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal text-[13px] leading-snug text-muted-foreground sm:text-sm [&>*]:min-w-0 [&>*]:max-w-full',
                independentControlsClassName,
              )}
            >
              {metadata}
            </div>
          )}
          {hasSlot(preview) && (
            <div
              data-content-item-slot="preview"
              className={cn('mt-2 min-w-0 text-sm leading-relaxed', independentControlsClassName)}
            >
              {preview}
            </div>
          )}
        </div>
        {hasRail && (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 @min-[40rem]/content-item:col-start-2 @min-[40rem]/content-item:row-start-1 @min-[40rem]/content-item:mt-0 @min-[40rem]/content-item:justify-end [&>*]:max-w-full">
            {hasSlot(state) && (
              <ListRowControl
                data-content-item-slot="state"
                className={cn('min-w-0 whitespace-normal', independentControlsClassName)}
              >
                {state}
              </ListRowControl>
            )}
            {hasSlot(actions) && (
              <ListRowControl
                data-content-item-slot="actions"
                className={cn('flex min-h-11 min-w-0 flex-wrap items-center gap-2', independentControlsClassName)}
              >
                {actions}
              </ListRowControl>
            )}
            {hasSlot(trailing) && (
              <ListRowControl
                data-content-item-slot="trailing"
                className={cn('flex min-w-0 flex-wrap items-center gap-2', independentControlsClassName)}
              >
                {trailing}
              </ListRowControl>
            )}
          </div>
        )}
      </div>
    </ListRow>
  );
}
