import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { pickZoneName } from '@rezics/composition';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@rezics/ui/shadcn/alert-dialog';
import { ContentItem } from '@rezics/ui/content-item';
import { cn } from '@rezics/ui/utils';
import { PageHeading } from '../../../shell/page-heading';
import { m } from '../../../paraglide/messages.js';
import { ZoneFeedback } from './feedback';
import { hasValidOwnerCsrfToken, type OwnerCapture, type OwnerLifetime } from '../editor/owner-lifetime';
import {
  listHref,
  zonePaths,
  type CommandOutcome,
  type LifecycleCommand,
  type ListInput,
  type ListOutcome,
  type OwnedZone,
} from './model';

export type WorkspaceProps = {
  locale: string;
  input: ListInput;
  outcome: ListOutcome | null;
  owner?: OwnerLifetime;
  onChange: (command: LifecycleCommand, capture?: OwnerCapture) => Promise<CommandOutcome>;
  onReload: () => void | Promise<void>;
};

// Keep compact desktop navigation while allowing complete labels and touch targets.
const ownerControlClassName =
  'h-auto min-h-8 min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere] py-1 text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
const ownerFeedbackClassName =
  'min-w-0 [overflow-wrap:anywhere] [&_[role=alert]_:is(a,button)]:inline-flex [&_[role=alert]_:is(a,button)]:h-auto [&_[role=alert]_:is(a,button)]:max-w-full [&_[role=alert]_:is(a,button)]:items-center [&_[role=alert]_:is(a,button)]:whitespace-normal [&_[role=alert]_:is(a,button)]:focus-visible:outline-2 [&_[role=alert]_:is(a,button)]:focus-visible:outline-offset-2 [&_[role=alert]_:is(a,button)]:focus-visible:outline-ring max-md:[&_[role=alert]_:is(a,button)]:min-h-11 max-md:[&_[role=alert]_:is(a,button)]:min-w-11 pointer-coarse:[&_[role=alert]_:is(a,button)]:min-h-11 pointer-coarse:[&_[role=alert]_:is(a,button)]:min-w-11';

