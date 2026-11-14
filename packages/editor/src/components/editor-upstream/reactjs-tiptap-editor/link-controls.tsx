'use client';

// Adapted from src/extensions/Link/components/{LinkEditBlock,LinkViewBlock}.tsx; see README.md and LICENSE.
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import { ExternalLink, Link, Pencil, Unlink } from 'lucide-react';
import { useId, useRef, type Ref } from 'react';
import type { RichTextEditorLabels } from '../../editor-labels.ts';
import { ActionButton } from './action-button.tsx';

/** The URL form edits a captured range. Annotated document text stays with the schema owner. */
export function LinkEditBlock({
  labels,
  url,
  error,
  linked,
  inputRef,
  onChange,
  onApply,
  onClear,
  onCancel,
}: {
  labels: RichTextEditorLabels;
  url: string;
  error?: string | undefined;
  linked: boolean;
  inputRef: Ref<HTMLInputElement>;
  onChange: (url: string) => void;
  onApply: () => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const composing = useRef(false);
  return (
    <form
      className="grid min-w-0 gap-3 p-1"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!composing.current) onApply();
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${id}-url`}>{labels.url}</FieldLabel>
        <div dir="ltr" className="relative min-w-0">
          <Link
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
          />
          <Input
            id={`${id}-url`}
            ref={inputRef}
            dir="ltr"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-full min-w-0 ps-9 text-foreground"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
            value={url}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
        {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      </Field>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {linked ? (
          <Button type="button" variant="ghost" onClick={onClear}>
            {labels.unlink}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onCancel}>
          {labels.cancel}
        </Button>
        <Button type="submit" variant="secondary">
          {labels.apply}
        </Button>
      </div>
    </form>
  );
}

/** Upstream open/edit/unlink composition; URL validation and exact-range admission stay in the adapter. */
export function LinkViewBlock({
  labels,
  href,
  isCurrent,
  onEdit,
  onClear,
}: {
  labels: RichTextEditorLabels;
  href: string | undefined;
  isCurrent: () => boolean;
  onEdit: () => void;
  onClear: () => void;
}) {
  return (
    <TooltipProvider delay={600}>
      <div className="flex min-w-0 flex-col gap-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              if (!isCurrent()) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (!isCurrent()) event.preventDefault();
            }}
            aria-label={`${labels.openLink}: ${href}`}
            className="flex min-h-11 items-start gap-2 rounded-lg p-2 text-sm text-primary underline underline-offset-2"
          >
            <ExternalLink aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-all" dir="ltr">
              {href}
            </span>
          </a>
        ) : null}
        <div className="flex flex-wrap gap-1">
          <ActionButton label={labels.editLink} icon={<Pencil aria-hidden="true" />} action={onEdit}>
            {labels.editLink}
          </ActionButton>
          <ActionButton label={labels.unlink} icon={<Unlink aria-hidden="true" />} action={onClear}>
            {labels.unlink}
          </ActionButton>
        </div>
      </div>
    </TooltipProvider>
  );
}
