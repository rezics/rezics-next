import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Label } from '@rezics/ui/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { createHomeQuestionChoices } from './home-feed-questions';

type Choices = ReturnType<typeof createHomeQuestionChoices>;
export function HomeFeedQuestionControl({
  choices,
  snapshot,
  locale,
  selectedId,
  onRestore,
}: {
  choices: Choices;
  snapshot: ReturnType<Choices['snapshot']>;
  locale: string;
  selectedId?: string | undefined;
  onRestore?: (() => void) | undefined;
}) {
  const id = useId();
  const options = { locale: locale as Locale };
  const values = snapshot.page?.ratingQuestions ?? [];
  const selected = snapshot.selected;
  const retained = selected && !values.some((question) => question.id === selected.id) ? [selected] : [];
  const messages = {
    loading: m.home_questions_loading,
    unavailable: m.home_questions_unavailable,
    auth: m.home_feed_auth,
    denied: m.home_questions_denied,
    closed: m.home_feed_closed,
    restart: m.home_questions_restart,
    invalid: m.home_questions_invalid,
    lost: m.home_questions_lost,
  };
  const failure = snapshot.status !== 'idle' && snapshot.status !== 'ready' && snapshot.status !== 'loading';
  const selectedFailure =
    snapshot.selection !== 'none' && snapshot.selection !== 'ready' && snapshot.selection !== 'loading';
  const grains = {
    work: m.home_question_work,
    release: m.home_question_release,
    episode: m.home_question_episode,
    character: m.home_question_character,
  };
  const number = new Intl.NumberFormat(locale);
  return (
    <section
      className="space-y-3"
      aria-label={m.home_question_label({}, options)}
      aria-busy={snapshot.status === 'loading' || snapshot.selection === 'loading'}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor={id}>{m.home_question_label({}, options)}</Label>
        <NativeSelect
          id={id}
          className="max-w-full [&_select]:min-h-11 [&_select]:max-w-full"
          value={selected?.id ?? selectedId ?? ''}
          disabled={!snapshot.page && !selected && !selectedId}
          onChange={(event) => {
            const question = [...retained, ...values].find((value) => value.id === event.target.value);
            if (question || event.target.value === '') void choices.select(question);
          }}
        >
          {snapshot.status !== 'idle' || selected || selectedId ? (
            <NativeSelectOption value="">{m.home_question_all({}, options)}</NativeSelectOption>
          ) : null}
          {selectedId && !selected && !values.some((question) => question.id === selectedId) ? (
            <NativeSelectOption value={selectedId}>
              {m.home_filter_metadata_unavailable({}, options)}
            </NativeSelectOption>
          ) : null}
          {[...retained, ...values].map((question) => (
            <NativeSelectOption key={question.id} value={question.id}>
              {question.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          className="min-h-11 whitespace-normal"
          variant="outline"
          disabled={snapshot.status === 'loading' || (snapshot.status === 'ready' && !snapshot.page?.next)}
          onClick={() => void choices.load(failure ? choices.retryCursor() : (snapshot.page?.next ?? undefined))}
        >
          {snapshot.status === 'restart' || snapshot.status === 'invalid'
            ? m.home_questions_restart_action({}, options)
            : failure
              ? m.home_questions_retry({}, options)
              : snapshot.page
                ? m.home_questions_next({}, options)
                : m.home_questions_load({}, options)}
        </Button>
        {selected || selectedId ? (
          <>
            <Button
              className="min-h-11 whitespace-normal"
              variant="outline"
              onClick={() => void choices.select(undefined)}
            >
              {m.home_question_clear({}, options)}
            </Button>
            <Button
              className="min-h-11 whitespace-normal"
              variant="outline"
              disabled={snapshot.selection === 'loading'}
              onClick={() => (selected ? void choices.refresh() : onRestore?.())}
            >
              {m.home_question_refresh({}, options)}
            </Button>
          </>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">{m.home_question_help({}, options)}</p>
      {selected ? (
        <details className="text-sm text-muted-foreground">
          <summary className="min-h-11 cursor-pointer py-2">
            {m.home_presentation_question_information({}, options)}
          </summary>
          <p className="pb-2">
            {m.home_question_metadata(
              {
                label: selected.label,
                revision: number.format(selected.revision),
                grain: grains[selected.grain]({}, options),
                min: number.format(selected.scale.min),
                max: number.format(selected.scale.max),
                step: number.format(selected.scale.displayStep),
              },
              options,
            )}
          </p>
        </details>
      ) : null}
      {snapshot.status !== 'idle' && snapshot.status !== 'ready' ? (
        <p role={failure ? 'alert' : 'status'} className="text-sm text-muted-foreground">
          {messages[snapshot.status]({}, options)}
        </p>
      ) : null}
      {snapshot.status === 'ready' && values.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.home_questions_empty({}, options)}
        </p>
      ) : null}
      {snapshot.selection !== 'none' && snapshot.selection !== 'ready' ? (
        <p role={selectedFailure ? 'alert' : 'status'} className="text-sm text-muted-foreground">
          {messages[snapshot.selection]({}, options)}
        </p>
      ) : null}
    </section>
  );
}
