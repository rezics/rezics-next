import { useId, useRef, useState } from 'react';
import { pickText } from '@rezics/composition';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldSet, FieldLegend } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { ContentItem, ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { contextChoiceInput, type ContextChoices } from '../contexts/choice-native';
import {
  providerContextLabel,
  type ProviderContextSource,
  type ProviderContextChoice,
} from './provider-context-choice';
import { globalReviewContext } from './provider-queue';
import { providerAlwaysCurrent, useProviderVisit } from './provider-visit';
import { m } from '../../paraglide/messages.js';

export function ProviderContextChoiceField({
  source,
  value,
  locale,
  onChange,
  current = providerAlwaysCurrent,
}: {
  source: ProviderContextSource;
  value: ProviderContextChoice | null;
  locale: string;
  onChange: (choice: ProviderContextChoice | null) => void;
  current?: () => boolean;
}) {
  const id = useId();
  const visit = useProviderVisit(current, source);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<ContextChoices>();
  const [phase, setPhase] = useState<'idle' | 'loading' | 'ready' | 'denied' | 'unavailable' | 'query' | 'cursor'>(
    'idle',
  );
  const [resolving, setResolving] = useState(false);
  const sequence = useRef(0);
  const resolution = useRef(0);
  const generation = sequence.current;
  const selectionGeneration = resolution.current;
  const o = { locale: locale as never };
  const message =
    phase === 'denied'
      ? m.provider_scope_denied({}, o)
      : phase === 'query'
        ? m.provider_scope_query_invalid({}, o)
        : phase === 'cursor'
          ? m.provider_scope_cursor_invalid({}, o)
          : phase === 'loading'
            ? m.prq_loading({}, o)
            : phase === 'unavailable'
              ? m.prq_unavailable({}, o)
              : '';
  async function search(cursor?: string) {
    if (!visit.live() || generation !== sequence.current) return;
    const invalid = contextChoiceInput({ query, ...(cursor !== undefined ? { cursor } : {}) });
    resolution.current++;
    setResolving(false);
    const version = ++sequence.current;
    setPage(undefined);
    if (invalid) {
      setPhase(invalid.field === 'cursor' ? 'cursor' : 'query');
      return;
    }
    setPhase('loading');
    try {
      const result = await source.search({ query, ...(cursor !== undefined ? { cursor } : {}) });
      if (!visit.live() || version !== sequence.current) return;
      if ('kind' in result)
        setPhase(result.kind === 'invalid' ? (result.field === 'cursor' ? 'cursor' : 'query') : result.kind);
      else {
        setPage(result);
        setPhase('ready');
      }
    } catch {
      if (visit.live() && version === sequence.current) setPhase('unavailable');
    }
  }
  async function choose(target: string) {
    if (!visit.live() || generation !== sequence.current || selectionGeneration !== resolution.current) return;
    const version = ++resolution.current;
    sequence.current++;
    setPage(undefined);
    onChange(null); // Conceal the old queue before the independent exact read begins.
    setResolving(true);
    setPhase('loading');
    try {
      const result = await source.resolve(target);
      if (!visit.live() || version !== resolution.current) return;
      if ('kind' in result) setPhase(result.kind === 'invalid' ? 'unavailable' : result.kind);
      else if (result.context.id !== target || result.context.state !== 'active') setPhase('denied');
      else {
        const selected = providerContextLabel(result, locale, m.prq_global({}, o));
        onChange({ ...selected, label: selected.label || m.provider_scope_unnamed({}, o) });
        setPhase('idle');
      }
    } catch {
      if (visit.live() && version === resolution.current) setPhase('unavailable');
    } finally {
      if (visit.live() && version === resolution.current) setResolving(false);
    }
  }
  return (
    <FieldSet className="flex flex-col gap-3 sm:col-span-2" aria-busy={resolving || phase === 'loading'}>
      <FieldLegend>{m.provider_scope_context({}, o)}</FieldLegend>
      <p className="text-sm text-muted-foreground">{m.provider_scope_help({}, o)}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-0 flex-1" data-invalid={phase === 'query'}>
          <FieldLabel htmlFor={id}>{m.provider_scope_search({}, o)}</FieldLabel>
          <Input
            id={id}
            value={query}
            maxLength={256}
            aria-invalid={phase === 'query'}
            aria-describedby={`${id}-status`}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
            onChange={(event) => {
              if (!visit.live() || generation !== sequence.current) return;
              sequence.current++;
              resolution.current++;
              setResolving(false);
              setQuery(event.target.value);
              setPage(undefined);
              setPhase('idle');
            }}
          />
        </Field>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void search()}>
          {m.provider_scope_find({}, o)}
        </Button>
        <Button type="button" variant="outline" className="min-h-11" onClick={() => void choose(globalReviewContext)}>
          {m.prq_global({}, o)}
        </Button>
      </div>
      <p id={`${id}-status`} role={phase === 'query' || phase === 'cursor' ? 'alert' : 'status'}>
        {message}
      </p>
      {value && <p role="status">{m.provider_scope_selected({ label: value.label }, o)}</p>}
      {page && (
        <ContentItemFrame as="div" className="flex flex-col gap-2 p-3">
          {!page.contexts.length && (
            <ContentItemHeading level={2} role="status">
              {m.provider_scope_empty({}, o)}
            </ContentItemHeading>
          )}
          <ul className="flex flex-col gap-2">
            {page.contexts.map((context) => (
              <li key={context.id}>
                <ContentItem
                  title={pickText(context.labels, locale).text || m.provider_scope_unnamed({}, o)}
                  headingLevel={3}
                  actions={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => {
                        if (
                          visit.live() &&
                          generation === sequence.current &&
                          page.contexts.some((entry) => entry.id === context.id)
                        )
                          void choose(context.id);
                      }}
                    >
                      {m.provider_scope_choose({}, o)}
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
          {page.next !== null && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                if (visit.live() && generation === sequence.current && phase === 'ready') void search(page.next!);
              }}
            >
              {m.prq_continue({}, o)}
            </Button>
          )}
        </ContentItemFrame>
      )}
    </FieldSet>
  );
}
