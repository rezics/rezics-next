import { useId, type ComponentType, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { cn } from '../utils.ts';
import { ListRow, ListRowControl, ListRowLink, listRowFrameClassName } from './list-row.tsx';

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

const independentInteractiveLayerClassName = cn(
  '[&_a]:relative [&_a]:z-10',
  '[&_button]:relative [&_button]:z-10',
  '[&_summary]:relative [&_summary]:z-10',
  '[&_label]:relative [&_label]:z-10',
  '[&_input]:relative [&_input]:z-10',
  '[&_select]:relative [&_select]:z-10',
  '[&_textarea]:relative [&_textarea]:z-10',
  '[&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-2 [&_a:focus-visible]:outline-ring',
  '[&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-ring',
  '[&_summary:focus-visible]:outline-2 [&_summary:focus-visible]:outline-offset-2 [&_summary:focus-visible]:outline-ring',
  '[&_input:focus-visible]:outline-2 [&_input:focus-visible]:outline-offset-2 [&_input:focus-visible]:outline-ring',
  '[&_select:focus-visible]:outline-2 [&_select:focus-visible]:outline-offset-2 [&_select:focus-visible]:outline-ring',
  '[&_textarea:focus-visible]:outline-2 [&_textarea:focus-visible]:outline-offset-2 [&_textarea:focus-visible]:outline-ring',
);

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
      className={cn('flex min-w-0 items-start gap-3 py-3 sm:gap-4 sm:py-4', className)}
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
        <div data-content-item-slot="visual" className={cn('shrink-0', independentInteractiveLayerClassName)}>
          {visual}
        </div>
      )}
      <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4">
        <div className="min-w-0">
          {hasSlot(context) && (
            <div
              data-content-item-slot="context"
              className={cn(
                'mb-2 text-[13px] leading-snug text-muted-foreground sm:text-sm',
                independentInteractiveLayerClassName,
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
            className="line-clamp-2 text-[17px] leading-snug font-semibold sm:text-lg md:text-xl sm:line-clamp-1"
          >
            {title}
          </ContentItemHeading>
          {hasSlot(metadata) && (
            <ListRowControl
              data-content-item-slot="metadata"
              className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-snug text-muted-foreground sm:text-sm"
            >
              {metadata}
            </ListRowControl>
          )}
          {hasSlot(preview) && (
            <div
              data-content-item-slot="preview"
              className={cn('mt-2 min-w-0 text-sm leading-relaxed', independentInteractiveLayerClassName)}
            >
              {preview}
            </div>
          )}
        </div>
        {hasRail && (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 sm:col-start-2 sm:row-start-1 sm:mt-0 sm:justify-end">
            {hasSlot(state) && (
              <ListRowControl
                data-content-item-slot="state"
                className={cn(
                  'min-w-0',
                  '[&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:px-2',
                  '[&_button]:min-h-11 [&_button]:min-w-11',
                )}
              >
                {state}
              </ListRowControl>
            )}
            {hasSlot(actions) && (
              <ListRowControl
                data-content-item-slot="actions"
                className={cn(
                  'flex min-h-11 flex-wrap items-center gap-2',
                  '[&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:px-2',
                  '[&_button]:min-h-11 [&_button]:min-w-11',
                )}
              >
                {actions}
              </ListRowControl>
            )}
            {hasSlot(trailing) && (
              <ListRowControl
                data-content-item-slot="trailing"
                className={cn(
                  'flex items-center gap-2',
                  '[&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:px-2',
                  '[&_button]:min-h-11 [&_button]:min-w-11',
                )}
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
