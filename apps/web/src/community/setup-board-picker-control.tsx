import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { m } from '../paraglide/messages.js';
import type { SetupChoice } from './space-setup';
import {
  BoardChoicePager,
  type BoardChoicePage,
  type BoardChoiceScope,
  type BoardChoiceSource,
} from './setup-board-picker';

export function SetupBoardPicker({
  kind,
  schemeId = '',
  source,
  value,
  onChange,
  disabled,
}: {
  kind: 'scheme' | 'concept';
  schemeId?: string;
  source: BoardChoiceSource;
  value: SetupChoice | null;
  onChange(value: SetupChoice | null): void;
  disabled: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<BoardChoicePage>({ status: 'loading', choices: [], next: null });
  const pager = useMemo(() => new BoardChoicePager(setPage), []);
  const resultRegion = useRef<HTMLDivElement>(null);
  const keyboardPosition = useRef<(BoardChoiceScope & { version: number }) | null>(null);
  const keyboardPositionCleanup = useRef<(() => void) | null>(null);
  const cancelKeyboardPosition = useCallback(() => {
    keyboardPosition.current = null;
    keyboardPositionCleanup.current?.();
    keyboardPositionCleanup.current = null;
  }, []);
  const scope: BoardChoiceScope = { source, query, schemeId, kind };
  const expected = { ...scope, version: pager.version() };
  // Mask a previous source/query immediately, before the new effect has started.
  const [loadedScope, setLoadedScope] = useState<{
    source: BoardChoiceSource;
    query: string;
    schemeId: string;
    kind: string;
  } | null>(null);
  const current =
    loadedScope?.source === source &&
    loadedScope.query === query &&
    loadedScope.schemeId === schemeId &&
    loadedScope.kind === kind;
  useLayoutEffect(() => {
    setLoadedScope({ source, query, schemeId, kind });
    if (!disabled) pager.search({ source, kind, schemeId, query });
    else pager.cancel();
  }, [pager, source, kind, schemeId, query, disabled]);
  useLayoutEffect(
    () => () => {
      cancelKeyboardPosition();
      pager.cancel();
    },
    [cancelKeyboardPosition, pager],
  );
  useLayoutEffect(() => {
    const pending = keyboardPosition.current;
    if (!pending) return;
    if (
      disabled ||
      !current ||
      pending.source !== source ||
      pending.kind !== kind ||
      pending.schemeId !== schemeId ||
      pending.query !== query ||
      pending.version !== pager.version()
    ) {
      cancelKeyboardPosition();
      return;
    }
    if (page.status !== 'loading') {
      cancelKeyboardPosition();
      resultRegion.current?.focus();
    }
  }, [cancelKeyboardPosition, current, disabled, kind, page, pager, query, schemeId, source]);
  const shown: BoardChoicePage = current ? page : { status: 'loading', choices: [], next: null };
  const label = kind === 'scheme' ? m.space_setup_scheme_label() : m.space_setup_concept_label();
  const pageAction = (detail: number, accepted: boolean, action: () => void) => {
    cancelKeyboardPosition();
    const pending =
      detail === 0 && accepted && pager.version() === expected.version ? { ...scope, version: expected.version } : null;
    keyboardPosition.current = pending;
    if (pending) {
      document.addEventListener('focusin', cancelKeyboardPosition, true);
      document.addEventListener('pointerdown', cancelKeyboardPosition, true);
      keyboardPositionCleanup.current = () => {
        document.removeEventListener('focusin', cancelKeyboardPosition, true);
        document.removeEventListener('pointerdown', cancelKeyboardPosition, true);
      };
    }
    action();
    if (pending) pending.version = pager.version();
  };
  return (
    <Field className="min-w-0 text-start [overflow-wrap:anywhere]">
      <FieldLabel htmlFor={id} className="min-w-0 max-w-full whitespace-normal text-start">
        {label}
      </FieldLabel>
      <FieldDescription id={`${id}-hint`} className="min-w-0 text-start leading-relaxed">
        {kind === 'scheme' ? m.space_setup_board_scheme_choices_hint() : m.space_setup_concept_hint()}
        {kind === 'concept' && source.conceptQuery === 'loaded-page'
          ? ` ${m.space_setup_board_choice_local_hint()}`
          : ''}
      </FieldDescription>
      {value ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 basis-40 whitespace-normal font-medium [overflow-wrap:anywhere]">
            {value.label}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            {m.space_setup_board_choice_clear()}
          </Button>
        </div>
      ) : null}
      <Input
        id={id}
        type="search"
        className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
        value={query}
        maxLength={256}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        placeholder={m.space_setup_board_choice_search()}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div
        ref={resultRegion}
        role="region"
        aria-label={label}
        aria-busy={shown.status === 'loading' && !disabled}
        tabIndex={-1}
        className="min-w-0 space-y-3"
      >
        {shown.freshness?.caught_up === false ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.space_setup_board_choice_updating()}
          </p>
        ) : null}
        {shown.status === 'ready' ? (
          shown.choices.length ? (
            <RadioGroup
              aria-label={label}
              aria-describedby={`${id}-hint`}
              className="min-w-0"
              value={value?.id ?? ''}
              disabled={disabled}
              onValueChange={(id) => {
                const choice = pager.choose(String(id), expected);
                if (choice) onChange(choice);
              }}
            >
              {shown.choices.map((choice, index) => (
                <FieldLabel
                  key={choice.id}
                  htmlFor={`${id}-${index}`}
                  className="flex h-auto min-h-12 w-full min-w-0 max-w-full cursor-pointer items-center gap-3 whitespace-normal rounded-xl border border-border p-3 text-start has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary/5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring"
                >
                  <RadioGroupItem id={`${id}-${index}`} value={choice.id} />
                  <span className="min-w-0 flex-1 whitespace-normal text-sm leading-relaxed [overflow-wrap:anywhere]">
                    {choice.label}
                  </span>
                </FieldLabel>
              ))}
            </RadioGroup>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {kind === 'concept' && source.conceptQuery === 'loaded-page'
                ? m.space_setup_board_choice_local_empty()
                : m.space_setup_board_choice_no_matches()}
            </p>
          )
        ) : shown.status !== 'loading' ? (
          <div role="status" className="space-y-3 rounded-xl border border-border bg-muted/50 p-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {shown.status === 'denied'
                ? m.space_setup_denied()
                : shown.status === 'stale'
                  ? m.space_setup_board_choice_stale()
                  : shown.status === 'invalid'
                    ? m.space_setup_invalid()
                    : m.space_setup_board_choice_unavailable()}
            </p>
            {shown.canRestart ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {m.space_setup_board_choice_restart_hint()}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                disabled={disabled}
                onClick={(event) =>
                  pageAction(event.detail, shown.status !== 'ready' && shown.status !== 'loading', () =>
                    pager.retry(expected),
                  )
                }
              >
                {m.space_setup_retry()}
              </Button>
              {shown.canRestart ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                  disabled={disabled}
                  onClick={(event) =>
                    pageAction(event.detail, shown.canRestart === true, () => pager.restart(expected))
                  }
                >
                  {m.space_setup_board_choice_restart()}
                </Button>
              ) : null}
            </div>
          </div>
        ) : !disabled ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.space_setup_loading()}
          </p>
        ) : null}
        {shown.next !== null ? (
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 text-start [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
            disabled={disabled}
            onClick={(event) =>
              pageAction(event.detail, shown.status === 'ready' && shown.next !== null, () => pager.next(expected))
            }
          >
            {m.space_setup_board_choice_next()}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
