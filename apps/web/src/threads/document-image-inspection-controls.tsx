import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { DocumentImageInspectionMode, DocumentImageInspectionVariant } from './document-image-inspection';

export function DocumentImageInspectionControls({
  mode,
  variant,
  locale,
  onModeChange,
}: {
  mode: DocumentImageInspectionMode;
  variant: DocumentImageInspectionVariant;
  locale: string;
  onModeChange: (mode: DocumentImageInspectionMode) => void;
}) {
  const options = { locale: locale as never };
  const state =
    mode === 'fit'
      ? m.document_image_inspection_fit_state({}, options)
      : m.document_image_inspection_actual_state({}, options);
  return (
    <div className="min-w-0 space-y-1">
      <div role="group" aria-label={m.document_image_inspection_title({}, options)} className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === 'fit' ? 'default' : 'outline'}
          aria-pressed={mode === 'fit'}
          onClick={() => onModeChange('fit')}
        >
          {m.document_image_inspection_fit({}, options)}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === 'actual' ? 'default' : 'outline'}
          aria-pressed={mode === 'actual'}
          onClick={() => onModeChange('actual')}
        >
          {m.document_image_inspection_actual({}, options)}
        </Button>
      </div>
      <p role="status" className="min-w-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        {state} · {m.document_image_inspection_size({ width: variant.width, height: variant.height }, options)}
      </p>
    </div>
  );
}
