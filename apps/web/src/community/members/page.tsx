import { useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { RealmMembersVisit } from './visit';
import { boundedRealmMemberPage, type MemberIdentity, type RealmMembersSource } from './source';

export type MembersCaller = {
  current: () => boolean;
  subscribe?: (listener: () => void) => () => void;
};
const standalone: MembersCaller = { current: () => true };

function Identity({ identity }: { identity: MemberIdentity }) {
  return (
    <div className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
      <p className="font-semibold">
        <bdi>{identity.label}</bdi>
      </p>
      <p className="font-mono text-sm text-muted-foreground">
        <bdi>{identity.reference}</bdi>
      </p>
    </div>
  );
}

/** Supplied sources are composition fixtures until the native producer is published. */
export function RealmMembersPage({
  realmId,
  source = boundedRealmMemberPage,
  caller = standalone,
  locale = getLocale(),
}: {
  realmId: string;
  source?: RealmMembersSource;
  caller?: MembersCaller;
  locale?: string;
}) {
  const visit = useMemo(
    () => new RealmMembersVisit(realmId, source, caller.current, caller.subscribe),
    [realmId, source, caller, locale],
  );
  const previous = useRef(visit);
  if (previous.current !== visit) {
    previous.current.retire();
    previous.current = visit;
  }
  const snapshot = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  useLayoutEffect(() => visit.connect(), [visit]);
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const inspection = useRef<HTMLHeadingElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<{ visit: RealmMembersVisit; accountId: string; from: Element | null } | null>(null);
  const selectedAddress = snapshot.selection?.address;
  const lastFocused = useRef<typeof selectedAddress>(undefined);
  useLayoutEffect(() => {
    if (!selectedAddress || lastFocused.current === selectedAddress || !caller.current()) return;
    lastFocused.current = selectedAddress;
    inspection.current?.focus();
  }, [selectedAddress, caller]);
  useLayoutEffect(() => {
    const request = returnFocus.current;
    if (!request || snapshot.selection) return;
    returnFocus.current = null;
    if (
      request.visit !== visit ||
      !caller.current() ||
      (document.activeElement !== request.from && document.activeElement !== document.body)
    )
      return;
    const button = visit.hasRow(request.accountId) ? rowButtons.current.get(request.accountId) : null;
    if (button?.isConnected) button.focus();
    else heading.current?.focus();
  }, [snapshot, visit, caller]);

  function close() {
    const address = snapshot.selection?.address;
    if (address) returnFocus.current = { visit, accountId: address.accountId, from: document.activeElement };
    visit.closeSelection();
    lastFocused.current = undefined;
  }

  const { read, selection } = snapshot;
  const selected = selection?.read;
  return (
    <article className="min-w-0 max-w-3xl space-y-6 text-foreground [overflow-wrap:anywhere]">
      <header className="space-y-2">
        <h1 id={id} ref={heading} tabIndex={-1} className="text-3xl font-semibold">
          {m.realm_members_heading()}
        </h1>
        <p className="max-w-prose text-muted-foreground">{m.realm_members_management_only()}</p>
        {read.kind === 'ready' ? (
          <p>
            <bdi>{read.page.realm.label}</bdi>
          </p>
        ) : null}
      </header>
      {selection && selected ? (
        <section
          aria-labelledby={`${id}-inspection`}
          className="space-y-5 rounded-xl border p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          <h2 id={`${id}-inspection`} ref={inspection} tabIndex={-1} className="text-xl font-semibold">
            {m.realm_members_inspection()}
          </h2>
          {selected.kind === 'ready' ? (
            <>
              <Identity identity={selected.identity} />
              <p>{selected.membership === 'current' ? m.realm_members_current() : m.realm_members_pending()}</p>
              <p className="text-sm text-muted-foreground">{m.realm_members_actions_unavailable()}</p>
            </>
          ) : (
            <p role="status">
              {selected.kind === 'loading'
                ? m.realm_members_loading()
                : selected.kind === 'concealed'
                  ? m.realm_members_concealed()
                  : selected.kind === 'changed'
                    ? m.realm_members_changed()
                    : selected.kind === 'failed'
                      ? m.realm_members_selected_failed()
                      : m.realm_members_selected_unavailable()}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {selected.kind === 'failed' || selected.kind === 'unavailable' ? (
              <Button
                variant="outline"
                className="min-h-11 whitespace-normal"
                onClick={() => void visit.retrySelected()}
              >
                {m.realm_members_retry_selected()}
              </Button>
            ) : null}
            <Button variant="outline" className="min-h-11 whitespace-normal" onClick={close}>
              {m.realm_members_back()}
            </Button>
          </div>
        </section>
      ) : read.kind === 'ready' ? (
        <section aria-labelledby={id} className="space-y-5">
          {read.page.rows.length ? (
            <ul className="space-y-3">
              {read.page.rows.map((row, index) => (
                <li
                  key={row.kind === 'concealed' ? `concealed-${index}` : row.identity.accountId}
                  className="min-w-0 space-y-3 rounded-xl border p-4"
                >
                  {row.kind === 'concealed' ? (
                    <p>{m.realm_members_concealed()}</p>
                  ) : (
                    <>
                      <Identity identity={row.identity} />
                      <p className="text-sm">
                        {row.membership === 'current' ? m.realm_members_current() : m.realm_members_pending()}
                      </p>
                      <Button
                        ref={(node) => {
                          if (node) rowButtons.current.set(row.identity.accountId, node);
                          else rowButtons.current.delete(row.identity.accountId);
                        }}
                        variant="outline"
                        className="min-h-11 max-w-full whitespace-normal text-start"
                        aria-label={m.realm_members_inspect_account({ account: row.identity.reference })}
                        onClick={() => void visit.select(row.identity.accountId)}
                      >
                        {m.realm_members_inspect()}
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p role="status">{read.page.next !== null ? m.realm_members_sparse() : m.realm_members_empty()}</p>
          )}
          <nav aria-label={m.realm_members_heading()} className="flex flex-wrap gap-3">
            {read.page.next !== null ? (
              <Button variant="outline" className="min-h-11 whitespace-normal" onClick={() => void visit.more()}>
                {m.realm_members_more()}
              </Button>
            ) : null}
            <Button variant="ghost" className="min-h-11 whitespace-normal" onClick={() => void visit.refresh()}>
              {m.realm_members_refresh()}
            </Button>
          </nav>
        </section>
      ) : (
        <section aria-labelledby={id} className="space-y-4">
          <p role="status">
            {read.kind === 'loading'
              ? m.realm_members_loading()
              : read.kind === 'denied'
                ? m.realm_members_denied()
                : read.kind === 'preparing'
                  ? m.realm_members_preparing()
                  : read.kind === 'retired'
                    ? m.realm_members_retired()
                    : read.kind === 'failed'
                      ? m.realm_members_failed()
                      : m.realm_members_unavailable()}
          </p>
          {read.kind === 'failed' || read.kind === 'unavailable' || read.kind === 'preparing' ? (
            <Button variant="outline" className="min-h-11 whitespace-normal" onClick={() => void visit.retryPage()}>
              {m.realm_members_retry_page()}
            </Button>
          ) : null}
        </section>
      )}
    </article>
  );
}
