import * as SharedSelect from '@rezics/ui/shadcn/select';
import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  pickText,
  pickZoneName,
  UI_LOCALES,
  type ZoneConfiguration,
  type ZoneLanguage,
} from '@rezics/composition';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldDescription } from '@rezics/ui/shadcn/field';
import { ZoneNameFields } from '../editor/name-fields';
import { PageHeading } from '../../../shell/page-heading';
import { m } from '../../../paraglide/messages.js';
import type { NavigationSession } from '../../../shell/navigation';
import { copyStarter, starterChoices } from './starters';
import { invalidLabels, zonePaths, type CommandOutcome, type CreateCommand } from './model';
import { CreateNavigationGuard } from './create-navigation';
import { ZoneFeedback, useSettlementFocus, type KeyboardActivation } from './feedback';
import { hasValidOwnerCsrfToken, type OwnerCapture, type OwnerLifetime } from '../editor/owner-lifetime';

export type CreateProps = {
  locale: string;
  session: NavigationSession;
  owner?: OwnerLifetime;
  onCreate: (command: CreateCommand, capture?: OwnerCapture) => Promise<CommandOutcome>;
  onNavigate: (href: string) => void;
};

const actionClassName =
  'h-auto min-w-0 max-w-full whitespace-normal break-words py-2 text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11';

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
  const settlementFocus = useSettlementFocus();
  const initialLanguage = UI_LOCALES.find((language) => language === locale) ?? 'en';
  const [starter, setStarter] = useState('');
  const [labels, setLabels] = useState<ZoneConfiguration['labels'] | null>(null);
  const [primaryLanguage, setPrimaryLanguage] = useState<ZoneLanguage>(initialLanguage);
  const [command, setCommand] = useState<CreateCommand | null>(null);
  const [result, setResult] = useState<CommandOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const submitActivation = useRef<KeyboardActivation | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const inFlight = useRef(false);
  const retained = useRef<CreateCommand | null>(null);
  const creationSucceeded = useRef(false);
  const leftVisit = useRef(false);
  const clearBlockedDeparture = useRef<(() => void) | null>(null);
  const alert = useRef<HTMLElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const capture = owner?.capture();
  const isCurrent = (admission: OwnerCapture | null | undefined) =>
    sessionRef.current === 'signed-in' && (!owner || owner.isCurrent(admission));
  const canWrite = session === 'signed-in' && (!owner || hasValidOwnerCsrfToken(capture?.csrfToken));
  const frozen = busy || command !== null;

  async function send(input: CreateCommand, activation: KeyboardActivation | null) {
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
    } else settlementFocus.focusResult(() => alert.current, activation, () => isCurrent(admission));
  }

  function submit(event: FormEvent, activation: KeyboardActivation | null) {
    event.preventDefault();
    submitActivation.current = null;
    if (frozen || !canWrite || !isCurrent(capture)) return;
    if (!starter || !labels) {
      setResult({ kind: 'invalid' });
      settlementFocus.focusResult(() => choose.current, activation, () => isCurrent(capture));
      return;
    }
    const fields = invalidLabels(labels, primaryLanguage);
    if (fields.length) {
      setResult({ kind: 'invalid', fields });
      settlementFocus.focusResult(() => alert.current, activation, () => isCurrent(capture));
      return;
    }
    void send({ starter, primaryLanguage, labels: structuredClone(labels), key: crypto.randomUUID() }, activation);
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
  const createdName = result?.kind === 'saved' ? pickZoneName(result.zone, locale) : null;
  const requestStarter = command ? starterChoices.find((choice) => choice.id === command.starter) : undefined;
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
        <section role="status" className="min-w-0 space-y-3 rounded-xl border border-primary/30 bg-muted/30 p-3 sm:p-4">
          <p>{m.zones_create_saved({}, options)}</p>
          <p className="min-w-0 [overflow-wrap:anywhere]">
            <strong lang={createdName?.lang ?? undefined}>
              {createdName?.text || m.zones_owner_unnamed({}, options)}
            </strong>
          </p>
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
        <form
          className="min-w-0 space-y-6"
          noValidate
          onSubmit={(event) => submit(event, submitActivation.current)}
          onPointerDownCapture={() => {
            submitActivation.current = null;
          }}
          onKeyDownCapture={(event: ReactKeyboardEvent<HTMLFormElement>) => {
            submitActivation.current =
              event.key === 'Enter' && !(event.target instanceof HTMLTextAreaElement)
                ? settlementFocus.captureActivation(
                    undefined,
                    event.target instanceof HTMLElement ? event.target : null,
                  )
                : null;
          }}
          aria-busy={busy}
        >
          <ContentItemFrame as="div" className="min-w-0 p-3 sm:p-4">
            <div
              className={
                labels
                  ? 'grid min-w-0 gap-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]'
                  : 'grid min-w-0 gap-6'
              }
            >
              <section className="min-w-0 space-y-4">
                <Field data-invalid={invalid && !starter}>
                  <FieldLabel className="whitespace-normal" htmlFor={`${starterId}-zone-starter`}>
                    {m.zones_create_starter({}, options)}
                  </FieldLabel>
                  <SharedSelect.Select
                    value={starter || null}
                    disabled={frozen}
                    items={[
                      { value: null, label: m.zones_create_choose({}, options) },
                      ...starterChoices.map((choice) => ({
                        value: choice.id,
                        label: pickText(choice.labels, locale).text,
                      })),
                    ]}
                    onValueChange={(value) => {
                      if (!isCurrent(capture)) return;
                      const id = value ?? '';
                      setStarter(id);
                      setLabels((current) => current ?? (copyStarter(id) ? {} : null));
                      setResult(null);
                    }}
                  >
                    <SharedSelect.SelectTrigger
                      id={`${starterId}-zone-starter`}
                      ref={choose}
                      aria-invalid={invalid && !starter}
                      aria-describedby={`${starterId}-zone-starter-help`}
                      className="h-auto min-h-8 w-full max-w-full whitespace-normal break-words max-md:min-h-11 [@media(pointer:coarse)]:min-h-11"
                    >
                      <SharedSelect.SelectValue />
                    </SharedSelect.SelectTrigger>
                    <SharedSelect.SelectContent>
                      <SharedSelect.SelectGroup>
                        <SharedSelect.SelectItem value={null}>{m.zones_create_choose({}, options)}</SharedSelect.SelectItem>
                        {starterChoices.map((choice) => (
                          <SharedSelect.SelectItem
                            key={choice.id}
                            value={choice.id}
                            lang={pickText(choice.labels, locale).lang ?? undefined}
                            dir="auto"
                          >
                            {pickText(choice.labels, locale).text}
                          </SharedSelect.SelectItem>
                        ))}
                      </SharedSelect.SelectGroup>
                    </SharedSelect.SelectContent>
                  </SharedSelect.Select>
                  <FieldDescription id={`${starterId}-zone-starter-help`}>
                    {m.zones_create_starter_help({}, options)}
                  </FieldDescription>
                </Field>
                <p className="text-muted-foreground">{m.zones_create_visibility({}, options)}</p>
              </section>
              {labels ? (
                <section className="min-w-0 border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
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
                </section>
              ) : null}
            </div>
          </ContentItemFrame>
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            {result ? (
              <section
                ref={alert}
                tabIndex={-1}
                className="min-w-0 flex-1 space-y-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {command && requestStarter ? (
                  <p className="min-w-0 [overflow-wrap:anywhere]">
                    <span className="text-muted-foreground">{m.zones_create_starter({}, options)}:</span>{' '}
                    <strong lang={pickText(requestStarter.labels, locale).lang ?? undefined}>
                      {pickText(requestStarter.labels, locale).text}
                    </strong>
                  </p>
                ) : null}
                <ZoneFeedback
                  failure={result}
                  locale={locale}
                  retryPending={busy}
                  onRetry={
                    result.kind === 'unavailable' && command && !busy
                      ? (event) => {
                          const activation = settlementFocus.captureActivation(event, event.currentTarget);
                          if (retained.current === command) void send(command, activation);
                        }
                      : undefined
                  }
                />
                {result.kind === 'unavailable' ? <p>{m.zones_create_uncertain({}, options)}</p> : null}
                {result.kind === 'conflict' ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={actionClassName}
                    onClick={(event) => {
                      if (!isCurrent(capture)) return;
                      const activation = settlementFocus.captureActivation(event, event.currentTarget);
                      retained.current = null;
                      setCommand(null);
                      setResult(null);
                      settlementFocus.focusResult(() => choose.current, activation, () => isCurrent(capture));
                    }}
                  >
                    {m.zones_create_review({}, options)}
                  </Button>
                ) : null}
              </section>
            ) : null}
            <Button
              className={actionClassName}
              type="submit"
              disabled={frozen || !canWrite}
              onClick={(event) => {
                submitActivation.current = settlementFocus.captureActivation(event, event.currentTarget);
              }}
            >
              {busy ? m.zones_owner_working({}, options) : m.zones_create_submit({}, options)}
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}
