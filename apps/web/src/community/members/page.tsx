import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import type { FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { RealmMembersVisit } from './visit';
import { boundedRealmMemberPage, type MemberIdentity, type RealmMembersSource } from './source';
import { MemberAddition } from './addition';
import { SelectedRealmMemberContext } from './selected-account';
import { RealmBansPanel } from '../realm-bans-panel';
import { addSelectedRealmMember } from './commands';

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
  const [accountIdDraft, setAccountIdDraft] = useState('');
  const [accountIdInvalid, setAccountIdInvalid] = useState(false);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<{ visit: RealmMembersVisit; accountId: string; from: Element | null } | null>(null);
  const selectedAddress = snapshot.selection?.address;
  const lastFocused = useRef<typeof selectedAddress>(undefined);
  useLayoutEffect(() => {
    if (!selectedAddress || lastFocused.current === selectedAddress || !visit.isCurrent()) return;
    lastFocused.current = selectedAddress;
    inspection.current?.focus();
  }, [selectedAddress, visit]);
  useLayoutEffect(() => {
    const request = returnFocus.current;
    if (!request || snapshot.selection) return;
    returnFocus.current = null;
    if (
      request.visit !== visit ||
      !visit.isCurrent() ||
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
  const actionableSelected = selected?.kind === 'ready' ? selected : selection?.previous;
  const selectedMember = useMemo(() => {
    if (read.kind !== 'ready' || !selection || selected?.kind !== 'ready') return null;
    const address = selection.address;
    const value = Object.freeze({
      realmId: address.realmId,
      realmLabel: read.page.realm.label,
      accountId: selected.identity.accountId,
      reference: selected.identity.reference,
      label: selected.identity.label,
      membershipInterval: selected.membershipInterval,
      authority: address.authority,
      advice: { ban: selected.advice.ban, unban: selected.advice.unban },
      current: () => {
        if (!visit.isCurrent()) return false;
        const current = visit.snapshot();
        const currentSelection = current.selection;
        return (
          current.read.kind === 'ready' &&
          currentSelection?.read.kind === 'ready' &&
          currentSelection.address.realmId === address.realmId &&
          currentSelection.address.accountId === address.accountId &&
          currentSelection.address.authority === address.authority &&
          (address.membershipInterval === undefined ||
            currentSelection.address.membershipInterval === address.membershipInterval) &&
          currentSelection.read.identity.accountId === selected.identity.accountId &&
          currentSelection.read.identity.reference === selected.identity.reference &&
          currentSelection.read.identity.label === selected.identity.label &&
          currentSelection.read.membershipInterval === selected.membershipInterval &&
          currentSelection.read.membership === selected.membership &&
          currentSelection.read.advice.add === selected.advice.add &&
          currentSelection.read.advice.ban === selected.advice.ban &&
          currentSelection.read.advice.unban === selected.advice.unban
        );
      },
      subscribe: visit.subscribe,
    });
    return value;
  }, [read, selection, selected, visit]);

  function inspectAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accountId = accountIdDraft.trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(accountId)) {
      setAccountIdInvalid(true);
      return;
    }
    setAccountIdDraft('');
    setAccountIdInvalid(false);
    void visit.inspectAccount(accountId);
  }

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
      {read.kind === 'ready' && !selection ? (
        <form className="flex max-w-xl flex-wrap items-end gap-3" onSubmit={inspectAccount}>
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor={`${id}-account`} className="text-sm font-medium">
              {m.realm_bans_inspect_account()}
            </label>
            <input
              id={`${id}-account`}
              className="min-h-11 w-full rounded-md border bg-background px-3"
              autoComplete="off"
              spellCheck={false}
              maxLength={36}
              value={accountIdDraft}
              onChange={(event) => {
                setAccountIdDraft(event.target.value);
                setAccountIdInvalid(false);
              }}
            />
          </div>
          <Button type="submit" variant="outline" className="min-h-11 whitespace-normal">
            {m.realm_members_lookup_account()}
          </Button>
          {accountIdInvalid ? (
            <p role="alert" className="w-full text-sm">
              {m.realm_members_invalid_account_id()}
            </p>
          ) : null}
        </form>
      ) : null}
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
          {actionableSelected && read.kind === 'ready' ? (
            <MemberAddition
              key={`${selection.address.accountId}:${selection.address.authority}:${selection.address.membershipInterval ?? 'entered'}`}
              realmLabel={read.page.realm.label}
              selected={actionableSelected}
              address={selection.address}
              current={() => selected?.kind === 'ready' && selectedMember?.current() === true}
              sameSelection={() => {
                if (!visit.isCurrent()) return false;
                const current = visit.snapshot().selection?.address;
                return (
                  current?.realmId === selection.address.realmId &&
                  current.accountId === selection.address.accountId &&
                  current.authority === selection.address.authority &&
                  current.membershipInterval === selection.address.membershipInterval
                );
              }}
              addMember={source.addMember ?? addSelectedRealmMember}
              refreshSelected={visit.refreshSelected}
            />
          ) : null}
          {selected.kind === 'ready' ? (
            <>
              <Identity identity={selected.identity} />
              <p>
                {selected.membership === 'current'
                  ? m.realm_members_current()
                  : selected.membership === 'pending'
                    ? m.realm_members_pending()
                    : selected.membership === 'none'
                      ? m.realm_members_nonmember()
                      : m.realm_members_actions_unavailable()}
              </p>
              {read.kind === 'ready' && selected.kind === 'ready' ? (
                <SelectedRealmMemberContext.Provider value={selectedMember}>
                  <div className="space-y-4">
                    {selected.advice.ban === 'available' || selected.advice.unban === 'available' ? (
                      <RealmBansPanel realmId={realmId} />
                    ) : selected.advice.ban === 'unknown' || selected.advice.unban === 'unknown' ? (
                      <p role="status" className="text-sm text-muted-foreground">
                        {m.realm_members_actions_unavailable()}
                      </p>
                    ) : null}
                  </div>
                </SelectedRealmMemberContext.Provider>
              ) : null}
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
