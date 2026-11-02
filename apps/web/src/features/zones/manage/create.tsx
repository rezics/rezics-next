import { useId, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { pickText, UI_LOCALES, type ZoneConfiguration, type ZoneLanguage } from '@rezics/composition';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { ZoneNameFields } from '../editor/name-fields';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { PageHeading } from '../../../shell/page-heading';
import { m } from '../../../paraglide/messages.js';
import type { NavigationSession } from '../../../shell/navigation';
import { copyStarter, starterChoices } from './starters';
import { invalidLabels, zonePaths, type CommandOutcome, type CreateCommand } from './model';
import { CreateNavigationGuard } from './create-navigation';
import { ZoneFeedback } from './feedback';
import { hasValidOwnerCsrfToken, type OwnerCapture, type OwnerLifetime } from '../editor/owner-lifetime';

export type CreateProps = {
  locale: string;
  session: NavigationSession;
  owner?: OwnerLifetime;
  onCreate: (command: CreateCommand, capture?: OwnerCapture) => Promise<CommandOutcome>;
  onNavigate: (href: string) => void;
};

const actionClassName =
  'h-auto min-w-0 max-w-full whitespace-normal break-words py-2 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11';

const noSubscription = () => () => {};
const fixtureSnapshot = () => null;
export function CreateZone(props: CreateProps) {
  const snapshot = useSyncExternalStore(
    props.owner?.subscribe ?? noSubscription,
    props.owner?.snapshot ?? fixtureSnapshot,
    props.owner?.snapshot ?? fixtureSnapshot,
  );
  return <CreateVisit key={snapshot?.incarnation ?? 'fixture'} {...props} />;
}

function CreateVisit({ locale, session, owner, onCreate, onNavigate }: CreateProps) {
  const starterId = useId();
  const options = { locale: locale as never };
  const initialLanguage = UI_LOCALES.find((language) => language === locale) ?? 'en';
  const [starter, setStarter] = useState('');
  const [labels, setLabels] = useState<ZoneConfiguration['labels'] | null>(null);
  const [primaryLanguage, setPrimaryLanguage] = useState<ZoneLanguage>(initialLanguage);
  const [command, setCommand] = useState<CreateCommand | null>(null);
  const [result, setResult] = useState<CommandOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const inFlight = useRef(false);
  const retained = useRef<CreateCommand | null>(null);
  const creationSucceeded = useRef(false);
  const leftVisit = useRef(false);
  const clearBlockedDeparture = useRef<(() => void) | null>(null);
  const alert = useRef<HTMLDivElement>(null);
  const choose = useRef<HTMLSelectElement>(null);
  const capture = owner?.capture();
  const isCurrent = (admission: OwnerCapture | null | undefined) =>
    sessionRef.current === 'signed-in' && (!owner || owner.isCurrent(admission));
  const canWrite = session === 'signed-in' && (!owner || hasValidOwnerCsrfToken(capture?.csrfToken));
  const frozen = busy || command !== null;

  async function send(input: CreateCommand) {
    const admission = capture;
    if (!isCurrent(admission)) return;
    if (owner && (!admission || !hasValidOwnerCsrfToken(admission.csrfToken))) return;
    if (inFlight.current || (retained.current && retained.current !== input)) return;
    // The original command and credentials belong to this rendered admission.
    const original = retained.current ?? structuredClone(input);
    retained.current = original;
    inFlight.current = true;
    setBusy(true);
    setCommand(original);
    let saved: CommandOutcome;
    let received = true;
    try {
      saved = await onCreate(structuredClone(original), admission ?? undefined);
    } catch {
      saved = { kind: 'unavailable' };
      received = false;
    }
    const responseMatches =
      !owner ||
      !received ||
      (!!admission &&
        saved.ownerObservation?.reader === admission.observation.reader &&
        saved.ownerObservation?.admission === admission.observation.admission);
    if (!isCurrent(admission) || !responseMatches) {
      owner?.retire(admission ?? undefined);
      return;
    }
    setResult(saved);
    if (saved.kind !== 'unavailable' && saved.kind !== 'conflict' && saved.kind !== 'saved') {
      retained.current = null;
      setCommand(null);
    }
    setBusy(false);
    inFlight.current = false;
    if (saved.kind === 'saved') {
      if (isCurrent(admission)) {
        creationSucceeded.current = true;
        clearBlockedDeparture.current?.();
        if (!leftVisit.current) onNavigate(zonePaths(locale, saved.zone.id).edit);
      }
    } else
      requestAnimationFrame(() => {
        if (isCurrent(admission)) alert.current?.focus();
      });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (frozen || !canWrite || !isCurrent(capture)) return;
    if (!starter || !labels) {
      setResult({ kind: 'invalid' });
      choose.current?.focus();
      return;
    }
    const fields = invalidLabels(labels, primaryLanguage);
    if (fields.length) {
      setResult({ kind: 'invalid', fields });
      requestAnimationFrame(() => {
        if (!owner || owner.isCurrent(capture)) alert.current?.focus();
      });
      return;
    }
    void send({ starter, primaryLanguage, labels: structuredClone(labels), key: crypto.randomUUID() });
  }

  if (owner && !owner.isCurrent(capture))
    return session === 'signed-out' ? (
      <ZoneFeedback failure={{ kind: 'signed-out' }} locale={locale} returnTo={zonePaths(locale).create} />
    ) : (
      <p role="status">{m.zones_owner_loading({}, options)}</p>
    );
  const invalid = result?.kind === 'invalid';
  const hasEffectiveDraft =
    starter !== '' ||
    primaryLanguage !== initialLanguage ||
    Object.values(labels ?? {}).some((name) => name.length > 0);
  const requestMayComplete = busy || inFlight.current || result?.kind === 'unavailable';
  return (
    <article
      onClickCapture={(event) => {
        if (!isCurrent(capture)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className="mx-auto w-full max-w-3xl min-w-0 space-y-6 break-words text-foreground"
    >
      <CreateNavigationGuard
        locale={locale}
        session={session}
        {...(owner ? { owner } : {})}
        capture={capture}
        needsDecision={() => !creationSucceeded.current && (hasEffectiveDraft || requestMayComplete)}
        requestMayComplete={requestMayComplete}
        onLeave={() => {
          leftVisit.current = true;
        }}
        clearBlockedDeparture={clearBlockedDeparture}
      />
      <a
        className={`inline-flex items-center rounded-md px-2 underline ${actionClassName}`}
        href={zonePaths(locale).list}
      >
        {m.zones_owner_title({}, options)}
      </a>
      <header className="space-y-3">
        <PageHeading>{m.zones_owner_create({}, options)}</PageHeading>
        <p className="text-muted-foreground">{m.zones_create_intro({}, options)}</p>
      </header>
      {result?.kind === 'saved' ? (
        <section role="status" className="min-w-0 space-y-3">
          <p>{m.zones_create_saved({}, options)}</p>
          <div className="flex flex-wrap gap-2">
            <a className={`${buttonVariants()} ${actionClassName}`} href={zonePaths(locale, result.zone.id).edit}>
              {m.zones_owner_configure({}, options)}
            </a>
            <a
              className={`${buttonVariants({ variant: 'outline' })} ${actionClassName}`}
              href={zonePaths(locale, result.zone.id).reader}
            >
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
        <form className="min-w-0 space-y-6" noValidate onSubmit={submit} aria-busy={busy}>
          <ContentItemFrame as="div" className="min-w-0 space-y-4 p-3 sm:p-4">
            <Field data-invalid={invalid && !starter}>
              <FieldLabel className="whitespace-normal" htmlFor={`${starterId}-zone-starter`}>
                {m.zones_create_starter({}, options)}
              </FieldLabel>
              <NativeSelect
                id={`${starterId}-zone-starter`}
                className="w-full max-w-full [&_select]:h-auto [&_select]:min-h-8 [&_select]:max-w-full [&_select]:whitespace-normal [&_select]:break-words [@media(pointer:coarse)]:[&_select]:min-h-11"
                ref={choose}
                value={starter}
                disabled={frozen}
                aria-invalid={invalid && !starter}
                aria-describedby={`${starterId}-zone-starter-help`}
                onChange={(event) => {
                  if (!isCurrent(capture)) return;
                  const id = event.target.value;
                  setStarter(id);
                  setLabels((current) => current ?? (copyStarter(id) ? {} : null));
                  setResult(null);
                }}
              >
                <NativeSelectOption value="">{m.zones_create_choose({}, options)}</NativeSelectOption>
                {starterChoices.map((choice) => (
                  <NativeSelectOption
                    key={choice.id}
                    value={choice.id}
                    lang={pickText(choice.labels, locale).lang ?? undefined}
                    dir="auto"
                  >
                    {pickText(choice.labels, locale).text}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription id={`${starterId}-zone-starter-help`}>
                {m.zones_create_starter_help({}, options)}
              </FieldDescription>
            </Field>
            <p className="text-muted-foreground">{m.zones_create_visibility({}, options)}</p>
          </ContentItemFrame>
          {labels ? (
            <ContentItemFrame as="div" className="min-w-0 p-3 sm:p-4">
              <ZoneNameFields
                locale={locale}
                labels={labels}
                primaryLanguage={primaryLanguage}
                disabled={frozen}
                errors={invalid ? result.fields : undefined}
                onChange={(names) => {
                  if (!isCurrent(capture)) return;
                  setLabels(names.labels);
                  setPrimaryLanguage(names.primaryLanguage);
                  setResult(null);
                }}
              />
            </ContentItemFrame>
          ) : null}
          {result ? (
            <div ref={alert} tabIndex={-1} className="min-w-0 space-y-3">
              <ZoneFeedback
                failure={result}
                locale={locale}
                onRetry={
                  result.kind === 'unavailable' && command && !busy
                    ? () => {
                        if (retained.current === command) void send(command);
                      }
                    : undefined
                }
              />
              {result.kind === 'unavailable' ? <p>{m.zones_create_uncertain({}, options)}</p> : null}
              {result.kind === 'conflict' ? (
                <Button
                  variant="outline"
                  className={actionClassName}
                  onClick={() => {
                    if (!isCurrent(capture)) return;
                    retained.current = null;
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
          <Button className={actionClassName} type="submit" disabled={frozen || !canWrite}>
            {busy ? m.zones_owner_working({}, options) : m.zones_create_submit({}, options)}
          </Button>
        </form>
      )}
    </article>
  );
}
