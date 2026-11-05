import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Label } from '@rezics/ui/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { DefinitionMeaning } from '../catalogue/definition-meaning';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { homeKindChoice, type createHomeKindChoices, type HomeKindChoice } from './home-feed-kinds';

type Choices = ReturnType<typeof createHomeKindChoices>;
export function HomeFeedKindControl({
  choices,
  snapshot,
  locale,
  onSelect,
}: {
  choices: Choices;
  snapshot: ReturnType<Choices['snapshot']>;
  locale: string;
  onSelect: (choice: HomeKindChoice | undefined) => void;
}) {
  const id = useId();
  const options = { locale: locale as Locale };
  const values = snapshot.kinds?.values.map((kind) => homeKindChoice(kind, locale)) ?? [];
  const selected = snapshot.selected;
  const retained = selected && !values.some((kind) => kind.id === selected.id) ? [selected] : [];
  const messages = {
    loading: m.home_kinds_loading,
    unavailable: m.home_kinds_unavailable,
    'not-ready': m.discovery_not_ready,
    preparing: m.discovery_preparing,
    closed: m.discovery_closed,
    restart: m.discovery_restart,
    invalid: m.discovery_invalid,
    unsupported: m.discovery_unsupported,
    denied: m.discovery_denied,
  };
  const failure = snapshot.status !== 'idle' && snapshot.status !== 'ready' && snapshot.status !== 'loading';
  return (
    <section
      className="space-y-3"
      aria-label={m.home_kind_label({}, options)}
      aria-busy={snapshot.status === 'loading'}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor={id}>{m.home_kind_label({}, options)}</Label>
        <NativeSelect
          id={id}
          className="max-w-full [&_select]:min-h-11 [&_select]:max-w-full"
          aria-describedby={selected?.description ? `${id}-meaning` : undefined}
          value={selected?.id ?? ''}
          onChange={(event) => {
            if (event.target.value === '') onSelect(undefined);
            else {
              const choice = [...retained, ...values].find((kind) => kind.id === event.target.value);
              if (choice) onSelect(choice);
            }
          }}
        >
          <NativeSelectOption value="">{m.home_kind_all({}, options)}</NativeSelectOption>
          {[...retained, ...values].map((kind) => (
            <NativeSelectOption key={kind.id} value={kind.id} lang={kind.lang}>
              {kind.text || m.home_kind_unnamed({}, options)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          className="min-h-11 whitespace-normal"
          variant="outline"
          disabled={snapshot.status === 'loading' || (snapshot.status === 'ready' && !snapshot.kinds?.next)}
          onClick={() => void choices.load(failure ? choices.retryCursor() : (snapshot.kinds?.next ?? undefined))}
        >
          {failure
            ? m.home_kinds_retry({}, options)
            : snapshot.kinds
              ? m.home_kinds_next({}, options)
              : m.home_kinds_load({}, options)}
        </Button>
      </div>
      {selected?.description && (
        <p id={`${id}-meaning`} className="max-w-prose text-sm text-muted-foreground">
          <DefinitionMeaning text={selected.description} language={selected.descriptionLang} locale={locale} />
        </p>
      )}
      {snapshot.status !== 'idle' && snapshot.status !== 'ready' ? (
        <p role={failure ? 'alert' : 'status'} className="text-sm text-muted-foreground">
          {messages[snapshot.status]({}, options)}
        </p>
      ) : null}
      {snapshot.status === 'ready' && snapshot.kinds?.values.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.home_kinds_empty({}, options)}
        </p>
      ) : null}
    </section>
  );
}
