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
  const state = mode === 'fit'
    ? m.document_image_inspection_fit_state({}, options)
    : m.document_image_inspection_actual_state({}, options);
  return (
    <div className="min-w-0 space-y-1">
      <div role="group" aria-label={m.document_image_inspection_title({}, options)} className="flex flex-wrap gap-2">
        <button
          type="button"
          aria-pressed={mode === 'fit'}
          onClick={() => onModeChange('fit')}
          className="min-h-11 rounded-md border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.document_image_inspection_fit({}, options)}
        </button>
        <button
          type="button"
          aria-pressed={mode === 'actual'}
          onClick={() => onModeChange('actual')}
          className="min-h-11 rounded-md border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.document_image_inspection_actual({}, options)}
        </button>
      </div>
      <p role="status" className="min-w-0 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        {state} · {m.document_image_inspection_size({ width: variant.width, height: variant.height }, options)}
      </p>
    </div>
  );
}
