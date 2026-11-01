import type { MouseEvent, ReactNode } from 'react';
import { EllipsisIcon } from 'lucide-react';
import { Button } from '../shadcn/button.tsx';
import { Menu, type MenuEntry } from './menu.tsx';
import { Cover, coverRatio, type CoverProps } from './cover.tsx';
import { ContentItem } from './content-item.tsx';
import { ListRowControl } from './list-row.tsx';
import { ProgressRow } from './progress-row.tsx';
import { Checkbox } from '../shadcn/checkbox.tsx';
import { Field } from '../shadcn/field.tsx';

export interface ShelfSelectionProps {
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onSelect?: (event: MouseEvent) => void;
}
export interface ShelfListRowProps extends ShelfSelectionProps {
  forceOverlay?: boolean;
  href: string;
  cover: Omit<CoverProps, 'size'>;
  title: string;
  titleLang?: string;
  meta?: ReactNode;
  status?: ReactNode;
  statusMenu?: ReactNode;
  statusMenuEntries?: MenuEntry[];
  progress?: { value: number | null; label: string };
  stepper?: { onStep: (delta: number) => void; decreaseLabel: string; increaseLabel: string };
  date?: ReactNode;
  menu?: ReactNode;
  menuEntries?: MenuEntry[];
  labels: { select: string; menu: string };
}
/** A shelf list landmark without separators between items. */
export function ShelfList({ children }: { children: ReactNode }) {
  return <ul>{children}</ul>;
}
/** A shelf entry whose cover determines its height; shadcn has no subject list row. */
export function ShelfListRow({
  forceOverlay = false,
  href,
  cover,
  title,
  titleLang,
  meta,
  status,
  statusMenu,
  statusMenuEntries,
  progress,
  stepper,
  date,
  menu,
  menuEntries,
  labels,
  selectable,
  selected = false,
  onSelectedChange,
  onSelect,
}: ShelfListRowProps) {
  const ratio = cover.ratio ?? coverRatio(cover.subject.types);
  const select = (event: MouseEvent) => {
    onSelectedChange?.(!selected);
    onSelect?.(event);
  };
  const chip =
    status != null &&
    (statusMenu != null || statusMenuEntries != null ? (
      <Menu
        title="Status"
        trigger={
          <Button variant="outline" size="sm">
            {status}
          </Button>
        }
        content={statusMenu}
        entries={statusMenuEntries}
      />
    ) : (
      status
    ));
  return (
    <ContentItem
      forceOverlay={forceOverlay}
      className="items-center"
      href={href}
      title={title}
      titleLang={titleLang}
      visual={
        <div className="flex shrink-0 items-center gap-3">
          {selectable && (
            <ListRowControl>
              <Field orientation="horizontal" className="w-auto">
                <Checkbox
                  aria-label={labels.select}
                  checked={selected}
                  onCheckedChange={(checked) => onSelectedChange?.(checked === true)}
                  onClick={(event) => onSelect?.(event)}
                />
              </Field>
            </ListRowControl>
          )}
          <div
            className="pointer-events-none w-[72px] shrink-0 overflow-hidden rounded sm:w-24"
            style={{ aspectRatio: ratio.replace(':', ' / ') }}
          >
            <Cover {...cover} size="fill" ratio={ratio} decorative />
          </div>
        </div>
      }
      metadata={
        meta != null && <div className="hidden truncate text-[13px] text-muted-foreground sm:block">{meta}</div>
      }
      state={
        <>
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground sm:hidden">
            {chip}
            <span className="whitespace-nowrap">{progress?.label}</span>
            <span>{date}</span>
          </div>
          {progress?.value != null && (
            <div className="mt-1 h-1 overflow-hidden rounded bg-muted sm:hidden">
              <div
                className="h-full bg-primary"
                style={{ width: `${Math.max(0, Math.min(1, progress.value)) * 100}%` }}
              />
            </div>
          )}
          <div className="hidden items-center gap-3 sm:flex">
            {chip}
            {progress && (
              <div className="w-24 text-xs">
                <ProgressRow {...progress} />
              </div>
            )}
            {stepper && (
              <div className="flex">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={stepper.decreaseLabel}
                  onClick={() => stepper.onStep(-1)}
                >
                  −
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={stepper.increaseLabel}
                  onClick={() => stepper.onStep(1)}
                >
                  +
                </Button>
              </div>
            )}
            <span className="text-xs text-muted-foreground">{date}</span>
          </div>
          {stepper && (
            <div className="flex justify-end sm:hidden">
              <ListRowControl className="flex">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={stepper.decreaseLabel}
                  onClick={() => stepper.onStep(-1)}
                >
                  −
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={stepper.increaseLabel}
                  onClick={() => stepper.onStep(1)}
                >
                  +
                </Button>
              </ListRowControl>
            </div>
          )}
        </>
      }
      trailing={
        (menu != null || menuEntries != null) && (
          <Menu
            title={labels.menu}
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={labels.menu}>
                <EllipsisIcon aria-hidden />
              </Button>
            }
            content={menu}
            entries={menuEntries}
          />
        )
      }
      onClick={
        selectable
          ? (event) => {
              const target = event.target as Element;
              if (target.closest('[data-slot="list-row-link"]')) {
                event.preventDefault();
                select(event);
                return;
              }
              if (
                !target.closest(
                  '[data-slot="list-row-control"], a, button, input, [role="checkbox"], [role="menuitem"]',
                )
              )
                select(event);
            }
          : undefined
      }
    />
  );
}
