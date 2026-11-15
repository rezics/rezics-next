'use client';

// Adapted from src/extensions/Link/components/{LinkEditBlock,LinkViewBlock}.tsx; see README.md and LICENSE.
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@rezics/ui/shadcn/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@rezics/ui/shadcn/input-group';
import { TooltipProvider } from '@rezics/ui/shadcn/tooltip';
import { ExternalLink, Link, Pencil, Unlink } from 'lucide-react';
import { useId, useRef, type Ref } from 'react';
import type { RichTextEditorLabels } from '../../editor-labels.ts';
import { ActionButton } from './action-button.tsx';

const wrappingAction = 'h-auto min-h-7 max-w-full min-w-0 shrink whitespace-normal text-start';
const wrappingViewAction = 'h-auto min-h-7 max-w-full shrink whitespace-normal text-start';

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
    <div
      className="min-w-0 w-full p-1"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return;
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          event.stopPropagation();
          onApply();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <FieldGroup className="gap-3">
        <Field data-invalid={Boolean(error)}>
          <FieldLabel htmlFor={`${id}-url`} className="max-w-full min-w-0 flex-wrap text-wrap">
            {labels.url}
          </FieldLabel>
          <InputGroup dir="ltr" className="min-w-0">
            <InputGroupAddon align="inline-start">
              <Link aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id={`${id}-url`}
              ref={inputRef}
              dir="ltr"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 text-foreground"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? `${id}-error` : undefined}
              value={url}
              onChange={(event) => onChange(event.target.value)}
            />
          </InputGroup>
          {error ? (
            <FieldError id={`${id}-error`} className="min-w-0 text-wrap break-words">
              {error}
            </FieldError>
          ) : null}
        </Field>
        <Field orientation="horizontal" className="flex-wrap items-center justify-end">
          {linked ? (
            <Button type="button" variant="ghost" className={wrappingAction} onClick={onClear}>
              {labels.unlink}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" className={wrappingAction} onClick={onCancel}>
            {labels.cancel}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className={wrappingAction}
            onClick={() => {
              if (!composing.current) onApply();
            }}
          >
            {labels.apply}
          </Button>
        </Field>
      </FieldGroup>
    </div>
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
      <div className="flex min-w-0 w-full flex-col gap-2">
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
            className="flex min-w-0 items-start gap-2 text-sm text-primary underline underline-offset-2"
          >
            <ExternalLink aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-all" dir="ltr">
              {href}
            </span>
          </a>
        ) : null}
        <div className="flex min-w-0 w-full flex-wrap items-center gap-1">
          <ActionButton
            label={labels.editLink}
            icon={<Pencil aria-hidden="true" />}
            action={onEdit}
            className={wrappingViewAction}
          >
            {labels.editLink}
          </ActionButton>
          <ActionButton
            label={labels.unlink}
            icon={<Unlink aria-hidden="true" />}
            action={onClear}
            className={wrappingViewAction}
          >
            {labels.unlink}
          </ActionButton>
        </div>
      </div>
    </TooltipProvider>
  );
}
