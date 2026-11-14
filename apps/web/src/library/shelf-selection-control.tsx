import type { ShelfSelectionProps } from '@rezics/ui/shelf-list';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field } from '@rezics/ui/shadcn/field';

/** A shelf-owned selection control that leaves the shared row and card navigation mode untouched. */
export function ShelfSelectionControl({
  label,
  selection,
  className,
}: {
  label: string;
  selection?: ShelfSelectionProps;
  className?: string;
}) {
  if (
    !selection ||
    (!selection.selectable && !selection.onSelect && !selection.onSelectedChange)
  )
    return null;

  return (
    <Field orientation="horizontal" className={className ?? 'w-auto'}>
      <Checkbox
        aria-label={label}
        checked={!!selection.selected}
        onCheckedChange={(checked) => selection.onSelectedChange?.(checked === true)}
        onClick={(event) => {
          event.stopPropagation();
          selection.onSelect?.(event);
        }}
      />
    </Field>
  );
}
