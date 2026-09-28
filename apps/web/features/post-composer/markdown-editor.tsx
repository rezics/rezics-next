'use client';

import { Textarea } from '@rezics/ui/textarea';
import { cn } from '@rezics/ui/utils';
import { useId, useState, type KeyboardEvent } from 'react';
import { MarkdownBody } from './markdown.tsx';

export function MarkdownEditor({ label, value, onChange, maxLength, rows, readOnly = false,
  autoFocus = false, onFocus, onKeyDown, className, placeholder, disabled = false,
  editLabel, previewLabel, showSpoiler }: {
  label: string; value: string; onChange: (value: string) => void; maxLength: number; rows: number;
  readOnly?: boolean; autoFocus?: boolean; onFocus?: () => void; placeholder?: string; disabled?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void; className?: string;
  editLabel: string; previewLabel: string; showSpoiler: string;
}) {
  const id = useId();
  const [preview, setPreview] = useState(false);
  return <div className="grid gap-2">
    <div role="tablist" aria-label={label} className="flex gap-1 border-border border-b">
      {([false, true] as const).map(show => <button key={String(show)} type="button" role="tab"
        id={`${id}-${show ? 'preview' : 'edit'}`} aria-controls={`${id}-panel`} aria-selected={preview === show}
        onClick={() => setPreview(show)} className={cn('px-3 py-1.5 text-sm outline-none',
          preview === show ? 'border-primary border-b-2 font-semibold text-foreground'
            : 'text-muted-foreground hover:text-foreground', 'focus-visible:ring-2 focus-visible:ring-ring')}>
        {show ? previewLabel : editLabel}</button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${preview ? 'preview' : 'edit'}`}>
      {preview ? <div className="min-h-28 rounded-xl border border-border bg-card p-3">
        <MarkdownBody text={value} showSpoiler={showSpoiler} className="grid gap-3 text-sm/relaxed
          [overflow-wrap:anywhere]" /></div>
        : <Textarea aria-label={label} value={value} maxLength={maxLength} rows={rows}
          readOnly={readOnly} disabled={disabled} autoFocus={autoFocus} onFocus={onFocus}
          onKeyDown={onKeyDown} placeholder={placeholder}
          onChange={event => onChange(event.currentTarget.value)} className={className} />}
    </div>
  </div>;
}
