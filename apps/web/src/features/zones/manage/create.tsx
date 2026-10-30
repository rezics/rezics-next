import { useRef, useState, type FormEvent } from 'react';
import { pickText, UI_LOCALES, type ZoneStarter } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { PageHeading } from '../../../shell/page-heading';
import { m } from '../../../paraglide/messages.js';
import type { NavigationSession } from '../../../shell/navigation';
import { copyStarter, starterChoices } from './starters';
import { invalidLabels, zonePaths, type CommandOutcome, type CreateCommand } from './model';
import { ZoneFeedback } from './feedback';

export type CreateProps = {
  locale: string;
  session: NavigationSession;
  onCreate: (command: CreateCommand) => Promise<CommandOutcome>;
  onNavigate: (href: string) => void;
};

export function CreateZone({ locale, session, onCreate, onNavigate }: CreateProps) {
  const options = { locale: locale as never };
  const [starter, setStarter] = useState('');
  const [labels, setLabels] = useState<ZoneStarter['labels'] | null>(null);
  const [command, setCommand] = useState<CreateCommand | null>(null);
  const [result, setResult] = useState<CommandOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const choose = useRef<HTMLSelectElement>(null);
  const frozen = busy || command !== null;

  async function send(input: CreateCommand) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setCommand(input);
    let saved: CommandOutcome;
    try {
      saved = await onCreate(input);
    } catch {
      saved = { kind: 'unavailable' };
    }
    setResult(saved);
    if (saved.kind !== 'unavailable' && saved.kind !== 'conflict' && saved.kind !== 'saved') setCommand(null);
    setBusy(false);
    inFlight.current = false;
    if (saved.kind === 'saved') onNavigate(zonePaths(locale, saved.zone.id).edit);
    else requestAnimationFrame(() => alert.current?.focus());
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (frozen || session !== 'signed-in') return;
    if (!starter || !labels) {
      setResult({ kind: 'invalid' });
      choose.current?.focus();
      return;
    }
    const fields = invalidLabels(labels);
    if (fields.length) {
      setResult({ kind: 'invalid', fields });
      requestAnimationFrame(() => alert.current?.focus());
      return;
    }
    void send({ starter, labels: structuredClone(labels), key: crypto.randomUUID() });
  }

  const invalid = result?.kind === 'invalid';
  return (
    <article className="mx-auto w-full max-w-3xl space-y-6 text-foreground">
      <a className="underline" href={zonePaths(locale).list}>
        {m.zones_owner_title({}, options)}
      </a>
      <header className="space-y-3">
        <PageHeading>{m.zones_owner_create({}, options)}</PageHeading>
        <p className="text-muted-foreground">{m.zones_create_intro({}, options)}</p>
      </header>
      {result?.kind === 'saved' ? (
        <section role="status" className="space-y-3">
          <p>{m.zones_create_saved({}, options)}</p>
          <div className="flex flex-wrap gap-2">
            <a className={buttonVariants()} href={zonePaths(locale, result.zone.id).edit}>
              {m.zones_owner_configure({}, options)}
            </a>
            <a className={buttonVariants({ variant: 'outline' })} href={zonePaths(locale, result.zone.id).reader}>
              {m.zones_owner_open({}, options)}
            </a>
          </div>
          <p className="text-muted-foreground">{m.zones_create_reader_help({}, options)}</p>
        </section>
      ) : session === 'unknown' ? (
        <p role="status">{m.zones_owner_loading({}, options)}</p>
      ) : session !== 'signed-in' ? (
        <ZoneFeedback
          failure={{ kind: session === 'signed-out' ? 'signed-out' : 'unavailable' }}
          locale={locale}
          returnTo={zonePaths(locale).create}
        />
      ) : (
        <form className="space-y-6" noValidate onSubmit={submit} aria-busy={busy}>
          <Field data-invalid={invalid && !starter}>
            <FieldLabel htmlFor="zone-starter">{m.zones_create_starter({}, options)}</FieldLabel>
            <NativeSelect
              id="zone-starter"
              ref={choose}
              value={starter}
              disabled={frozen}
              aria-invalid={invalid && !starter}
              aria-describedby="zone-starter-help"
              onChange={(event) => {
                const id = event.target.value;
                setStarter(id);
                setLabels(copyStarter(id)?.labels ?? null);
                setResult(null);
              }}
            >
              <NativeSelectOption value="">{m.zones_create_choose({}, options)}</NativeSelectOption>
              {starterChoices.map((choice) => (
                <NativeSelectOption key={choice.id} value={choice.id}>
                  {pickText(choice.labels, locale).text}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription id="zone-starter-help">{m.zones_create_starter_help({}, options)}</FieldDescription>
          </Field>
          {labels ? (
            <fieldset className="space-y-4" disabled={frozen}>
              <legend className="text-xl font-semibold">{m.zones_create_names({}, options)}</legend>
              <p id="zone-label-help" className="text-sm text-muted-foreground">
                {m.zones_create_names_help({}, options)}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {UI_LOCALES.map((language) => {
                  const fieldInvalid = invalid && result.fields?.includes(`/configuration/labels/${language}`);
                  return (
                    <Field key={language} data-invalid={fieldInvalid}>
                      <FieldLabel htmlFor={`zone-label-${language}`}>
                        {m.zones_create_label({ language }, options)}
                      </FieldLabel>
                      <Input
                        id={`zone-label-${language}`}
                        lang={language}
                        value={labels[language]}
                        required
                        aria-invalid={fieldInvalid}
                        aria-describedby="zone-label-help"
                        onChange={(event) => {
                          setLabels((current) => (current ? { ...current, [language]: event.target.value } : current));
                        }}
                      />
                    </Field>
                  );
                })}
              </div>
            </fieldset>
          ) : null}
          <p className="text-muted-foreground">{m.zones_create_visibility({}, options)}</p>
          {result ? (
            <div ref={alert} tabIndex={-1} className="space-y-3">
              <ZoneFeedback
                failure={result}
                locale={locale}
                onRetry={result.kind === 'unavailable' && command && !busy ? () => void send(command) : undefined}
              />
              {result.kind === 'unavailable' ? <p>{m.zones_create_uncertain({}, options)}</p> : null}
              {result.kind === 'conflict' ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setCommand(null);
                    setResult(null);
                    choose.current?.focus();
                  }}
                >
                  {m.zones_create_review({}, options)}
                </Button>
              ) : null}
            </div>
          ) : null}
          <Button type="submit" disabled={frozen}>
            {busy ? m.zones_owner_working({}, options) : m.zones_create_submit({}, options)}
          </Button>
        </form>
      )}
    </article>
  );
}
