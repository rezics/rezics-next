import { useEffect, useRef, useState } from 'react';
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
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { PageHeading } from '../../../shell/page-heading';
import { m } from '../../../paraglide/messages.js';
import { ZoneFeedback } from './feedback';
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
  onChange: (command: LifecycleCommand) => Promise<CommandOutcome>;
  onReload: () => void | Promise<void>;
};

function DeleteZone({
  zone,
  locale,
  disabled,
  onConfirm,
}: {
  zone: OwnedZone;
  locale: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const options = { locale: locale as never };
  const title = pickZoneName(zone, locale).text || m.zones_owner_unnamed({}, options);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button variant="ghost" disabled={disabled} />}>
        {m.zones_owner_trash_action({}, options)}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.zones_owner_confirm_title({ title }, options)}</AlertDialogTitle>
          <AlertDialogDescription>{m.zones_owner_confirm_description({}, options)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.zones_owner_cancel({}, options)}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
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

export function ZonesOwnerWorkspace({ locale, input, outcome, onChange, onReload }: WorkspaceProps) {
  const options = { locale: locale as never };
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const confirmation = useRef<HTMLParagraphElement>(null);
  const [pending, setPending] = useState<LifecycleCommand | null>(null);
  const [result, setResult] = useState<CommandOutcome | null>(null);
  const [now, setNow] = useState(Date.now);
  const paths = zonePaths(locale);
  useEffect(() => {
    if (outcome?.kind !== 'ready' || !input.deleted) return;
    const deadlines = outcome.page.zones.flatMap((zone) => (zone.restoreUntil ? [Date.parse(zone.restoreUntil)] : []));
    const next = Math.min(...deadlines.filter((deadline) => deadline > Date.now()));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(next - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [outcome, input.deleted, now]);

  async function submit(command: LifecycleCommand) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPending(command);
    let changed: CommandOutcome;
    try {
      changed = await onChange(command);
    } catch {
      changed = { kind: 'unavailable' };
    }
    setResult(changed);
    // Delivery uncertainty retains the original CAS and key; reload never silently retries a command.
    if (changed.kind !== 'unavailable') setPending(null);
    inFlight.current = false;
    setBusy(false);
    if (changed.kind === 'saved') {
      requestAnimationFrame(() => confirmation.current?.focus());
      try {
        await onReload();
      } catch {
        /* The native success remains confirmed; the page still offers refresh. */
      }
    }
  }

  const zones = outcome?.kind === 'ready' ? outcome.page.zones : [];
  const blocked = busy || pending !== null || result?.kind === 'conflict';
  async function refresh() {
    if (busy || pending) return;
    setBusy(true);
    try {
      await onReload();
      setResult(null);
    } catch {
      setResult({ kind: 'unavailable' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="mx-auto w-full max-w-3xl space-y-6 text-foreground" aria-busy={busy}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3">
          <PageHeading>{m.zones_owner_title({}, options)}</PageHeading>
          <p className="text-muted-foreground">{m.zones_owner_intro({}, options)}</p>
        </div>
        <a className={buttonVariants()} href={paths.create}>
          {m.zones_owner_create({}, options)}
        </a>
      </header>
      <nav aria-label={m.zones_owner_views({}, options)} className="flex flex-wrap gap-2">
        <a
          className={buttonVariants({ variant: input.deleted ? 'ghost' : 'secondary' })}
          href={listHref(locale, { deleted: false })}
          aria-current={!input.deleted ? 'page' : undefined}
        >
          {m.zones_owner_active({}, options)}
        </a>
        <a
          className={buttonVariants({ variant: input.deleted ? 'secondary' : 'ghost' })}
          href={listHref(locale, { deleted: true })}
          aria-current={input.deleted ? 'page' : undefined}
        >
          {m.zones_owner_trash({}, options)}
        </a>
        <Button variant="ghost" disabled={busy || pending !== null} onClick={() => void refresh()}>
          {m.zones_owner_refresh({}, options)}
        </Button>
      </nav>
      {input.deleted ? <p className="text-muted-foreground">{m.zones_owner_trash_help({}, options)}</p> : null}
      {result?.kind === 'saved' ? (
        <p ref={confirmation} tabIndex={-1} role="status">
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
                  if (pending) void submit(pending);
                  else void refresh();
                }
          }
        />
      ) : null}
      {!outcome ? (
        <p role="status">{m.zones_owner_loading({}, options)}</p>
      ) : outcome.kind !== 'ready' ? (
        <ZoneFeedback failure={outcome} locale={locale} onRetry={() => void refresh()} />
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
              const title = pickZoneName(zone, locale).text || m.zones_owner_unnamed({}, options);
              const zoneLinks = zonePaths(locale, zone.id);
              const expired = !zone.restoreUntil || Date.parse(zone.restoreUntil) <= now;
              const visibility = {
                private: m.zones_owner_private,
                unlisted: m.zones_owner_unlisted,
                public: m.zones_owner_public,
              }[zone.visibility];
              return (
                <ListRow key={zone.id} className="space-y-3 p-3">
                  <h2 className="text-xl font-semibold break-words">{title}</h2>
                  <p className="text-sm text-muted-foreground">{visibility({}, options)}</p>
                  {!input.deleted ? (
                    <ListRowLink href={zoneLinks.edit}>{m.zones_owner_configure_named({ title }, options)}</ListRowLink>
                  ) : null}
                  {input.deleted && zone.restoreUntil ? (
                    <p className="text-sm text-muted-foreground">
                      {m.zones_owner_deadline({}, options)}{' '}
                      <time dateTime={zone.restoreUntil}>
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: 'medium',
                          timeStyle: 'long',
                          timeZone: 'UTC',
                        }).format(new Date(zone.restoreUntil))}
                      </time>
                    </p>
                  ) : null}
                  <ListRowControl className="flex flex-wrap gap-2">
                    {input.deleted ? (
                      <Button
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
                        <a className={buttonVariants({ variant: 'outline' })} href={zoneLinks.reader}>
                          {m.zones_owner_open({}, options)}
                        </a>
                        <a className={buttonVariants({ variant: 'ghost' })} href={zoneLinks.edit}>
                          {m.zones_owner_configure({}, options)}
                        </a>
                        <DeleteZone
                          zone={zone}
                          locale={locale}
                          disabled={blocked}
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
                    )}
                  </ListRowControl>
                  {input.deleted && expired ? <p role="status">{m.zones_owner_expired({}, options)}</p> : null}
                </ListRow>
              );
            })}
        </ul>
      )}
      {outcome?.kind === 'ready' && outcome.page.next ? (
        <a
          className={buttonVariants({ variant: 'outline' })}
          href={listHref(locale, { deleted: input.deleted, cursor: outcome.page.next })}
        >
          {m.zones_owner_next({}, options)}
        </a>
      ) : null}
      {input.cursor ? (
        <a className="block underline" href={listHref(locale, { deleted: input.deleted })}>
          {m.zones_owner_start({}, options)}
        </a>
      ) : null}
    </article>
  );
}
