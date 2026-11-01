import { useRef, useState, type FormEvent } from 'react';
import { pickText, UI_LOCALES, type ZoneConfiguration, type ZoneLanguage } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { ZoneNameFields } from '../editor/name-fields';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { PageHeading } from '../../../shell/page-heading';
import { m } from '../../../paraglide/messages.js';
import type { NavigationSession } from '../../../shell/navigation';
import { copyStarter, starterChoices } from './starters';
import { invalidLabels, zonePaths, type CommandOutcome, type CreateCommand } from './model';
import { ZoneFeedback } from './feedback';
import { hasValidOwnerCsrfToken, type OwnerCapture, type OwnerLifetime } from '../editor/owner-lifetime';

export type CreateProps = {
  locale: string;
  session: NavigationSession;
  owner?: OwnerLifetime;
  onCreate: (command: CreateCommand, capture?: OwnerCapture) => Promise<CommandOutcome>;
  onNavigate: (href: string) => void;
};

export function CreateZone({ locale, session, owner, onCreate, onNavigate }: CreateProps) {
  const options = { locale: locale as never };
  const [starter, setStarter] = useState('');
  const [labels, setLabels] = useState<ZoneConfiguration['labels'] | null>(null);
  const [primaryLanguage, setPrimaryLanguage] = useState<ZoneLanguage>(
    UI_LOCALES.find((language) => language === locale) ?? 'en',
  );
  const [command, setCommand] = useState<CreateCommand | null>(null);
  const [result, setResult] = useState<CommandOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alert = useRef<HTMLDivElement>(null);
  const choose = useRef<HTMLSelectElement>(null);
  const capture = owner?.capture();
  const canWrite = session === 'signed-in' && (!owner || hasValidOwnerCsrfToken(capture?.csrfToken));
  const frozen = busy || command !== null;

  async function send(input: CreateCommand) {
    const admission = owner?.capture();
    if (owner && (!admission || !hasValidOwnerCsrfToken(admission.csrfToken))) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setCommand(input);
    let saved: CommandOutcome;
    let received = true;
    try {
      saved = await onCreate(input, admission ?? undefined);
    } catch {
      saved = { kind: 'unavailable' };
      received = false;
    }
    const ownerCurrent = !owner || owner.isCurrent(admission);
    const responseMatches =
      !owner ||
      !received ||
      (!!admission &&
        saved.ownerObservation?.reader === admission.observation.reader &&
        saved.ownerObservation?.admission === admission.observation.admission);
    if (!ownerCurrent || !responseMatches) {
      owner?.retire(admission);
      return;
    }
    setResult(saved);
    if (saved.kind !== 'unavailable' && saved.kind !== 'conflict' && saved.kind !== 'saved') setCommand(null);
    setBusy(false);
    inFlight.current = false;
    if (saved.kind === 'saved') {
      if (!owner || owner.isCurrent(admission)) onNavigate(zonePaths(locale, saved.zone.id).edit);
    } else requestAnimationFrame(() => {
      if (!owner || owner.isCurrent(admission)) alert.current?.focus();
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (frozen || !canWrite || (owner && !owner.isCurrent(capture))) return;
    if (!starter || !labels) {
      setResult({ kind: 'invalid' });
      choose.current?.focus();
      return;
    }
    const fields = invalidLabels(labels, primaryLanguage);
    if (fields.length) {
      setResult({ kind: 'invalid', fields });
      requestAnimationFrame(() => alert.current?.focus());
      return;
    }
    void send({ starter, primaryLanguage, labels: structuredClone(labels), key: crypto.randomUUID() });
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
      ) : owner && !capture ? (
        <p role="status">{m.zones_owner_loading({}, options)}</p>
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
                setLabels((current) => current ?? (copyStarter(id) ? {} : null));
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
            <ZoneNameFields
              locale={locale}
              labels={labels}
              primaryLanguage={primaryLanguage}
              disabled={frozen}
              errors={invalid ? result.fields : undefined}
              onChange={(names) => {
                setLabels(names.labels);
                setPrimaryLanguage(names.primaryLanguage);
                setResult(null);
              }}
            />
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
          <Button type="submit" disabled={frozen || !canWrite}>
            {busy ? m.zones_owner_working({}, options) : m.zones_create_submit({}, options)}
          </Button>
        </form>
      )}
    </article>
  );
}
