import { useEffect, useId, useRef, useState } from 'react';
import {
  diagnoseText,
  TEXT_LIMITS,
  type TextDiagnostic,
  type TextDiagnosticReason,
} from '../../../../packages/search-text/src/index.ts';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { useSearchRetryWait } from './search-recovery-retry';

type Options = { locale: (typeof locales)[number] };

export function queryTextDiagnosis(diagnostic: TextDiagnostic, options: Options) {
  const messages: Record<TextDiagnosticReason, () => string> = {
    expected_operand: () => m.search_text_expected_operand({}, options),
    unexpected_close: () => m.search_text_unexpected_close({}, options),
    unclosed_group: () => m.search_text_unclosed_group({}, options),
    unclosed_phrase: () => m.search_text_unclosed_phrase({}, options),
    unsupported_escape: () => m.search_text_unsupported_escape({}, options),
    empty_phrase: () => m.search_text_empty_phrase({}, options),
    negated_operand: () => m.search_text_negated_operand({}, options),
    byte_limit: () => m.search_text_byte_limit({ maximum: TEXT_LIMITS.bytes }, options),
    depth_limit: () => m.search_text_depth_limit({ maximum: TEXT_LIMITS.depth }, options),
    leaf_limit: () => m.search_text_leaf_limit({ maximum: TEXT_LIMITS.leaves }, options),
    phrase_token_limit: () => m.search_text_phrase_token_limit({ maximum: TEXT_LIMITS.phraseTokens }, options),
  };
  return messages[diagnostic.reason]();
}

/** This editor owns only text. Its parent reapplies the complete retained request explicitly. */
export function QueryTextRecovery({
  value,
  diagnostic,
  locale = 'en',
  retryAt,
  control = 'textarea',
  controlId,
  compact = false,
  label,
  applyLabel,
  onApply,
}: {
  value: string;
  diagnostic?: TextDiagnostic | undefined;
  locale?: string | undefined;
  retryAt?: number | undefined;
  control?: 'search' | 'textarea';
  controlId?: string | undefined;
  compact?: boolean;
  label?: string | undefined;
  applyLabel?: string | undefined;
  onApply: (value: string) => void;
}) {
  const options: Options = { locale: locales.find((tag) => tag === locale) ?? 'en' };
  const id = useId();
  const inputId = controlId ?? `${id}-input`;
  const [draft, setDraft] = useState(value);
  const [failure, setFailure] = useState(diagnostic ? { query: value, diagnostic } : undefined);
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const frame = useRef<number | undefined>(undefined);
  const waiting = useSearchRetryWait(retryAt);
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const issue = failure?.query === draft ? failure.diagnostic : undefined;
  return (
    <section
      className={compact ? 'w-full space-y-2' : 'space-y-4 rounded-xl border p-4'}
      aria-labelledby={`${id}-title`}
      data-query-text-recovery
    >
      <h2 id={`${id}-title`} className={compact ? 'sr-only' : 'font-medium'}>
        {m.search_input_recovery_title({}, options)}
      </h2>
      <form
        className={compact ? 'flex w-full flex-wrap items-start gap-2' : 'space-y-3'}
        onSubmit={(event) => {
          event.preventDefault();
          if (waiting) return;
          if (frame.current !== undefined) cancelAnimationFrame(frame.current);
          const next = draft === '' ? undefined : diagnoseText(draft);
          if (!next) {
            setFailure(undefined);
            onApply(draft);
            return;
          }
          setFailure({ query: draft, diagnostic: next });
          const form = event.currentTarget;
          const source = form.ownerDocument.activeElement;
          if (!source || !form.contains(source)) return;
          const submitted = draft;
          frame.current = requestAnimationFrame(() => {
            frame.current = undefined;
            if (currentDraft.current !== submitted || !form.isConnected || form.ownerDocument.activeElement !== source)
              return;
            const control = input.current ?? textarea.current;
            control?.focus();
            control?.setSelectionRange(next.start, next.end);
          });
        }}
      >
        <label htmlFor={inputId} className={compact ? 'sr-only' : 'block text-sm font-medium'}>
          {label ?? m.search_text_label({}, options)}
        </label>
        {control === 'search' ? (
          <input
            ref={input}
            id={inputId}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="search"
            value={draft}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            aria-invalid={issue ? true : undefined}
            aria-describedby={`${id}-help${issue ? ` ${id}-error` : ''}`}
            onChange={(event) => {
              if (frame.current !== undefined) cancelAnimationFrame(frame.current);
              frame.current = undefined;
              setDraft(event.currentTarget.value);
            }}
          />
        ) : (
          <textarea
            ref={textarea}
            id={inputId}
            value={draft}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={issue ? true : undefined}
            aria-describedby={`${id}-help${issue ? ` ${id}-error` : ''}`}
            className="min-h-32 w-full rounded-md border bg-background p-3 text-foreground"
            onChange={(event) => {
              if (frame.current !== undefined) cancelAnimationFrame(frame.current);
              frame.current = undefined;
              setDraft(event.currentTarget.value);
            }}
          />
        )}
        {issue && (
          <p id={`${id}-error`} role="alert" className="text-sm">
            {queryTextDiagnosis(issue, options)}{' '}
            {m.search_text_position({ position: issue.codePointStart + 1 }, options)}
          </p>
        )}
        <p id={`${id}-help`} className={compact ? 'w-full text-sm text-muted-foreground' : 'text-sm text-muted-foreground'}>
          {m.search_text_grammar({}, options)}
        </p>
        <button
          type="submit"
          disabled={waiting}
          className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
        >
          {applyLabel ?? m.search_input_recovery_apply({}, options)}
        </button>
        {waiting && (
          <p role="status" className="text-sm">
            {m.search_recovery_wait({}, options)}
          </p>
        )}
      </form>
    </section>
  );
}
