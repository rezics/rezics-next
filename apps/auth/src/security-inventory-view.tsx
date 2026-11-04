import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@rezics/ui/shadcn/item';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { m } from './paraglide/messages.js';
import { Permission, PermissionLimits, RemovablePermission } from './permission-view';
import {
  loadInventory,
  reduceConsent,
  createConsentReduction,
  type GrantedConsent,
  type InventoryPage,
  type InventoryView,
  type InventoryRows,
  type ConsentOperationBoundary,
  type ConsentReviewOperation,
} from './security-inventory';

export type InventorySource = typeof loadInventory;
type Selection = { consent: GrantedConsent; retained: string[]; confirming: boolean };

function inventoryMessage(kind: Exclude<InventoryPage<InventoryView>['kind'], 'ready'>): string {
  if (kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  if (kind === 'denied') return m.auth_inventory_denied();
  if (kind === 'expired') return m.auth_inventory_expired();
  return m.auth_inventory_unavailable();
}

function InventoryList<V extends InventoryView>({
  view,
  source,
  preflight,
  operation,
  onSessionEnded,
  lifetime,
}: {
  view: V;
  source: InventorySource;
  preflight: boolean;
  operation?: ConsentOperationBoundary;
  onSessionEnded?: (reduced: boolean) => void;
  lifetime?: AbortSignal;
}) {
  const [page, setPage] = useState<InventoryPage<V> | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [reducing, setReducing] = useState(false);
  const generation = useRef(0);
  const phase = useRef<'idle' | 'review' | 'submitting' | 'unknown'>('idle');
  const reviewOperation = useRef<ConsentReviewOperation | null>(null);
  const reviewElement = useRef<HTMLFieldSetElement>(null);
  const heading = view === 'clients' ? m.auth_inventory_clients_heading() : m.auth_inventory_consents_heading();
  const headingId = `inventory-${view}-heading`;

  useLayoutEffect(() => {
    // The containing page can depart without React unmounting (browser cache).
    function retire() {
      generation.current++;
      setPage(null);
      setSelection(null);
      setError('');
      setNotice('');
    }
    lifetime?.addEventListener('abort', retire, { once: true });
    return () => {
      lifetime?.removeEventListener('abort', retire);
      generation.current++;
    };
  }, [lifetime]);

  useEffect(() => {
    if (lifetime?.aborted) return;
    const current = ++generation.current;
    setPending(true);
    setPage(null);
    setSelection(null);
    void source(view)
      .catch(() => ({ kind: 'unavailable' as const }))
      .then((result) => {
        if (generation.current !== current) return;
        setPage(result);
        setPending(false);
      });
    return () => {
      generation.current++;
    };
  }, [source, view, lifetime]);

  useEffect(() => {
    if (!selection) return;
    // Removing a row also removes its focused button. Keep keyboard review in the draft.
    const target = selection.confirming ? reviewElement.current : reviewElement.current?.querySelector('button');
    target?.focus();
  }, [selection]);

  async function navigate(target?: string, direction: 'next' | 'previous' | 'reset' = 'reset') {
    if (lifetime?.aborted || pending || phase.current !== 'idle') return;
    const current = ++generation.current;
    setPending(true);
    setError('');
    setSelection(null);
    const result = await source(view, target).catch(() => ({ kind: 'unavailable' as const }));
    if (generation.current !== current) return;
    setPending(false);
    if (result.kind !== 'ready') {
      // Current authority may have changed; do not keep stale rows after denial.
      setPage(result);
      return;
    }
    setPage(result);
    setHistory((previous) =>
      direction === 'next' ? [...previous, cursor] : direction === 'previous' ? previous.slice(0, -1) : [],
    );
    setCursor(target);
  }

  function select(consent: GrantedConsent, removeAll: boolean) {
    if (lifetime?.aborted || preflight || pending || phase.current !== 'idle') return;
    const held = operation?.begin();
    if (operation && !held) return;
    reviewOperation.current = held ?? null;
    phase.current = 'review';
    // Keep only public inventory fields; drafts never leave this mounted row.
    const snapshot: GrantedConsent = {
      client_id: consent.client_id,
      display_name: consent.display_name,
      granted: [...consent.granted],
      status: consent.status,
      reducible: consent.reducible,
      pending_reduction: consent.pending_reduction,
    };
    setSelection({ consent: snapshot, retained: removeAll ? [] : [...snapshot.granted], confirming: removeAll });
    setError('');
  }

  function finishReview() {
    phase.current = 'idle';
    setSelection(null);
    reviewOperation.current?.finish();
    reviewOperation.current = null;
  }

  function cancelReview() {
    if (phase.current !== 'review') return;
    finishReview();
    setError('');
  }

  async function reduce() {
    if (lifetime?.aborted || !selection?.confirming || preflight || pending || phase.current !== 'review') return;
    if (reviewOperation.current && !reviewOperation.current.isCurrent()) return;
    const { consent, retained } = selection;
    const target = createConsentReduction(consent, retained);
    if (!target) return;
    phase.current = 'submitting';
    setReducing(true);
    setError('');
    const current = generation.current;
    // Refresh the same bounded native inventory page, including current pending,
    // first-party/reducible and availability rules, before the exact native read.
    const fresh = await source(view, cursor).catch(() => ({ kind: 'unavailable' as const }));
    if (generation.current !== current || (reviewOperation.current && !reviewOperation.current.isCurrent())) {
      return;
    }
    const row = fresh.kind === 'ready' ? fresh.rows.find((entry) => entry.client_id === target.clientId) : null;
    const matches =
      row &&
      'granted' in row &&
      row.granted.length === target.current.length &&
      row.granted.every((scope) => target.current.includes(scope)) &&
      createConsentReduction(row, target.retained);
    const result =
      fresh.kind !== 'ready'
        ? {
            kind:
              fresh.kind === 'signed-out'
                ? ('signed-out' as const)
                : fresh.kind === 'unavailable'
                  ? ('unavailable' as const)
                  : ('denied' as const),
          }
        : matches
          ? await reduceConsent(consent, target.retained)
          : { kind: 'denied' as const };
    if (generation.current !== current || (reviewOperation.current && !reviewOperation.current.isCurrent())) return;
    setReducing(false);
    if (result.kind === 'stale-review') {
      setPending(true);
      const updated = await source(view, cursor).catch(() => ({ kind: 'unavailable' as const }));
      if (generation.current !== current) return;
      setPending(false);
      finishReview();
      setError(m.auth_consent_stale_review());
      setPage(updated);
      return;
    }
    if (result.kind === 'unknown') {
      // The native barrier may have ended the session. Keep every page write
      // blocked; neither an inventory reload nor a second click may replay it.
      phase.current = 'unknown';
      setSelection(null);
    } else {
      finishReview();
    }
    if (result.kind === 'accepted') {
      // A historical acknowledgement cannot be patched into the old inventory.
      setNotice(m.auth_inventory_reduced());
      setPage({ kind: 'signed-out' });
      onSessionEnded?.(true);
    } else {
      setError(
        result.kind === 'unknown'
          ? m.auth_inventory_unknown()
          : result.kind === 'denied'
            ? m.auth_inventory_denied()
            : result.kind === 'signed-out'
              ? m.auth_account_operation_sign_in_required()
              : m.auth_inventory_unavailable(),
      );
      setPage({
        kind:
          result.kind === 'signed-out' || result.kind === 'unknown'
            ? 'signed-out'
            : result.kind === 'denied'
              ? 'denied'
              : 'unavailable',
      });
      if (result.kind === 'signed-out') onSessionEnded?.(false);
    }
  }

  function review(row: GrantedConsent) {
    if (!selection || selection.consent.client_id !== row.client_id || preflight) return null;
    const removed = selection.consent.granted.filter((scope) => !selection.retained.includes(scope));
    return (
      <fieldset
        ref={reviewElement}
        tabIndex={-1}
        disabled={reducing || pending}
        className="flex min-w-0 flex-col gap-3 wrap-anywhere"
        aria-busy={reducing}
      >
        <legend className="max-w-full font-semibold wrap-anywhere">
          {m.auth_inventory_review_named({ name: row.display_name?.trim() || m.auth_inventory_unnamed() })}
        </legend>
        {selection.confirming ? (
          <p>
            {selection.retained.length === 0
              ? m.auth_inventory_remove_confirm({ name: row.display_name?.trim() || m.auth_inventory_unnamed() })
              : m.auth_inventory_reduce_confirm({ name: row.display_name?.trim() || m.auth_inventory_unnamed() })}
          </p>
        ) : (
          <>
            <p>{m.auth_inventory_choose_removals()}</p>
            <ul className="flex flex-col gap-3" aria-label={m.auth_inventory_retained()}>
              {selection.retained.map((scope) => (
                <li key={scope} className="grid min-w-0 gap-2">
                  <RemovablePermission
                    scope={scope}
                    onRemove={() =>
                      setSelection((draft) =>
                        draft && !draft.confirming
                          ? { ...draft, retained: draft.retained.filter((entry) => entry !== scope) }
                          : draft,
                      )
                    }
                  />
                </li>
              ))}
            </ul>
          </>
        )}
        {removed.length > 0 ? (
          <div role="status">
            <p>{m.auth_inventory_removed()}</p>
            <ul>
              {removed.map((scope) => (
                <li key={scope} className="grid min-w-0 gap-1">
                  <Permission scope={scope} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {selection.confirming ? (
            <Button type="button" disabled={reducing || pending} aria-busy={reducing} onClick={() => void reduce()}>
              {selection.retained.length === 0 ? m.auth_inventory_remove() : m.auth_inventory_reduce()}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!removed.length || reducing || pending}
              onClick={() => setSelection((draft) => (draft ? { ...draft, confirming: true } : null))}
            >
              {m.auth_inventory_review_removal()}
            </Button>
          )}
          <Button type="button" variant="outline" disabled={reducing || pending} onClick={cancelReview}>
            {m.auth_inventory_cancel()}
          </Button>
        </div>
      </fieldset>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4 text-start">
      <h2 id={headingId} className="font-semibold">
        {heading}
      </h2>
      <p className="text-muted-foreground">
        {view === 'clients' ? m.auth_inventory_clients_description() : m.auth_inventory_consents_description()}
      </p>
      {view === 'consents' ? <PermissionLimits /> : null}
      {preflight && view === 'clients' ? <p>{m.auth_inventory_preflight()}</p> : null}
      {notice ? (
        <Alert role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {pending ? <p role="status">{m.auth_inventory_loading()}</p> : null}
      {page && page.kind !== 'ready' ? (
        <>
          <ErrorAlert>{inventoryMessage(page.kind)}</ErrorAlert>
          {page.kind === 'signed-out' ? (
            <a href="/login">{m.auth_security_sign_in()}</a>
          ) : (
            <Button type="button" variant="outline" disabled={pending} onClick={() => void navigate()}>
              {m.auth_inventory_reload()}
            </Button>
          )}
        </>
      ) : null}
      {page?.kind === 'ready' ? (
        <>
          {!page.rows.length ? (
            <p>{view === 'clients' ? m.auth_inventory_clients_empty() : m.auth_inventory_consents_empty()}</p>
          ) : (
            <ItemGroup aria-label={heading}>
              {page.rows.map((row: InventoryRows[V]) => (
                <Item key={row.client_id} render={<li />} variant="outline">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none wrap-anywhere">
                      {row.display_name?.trim() || m.auth_inventory_unnamed()}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {'disabled' in row
                        ? row.disabled
                          ? m.auth_inventory_client_disabled()
                          : m.auth_inventory_client_owned()
                        : row.pending_reduction
                          ? m.auth_inventory_consent_pending()
                          : row.status === 'unavailable'
                            ? m.auth_inventory_consent_unavailable()
                            : row.status === 'inactive'
                              ? m.auth_inventory_consent_inactive()
                              : m.auth_inventory_consent_current()}
                    </ItemDescription>
                    {'granted' in row && row.granted.length > 0 ? (
                      <>
                        <Badge variant="secondary">
                          {row.granted.length === 1
                            ? m.auth_inventory_permission({ count: 1 })
                            : m.auth_inventory_permissions({ count: row.granted.length })}
                        </Badge>
                        <ul
                          className="grid min-w-0 gap-4"
                          aria-label={
                            row.granted.length === 1
                              ? m.auth_inventory_permission({ count: 1 })
                              : m.auth_inventory_permissions({ count: row.granted.length })
                          }
                        >
                          {row.granted.map((scope) => (
                            <li key={scope} className="grid min-w-0 gap-1">
                              <Permission scope={scope} />
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {'granted' in row &&
                    row.reducible &&
                    row.status === 'current' &&
                    !row.pending_reduction &&
                    row.granted.length > 0 &&
                    !preflight ? (
                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending || reducing || !!selection || operation?.blocked}
                          onClick={() => select(row, false)}
                        >
                          {m.auth_inventory_review_named({
                            name: row.display_name?.trim() || m.auth_inventory_unnamed(),
                          })}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending || reducing || !!selection || operation?.blocked}
                          onClick={() => select(row, true)}
                        >
                          {m.auth_inventory_remove_named({
                            name: row.display_name?.trim() || m.auth_inventory_unnamed(),
                          })}
                        </Button>
                      </div>
                    ) : null}
                    {'granted' in row ? review(row) : null}
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
          <nav aria-label={heading} className="flex flex-wrap gap-3">
            {history.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing || !!selection}
                onClick={() => void navigate(history.at(-1), 'previous')}
              >
                {m.auth_inventory_previous()}
              </Button>
            ) : null}
            {page.next ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing || !!selection}
                onClick={() => void navigate(page.next!, 'next')}
              >
                {m.auth_inventory_next()}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={pending || reducing || !!selection}
              onClick={() => void navigate()}
            >
              {m.auth_inventory_reload()}
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}

/** One bounded page per independent native inventory; ownership never follows consent. */
export function SecurityInventory({
  source = loadInventory,
  preflight = false,
  operation,
  onSessionEnded,
  lifetime,
}: {
  source?: InventorySource;
  preflight?: boolean;
  operation?: ConsentOperationBoundary;
  onSessionEnded?: (reduced: boolean) => void;
  lifetime?: AbortSignal;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <InventoryList view="clients" source={source} preflight={preflight} {...(lifetime ? { lifetime } : {})} />
      <InventoryList
        view="consents"
        source={source}
        preflight={preflight}
        {...(lifetime ? { lifetime } : {})}
        {...(operation ? { operation } : {})}
        {...(onSessionEnded ? { onSessionEnded } : {})}
      />
    </div>
  );
}
