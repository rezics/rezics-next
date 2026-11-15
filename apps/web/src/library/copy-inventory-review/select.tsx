import { m } from '../../paraglide/messages.js';
import { Button } from '@rezics/ui/shadcn/button';

/** This button lives in ContentItem's independent trailing control region. */
export function CopyInventorySelect({
  controlId,
  selected,
  disabled,
  title,
  position,
  controls,
  onSelect,
}: {
  controlId: string;
  selected: boolean;
  disabled: boolean;
  title: string;
  position: number;
  controls: string;
  onSelect: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <Button
      id={controlId}
      type="button"
      aria-pressed={selected}
      aria-controls={controls}
      aria-label={m.library_copy_compare_select_named({ position, title })}
      disabled={disabled}
      onClick={(event) => onSelect(event.currentTarget)}
      variant="outline" className="h-auto min-h-7 max-w-full whitespace-normal [overflow-wrap:anywhere]"
    >
      {selected ? m.library_copy_compare_selected() : m.library_copy_compare_select()}
    </Button>
  );
}
