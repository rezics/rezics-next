import type { MouseEvent, ReactNode } from 'react';
import { EllipsisIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '../shadcn/button.tsx';
import { Menu, type MenuEntry } from './menu.tsx';
import { Cover, type CoverProps } from './cover.tsx';
import { independentControlSelector } from './content-interaction.ts';
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
          <Button variant="outline" size="sm" className="min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere">
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
      {...(titleLang !== undefined ? { titleLang } : {})}
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
          <div className="w-[72px] shrink-0 sm:w-24">
            <Cover {...cover} size="fill" decorative />
          </div>
        </div>
      }
      metadata={meta}
      state={
        chip != null || progress != null || stepper != null || date != null ? (
          <div
            data-slot="shelf-list-row-state"
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground"
          >
            {chip != null && (
              <div data-slot="shelf-list-row-status" className="min-w-0 max-w-full whitespace-normal wrap-anywhere">
                {chip}
              </div>
            )}
            {chip != null && progress != null && (
              <span data-slot="shelf-list-row-separator" aria-hidden="true" className="sm:hidden">
                ·
              </span>
            )}
            {progress != null && (
              <div data-slot="shelf-list-row-progress" className="w-24 min-w-0 max-w-full text-xs">
                <ProgressRow {...progress} />
              </div>
            )}
            {stepper != null && (
              <div data-slot="shelf-list-row-stepper" className="flex shrink-0">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={stepper.decreaseLabel}
                  onClick={() => stepper.onStep(-1)}
                  className="min-h-11 min-w-11"
                >
                  <MinusIcon aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={stepper.increaseLabel}
                  onClick={() => stepper.onStep(1)}
                  className="min-h-11 min-w-11"
                >
                  <PlusIcon aria-hidden />
                </Button>
              </div>
            )}
            {date != null && (
              <span
                data-slot="shelf-list-row-date"
                className="min-w-0 max-w-full whitespace-normal text-xs text-muted-foreground wrap-anywhere"
              >
                {date}
              </span>
            )}
          </div>
        ) : undefined
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
              if (!target.closest(`[data-slot="list-row-control"], ${independentControlSelector}`)) select(event);
            }
          : undefined
      }
    />
  );
}
