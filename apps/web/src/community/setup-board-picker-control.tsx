import { useId, useLayoutEffect, useMemo, useState } from 'react';
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
  useLayoutEffect(() => () => pager.cancel(), [pager]);
  const shown: BoardChoicePage = current ? page : { status: 'loading', choices: [], next: null };
  const label = kind === 'scheme' ? m.space_setup_scheme_label() : m.space_setup_concept_label();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <FieldDescription id={`${id}-hint`}>
        {kind === 'scheme' ? m.space_setup_board_scheme_choices_hint() : m.space_setup_concept_hint()}
        {kind === 'concept' && source.conceptQuery === 'loaded-page'
          ? ` ${m.space_setup_board_choice_local_hint()}`
          : ''}
      </FieldDescription>
      {value ? (
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words font-medium">{value.label}</span>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
            {m.space_setup_board_choice_clear()}
          </Button>
        </div>
      ) : null}
      <Input
        id={id}
        type="search"
        value={query}
        maxLength={256}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        placeholder={m.space_setup_board_choice_search()}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div aria-busy={shown.status === 'loading' && !disabled} className="space-y-3">
        {shown.freshness?.caught_up === false ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.space_setup_board_choice_updating()}
          </p>
        ) : null}
        {shown.status === 'ready' ? (
          shown.choices.length ? (
            <RadioGroup
              aria-label={label}
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
                  className="flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border p-3 has-[[data-checked]]:border-primary has-[[data-checked]]:bg-primary/5"
                >
                  <RadioGroupItem id={`${id}-${index}`} value={choice.id} />
                  <span className="min-w-0 break-words text-sm leading-relaxed">{choice.label}</span>
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
            <Button type="button" variant="outline" disabled={disabled} onClick={() => pager.retry(expected)}>
              {m.space_setup_retry()}
            </Button>
          </div>
        ) : !disabled ? (
          <p role="status" className="text-sm text-muted-foreground">
            {m.space_setup_loading()}
          </p>
        ) : null}
        {shown.next !== null ? (
          <Button type="button" variant="outline" disabled={disabled} onClick={() => pager.next(expected)}>
            {m.space_setup_board_choice_next()}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
