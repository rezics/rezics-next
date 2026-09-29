import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { CircleCheck } from 'lucide-react';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import type { NotifyError } from '../../worker/notify.ts';
import type { UiLocale } from '../i18n/locales.ts';

export interface NotifyLabels {
  emailLabel: string;
  submit: string;
  sending: string;
  successTitle: string;
  successBody: string;
  errors: Record<NotifyError | 'network', string>;
}

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done' }
  | { kind: 'error'; code: NotifyError | 'network' };

/**
 * The "Get notified" form. It works as a plain form post without JavaScript
 * (the endpoint redirects to a confirmation page); this island keeps the
 * visitor on the page and shows the confirmation in place.
 */
export function NotifyForm({ locale, labels }: { locale: UiLocale; labels: NotifyLabels }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const done = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (state.kind === 'done') done.current?.focus();
  }, [state.kind]);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState({ kind: 'sending' });
    try {
      const response = await fetch('/api/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ email: form.get('email'), locale, company: form.get('company') }),
      });
      if (response.ok) return setState({ kind: 'done' });
      const problem = (await response.json().catch(() => undefined)) as
        | { code?: NotifyError }
        | undefined;
      setState({ kind: 'error', code: problem?.code ?? 'unavailable' });
    } catch {
      setState({ kind: 'error', code: 'network' });
    }
  }

  if (state.kind === 'done') {
    return (
      <div role="status" className="flex items-start gap-3">
        <CircleCheck aria-hidden className="mt-0.5 size-6 shrink-0 text-success-foreground" />
        <div>
          <h3 ref={done} tabIndex={-1} className="font-semibold text-lg outline-none">
            {labels.successTitle}
          </h3>
          <p className="mt-1 text-muted-foreground">{labels.successBody}</p>
        </div>
      </div>
    );
  }

  const invalid = state.kind === 'error';
  return (
    <form
      method="post"
      action="/api/notify"
      onSubmit={(event) => void submit(event)}
      noValidate
      className="flex flex-col gap-3"
    >
      <input type="hidden" name="locale" value={locale} />
      {/* Hidden from people and assistive technology; scripts that fill every field reveal themselves. */}
      <div aria-hidden className="absolute -start-[9999px] h-0 overflow-hidden">
        <input type="text" name="company" tabIndex={-1} autoComplete="off" />
      </div>
      <Field invalid={invalid}>
        <FieldLabel>{labels.emailLabel}</FieldLabel>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            type="email"
            name="email"
            required
            autoComplete="email"
            inputMode="email"
            size="lg"
            className="bg-background sm:flex-1"
          />
          <Button type="submit" size="lg" isLoading={state.kind === 'sending'}>
            {state.kind === 'sending' ? labels.sending : labels.submit}
          </Button>
        </div>
        <div aria-live="polite">
          {invalid && <FieldError>{labels.errors[state.code]}</FieldError>}
        </div>
      </Field>
    </form>
  );
}
