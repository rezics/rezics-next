import { m } from '../../paraglide/messages.js';

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
    <button
      id={controlId}
      type="button"
      aria-pressed={selected}
      aria-controls={controls}
      aria-label={m.library_copy_compare_select_named({ position, title })}
      disabled={disabled}
      onClick={(event) => onSelect(event.currentTarget)}
      className="inline-flex min-h-11 min-w-11 max-w-full cursor-pointer items-center justify-center rounded-lg border border-border px-3 py-2 text-center text-sm whitespace-normal [overflow-wrap:anywhere] hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60"
    >
      {selected ? m.library_copy_compare_selected() : m.library_copy_compare_select()}
    </button>
  );
}