function DeleteZone({
  zone,
  locale,
  disabled,
  onConfirm,
  isCurrent,
}: {
  zone: OwnedZone;
  locale: string;
  disabled: boolean;
  onConfirm: () => void;
  isCurrent: () => boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = { locale: locale as never };
  const title = pickZoneName(zone, locale).text || m.zones_owner_unnamed({}, options);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (isCurrent()) setOpen(value);
      }}
    >
      <AlertDialogTrigger render={<Button className={ownerControlClassName} variant="ghost" disabled={disabled} />}>
        {m.zones_owner_trash_action({}, options)}
      </AlertDialogTrigger>
      <AlertDialogContent className="min-w-0">
        <AlertDialogHeader className="min-w-0 *:min-w-0 *:max-w-full">
          <AlertDialogTitle className="whitespace-normal [overflow-wrap:anywhere]">
            {m.zones_owner_confirm_title({ title }, options)}
          </AlertDialogTitle>
          <AlertDialogDescription className="whitespace-normal [overflow-wrap:anywhere]">
            {m.zones_owner_confirm_description({}, options)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="min-w-0 sm:flex-wrap">
          <AlertDialogCancel
            className={ownerControlClassName}
            onClick={(event) => {
              if (!isCurrent()) event.preventDefault();
            }}
          >
            {m.zones_owner_cancel({}, options)}
          </AlertDialogCancel>
          <AlertDialogAction
            className={ownerControlClassName}
            variant="destructive"
            onClick={(event) => {
              if (!isCurrent()) {
                event.preventDefault();
                return;
              }
              setOpen(false);
              onConfirm();
            }}
          >
            {m.zones_owner_trash_action({}, options)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const noSubscription = () => () => {};
const fixtureSnapshot = () => null;
export function ZonesOwnerWorkspace(props: WorkspaceProps) {
  const snapshot = useSyncExternalStore(
    props.owner?.subscribe ?? noSubscription,
    props.owner?.snapshot ?? fixtureSnapshot,
    props.owner?.snapshot ?? fixtureSnapshot,
  );
  return <OwnerVisit key={snapshot?.incarnation ?? 'fixture'} {...props} />;
}

function OwnerVisit({ locale, input, outcome, owner, onChange, onReload }: WorkspaceProps) {
  const options = { locale: locale as never };
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const retained = useRef<LifecycleCommand | null>(null);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const [pending, setPending] = useState<LifecycleCommand | null>(null);
  const [result, setResult] = useState<CommandOutcome | null>(null);
  const [now, setNow] = useState(Date.now);
  const paths = zonePaths(locale);
  const capture = owner?.capture();
  const currentRead = !owner || owner.owns(outcome?.ownerObservation);
  const visibleOutcome = owner && !currentRead ? null : outcome;
  useEffect(() => {
    if (outcome?.kind !== 'ready' || !input.deleted || (owner && !owner.isCurrent(capture))) return;
    const deadlines = outcome.page.zones.flatMap((zone) => (zone.restoreUntil ? [Date.parse(zone.restoreUntil)] : []));
    const next = Math.min(...deadlines.filter((deadline) => deadline > Date.now()));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(
      () => {
        if (!owner || owner.isCurrent(capture)) setNow(Date.now());
      },
      Math.min(next - Date.now() + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [outcome, input.deleted, now, owner, capture]);

  async function submit(command: LifecycleCommand) {
    const admission = capture;
    if (owner && !owner.isCurrent(admission)) return;
    if (owner && (!admission || !hasValidOwnerCsrfToken(admission.csrfToken) || !owner.owns(outcome?.ownerObservation)))
      return;
    if (inFlight.current || (retained.current && retained.current !== command)) return;
    const original = retained.current ?? structuredClone(command);
    retained.current = original;
    inFlight.current = true;
    setBusy(true);
    setPending(original);
    let changed: CommandOutcome;
    let received = true;
    try {
      changed = await onChange(structuredClone(original), admission ?? undefined);
    } catch {
      changed = { kind: 'unavailable' };
      received = false;
    }
    const ownerCurrent = !owner || owner.isCurrent(admission);
    const responseMatches =
      !owner ||
      !received ||
      (!!admission &&
        changed.ownerObservation?.reader === admission.observation.reader &&
        changed.ownerObservation?.admission === admission.observation.admission);
    if (!ownerCurrent || !responseMatches) {
      owner?.retire(admission ?? undefined);
      return;
    }
    setResult(changed);
    // Delivery uncertainty retains the original CAS and key; reload never silently retries a command.
    if (changed.kind !== 'unavailable') {
      retained.current = null;
      setPending(null);
    }
    inFlight.current = false;
    setBusy(false);
    if (changed.kind === 'saved') {
      requestAnimationFrame(() => {
        if (!owner || owner.isCurrent(admission)) confirmation.current?.focus();
      });
      try {
        if (!owner || owner.isCurrent(admission)) await onReload();
      } catch {
        /* The native success remains confirmed; the page still offers refresh. */
      }
    }
  }

  const zones = visibleOutcome?.kind === 'ready' ? visibleOutcome.page.zones : [];
  const blocked =
    busy ||
    pending !== null ||
    result?.kind === 'conflict' ||
    !currentRead ||
    (!!owner && (!capture || !hasValidOwnerCsrfToken(capture.csrfToken)));
  async function refresh() {
    if (busy || pending || inFlight.current || retained.current) return;
    const admission = capture;
    if (owner && !owner.isCurrent(admission)) return;
    setBusy(true);
    try {
      await onReload();
      if (!owner || owner.isCurrent(admission)) setResult(null);
    } catch {
      if (!owner || owner.isCurrent(admission))
        setResult({ kind: 'unavailable', ...(admission ? { ownerObservation: admission.observation } : {}) });
    } finally {
      if (!owner || owner.isCurrent(admission)) setBusy(false);
    }
  }
  if (owner && !owner.isCurrent(capture))
    return outcome?.kind === 'signed-out' ? (
      <div className={ownerFeedbackClassName}>
        <ZoneFeedback failure={{ kind: 'signed-out' }} locale={locale} returnTo={listHref(locale, input)} />
      </div>
    ) : (
      <p role="status">{m.zones_owner_loading({}, options)}</p>
    );
  return (
    <article
      onClickCapture={(event) => {
        if (owner && !owner.isCurrent(capture)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className={`mx-auto w-full max-w-3xl space-y-6 text-foreground ${ownerFeedbackClassName}`}
      aria-busy={busy}
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <PageHeading>{m.zones_owner_title({}, options)}</PageHeading>
          <p className="text-muted-foreground">{m.zones_owner_intro({}, options)}</p>
        </div>
        <a className={cn(buttonVariants(), ownerControlClassName)} href={paths.create}>
          {m.zones_owner_create({}, options)}
        </a>
      </header>
      <nav aria-label={m.zones_owner_views({}, options)} className="flex flex-wrap gap-2">
        <a
          className={cn(buttonVariants({ variant: input.deleted ? 'ghost' : 'secondary' }), ownerControlClassName)}
          href={listHref(locale, { deleted: false })}
          aria-current={!input.deleted ? 'page' : undefined}
        >
          {m.zones_owner_active({}, options)}
        </a>
        <a
          className={cn(buttonVariants({ variant: input.deleted ? 'secondary' : 'ghost' }), ownerControlClassName)}
          href={listHref(locale, { deleted: true })}
          aria-current={input.deleted ? 'page' : undefined}
        >
          {m.zones_owner_trash({}, options)}
        </a>
        <Button
          className={ownerControlClassName}
          variant="ghost"
          disabled={busy || pending !== null}
          onClick={() => void refresh()}
        >
          {m.zones_owner_refresh({}, options)}
        </Button>
      </nav>
      {input.deleted ? <p className="text-muted-foreground">{m.zones_owner_trash_help({}, options)}</p> : null}
      {result?.kind === 'saved' ? (
        <p
          className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          ref={confirmation}
          tabIndex={-1}
          role="status"
        >
          {result.zone.deletedAt ? m.zones_owner_trashed({}, options) : m.zones_owner_restored({}, options)}
        </p>
      ) : null}
      {result && result.kind !== 'saved' ? (
        <ZoneFeedback
          failure={result}
          locale={locale}
          onRetry={
            busy
              ? undefined
              : () => {
                  if (pending) {
                    if (retained.current === pending) void submit(pending);
                  } else void refresh();
                }
          }
        />
      ) : null}
      {!visibleOutcome ? (
        <p role="status">{m.zones_owner_loading({}, options)}</p>
      ) : visibleOutcome.kind !== 'ready' ? (
        <ZoneFeedback failure={visibleOutcome} locale={locale} onRetry={() => void refresh()} />
      ) : zones.length === 0 ? (
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">
            {input.deleted ? m.zones_owner_empty_trash({}, options) : m.zones_owner_empty({}, options)}
          </h2>
          <p className="text-muted-foreground">
            {input.deleted ? m.zones_owner_trash_help({}, options) : m.zones_owner_empty_help({}, options)}
          </p>
        </section>
      ) : (
        <ul
          className="space-y-4"
          aria-label={input.deleted ? m.zones_owner_trash({}, options) : m.zones_owner_active({}, options)}
        >
          {zones
            .filter((zone) => result?.kind !== 'saved' || zone.id !== result.zone.id)
            .map((zone) => {
              const name = pickZoneName(zone, locale);
              const title = name.text || m.zones_owner_unnamed({}, options);
              const zoneLinks = zonePaths(locale, zone.id);
              const expired = !zone.restoreUntil || Date.parse(zone.restoreUntil) <= now;
              const visibility = {
                private: m.zones_owner_private,
                unlisted: m.zones_owner_unlisted,
                public: m.zones_owner_public,
              }[zone.visibility];
              return (
                <ContentItem
                  key={zone.id}
                  className="p-3 [&_[data-content-item-slot=title]]:line-clamp-none [&_[data-content-item-slot=title]]:[overflow-wrap:anywhere] [&_[data-content-item-slot=metadata]]:min-w-0 [&_[data-content-item-slot=metadata]>span]:min-w-0 [&_[data-content-item-slot=metadata]>span]:max-w-full [&_[data-content-item-slot=actions]]:max-w-full [&>div]:sm:grid-cols-[minmax(0,1fr)_minmax(0,auto)]"
                  title={title}
                  {...(name.lang ? { titleLang: name.lang } : {})}
                  {...(!input.deleted
                    ? { href: zoneLinks.edit, primaryLinkLabel: m.zones_owner_configure_named({ title }, options) }
                    : {})}
                  metadata={
                    <>
                      <span>{visibility({}, options)}</span>
                      {input.deleted && zone.restoreUntil ? (
                        <span className="[overflow-wrap:anywhere]">
                          {m.zones_owner_deadline({}, options)}{' '}
                          <time className="whitespace-normal" dateTime={zone.restoreUntil}>
                            {new Intl.DateTimeFormat(locale, {
                              dateStyle: 'medium',
                              timeStyle: 'long',
                              timeZone: 'UTC',
                            }).format(new Date(zone.restoreUntil))}
                          </time>
                        </span>
                      ) : null}
                    </>
                  }
                  actions={
                    input.deleted ? (
                      <Button
                        className={ownerControlClassName}
                        variant="outline"
                        disabled={blocked || expired}
                        onClick={() =>
                          void submit({
                            id: zone.id,
                            revision: zone.revision,
                            key: crypto.randomUUID(),
                            operation: 'restore',
                          })
                        }
                      >
                        {busy && pending?.id === zone.id
                          ? m.zones_owner_working({}, options)
                          : m.zones_owner_restore({}, options)}
                      </Button>
                    ) : (
                      <>
                        <a
                          className={cn(buttonVariants({ variant: 'outline' }), ownerControlClassName)}
                          href={zoneLinks.reader}
                        >
                          {m.zones_owner_open({}, options)}
                        </a>
                        <a
                          className={cn(buttonVariants({ variant: 'ghost' }), ownerControlClassName)}
                          href={zoneLinks.edit}
                        >
                          {m.zones_owner_configure({}, options)}
                        </a>
                        <DeleteZone
                          zone={zone}
                          locale={locale}
                          disabled={blocked}
                          isCurrent={() => !owner || owner.isCurrent(capture)}
                          onConfirm={() =>
                            void submit({
                              id: zone.id,
                              revision: zone.revision,
                              key: crypto.randomUUID(),
                              operation: 'delete',
                            })
                          }
                        />
                      </>
                    )
                  }
                  state={input.deleted && expired ? <p role="status">{m.zones_owner_expired({}, options)}</p> : null}
                />
              );
            })}
        </ul>
      )}
      {visibleOutcome?.kind === 'ready' && visibleOutcome.page.next ? (
        <a
          className={cn(buttonVariants({ variant: 'outline' }), ownerControlClassName)}
          href={listHref(locale, { deleted: input.deleted, cursor: visibleOutcome.page.next })}
        >
          {m.zones_owner_next({}, options)}
        </a>
      ) : null}
      {input.cursor ? (
        <a
          className={`flex w-fit items-center rounded-sm underline ${ownerControlClassName}`}
          href={listHref(locale, { deleted: input.deleted })}
        >
          {m.zones_owner_start({}, options)}
        </a>
      ) : null}
    </article>
  );
}
