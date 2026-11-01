import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

/** Keep keyboard navigation in the terms editor when a removable row disappears. */
export function CreateSubjectLanguageRemove({
  locale,
  rowId,
  focusId,
  disabled,
  onRemove,
}: {
  locale: string;
  rowId: string;
  focusId: string;
  disabled: boolean;
  onRemove: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-auto min-h-11 max-w-full justify-self-start whitespace-normal"
      aria-controls={rowId}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onRemove();
        document.getElementById(focusId)?.focus();
      }}
    >
      {m.catalogue_create_remove_language({}, { locale: locale as never })}
    </Button>
  );
}
