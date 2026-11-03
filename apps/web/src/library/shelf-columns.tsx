import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useNavigate } from '@tanstack/react-router';
import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import { shelfColumnIds, shelfColumns, type ShelfSearch, type PersonalShelfColumnId } from './shelf-params';

export function shelfColumnLabel(id: PersonalShelfColumnId): string {
  switch (id) {
    case 'cover':
      return m.library_column_cover();
    case 'title':
      return m.library_column_title();
    case 'type':
      return m.library_column_type();
    case 'status':
      return m.library_column_status();
    case 'progress':
      return m.library_entry_progress();
    case 'added':
      return m.library_sort_created();
    case 'finished':
      return m.library_sort_finished();
    case 'lastActivity':
      return m.library_sort_activity();
  }
}

/** The personal table's existing fields, using the same display URL as layout and size. */
export function ShelfColumnsControl({
  value,
  disabled,
  view,
  isCurrent,
}: {
  value?: string;
  disabled: boolean;
  view: ShelfSearch;
  isCurrent?: () => boolean;
}) {
  const navigate = useNavigate();
  const id = useId();
  const chosen = (shelfColumns(value) ?? shelfColumnIds.join(',')).split(',');
  const change = (columns: string | undefined) => {
    if (disabled || !(isCurrent?.() ?? true)) return;
    const { columns: _columns, ...rest } = view;
    void navigate({ to: '/library', search: { ...rest, ...(columns ? { columns } : {}) } });
  };
  return (
    <Menu
      title={m.library_columns()}
      backLabel={m.library_menu_back()}
      trigger={
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          {m.library_columns()}
        </Button>
      }
      content={
        <div className="space-y-3 p-1">
          <p id={`${id}-required`} className="text-xs text-muted-foreground">
            {m.library_columns_title_required()}
          </p>
          {shelfColumnIds.map((column) => (
            <Field key={column} orientation="horizontal">
              <Checkbox
                id={`${id}-${column}`}
                checked={chosen.includes(column)}
                disabled={column === 'title'}
                aria-describedby={column === 'title' ? `${id}-required` : undefined}
                onCheckedChange={(checked) =>
                  change(
                    shelfColumns(
                      shelfColumnIds
                        .filter(
                          (field) =>
                            field === 'title' || (field === column ? checked === true : chosen.includes(field)),
                        )
                        .join(','),
                    ),
                  )
                }
              />
              <FieldLabel htmlFor={`${id}-${column}`}>{shelfColumnLabel(column)}</FieldLabel>
            </Field>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto whitespace-normal"
            onClick={() => change(undefined)}
          >
            {m.library_columns_reset()}
          </Button>
        </div>
      }
    />
  );
}
