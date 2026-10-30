import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@rezics/ui/shadcn/item';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { m } from './paraglide/messages.js';
import {
  loadInventory,
  removeConsent,
  type GrantedConsent,
  type InventoryPage,
  type InventoryView,
  type InventoryRows,
} from './security-inventory';

export type InventorySource = typeof loadInventory;
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
}: {
  view: V;
  source: InventorySource;
  preflight: boolean;
}) {
  const [page, setPage] = useState<InventoryPage<V> | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selection, setSelection] = useState<GrantedConsent | null>(null);
  const [reducing, setReducing] = useState(false);
  const generation = useRef(0);
  const heading = view === 'clients' ? m.auth_inventory_clients_heading() : m.auth_inventory_consents_heading();
  const headingId = `inventory-${view}-heading`;

  useEffect(() => {
    const current = ++generation.current;
    setPending(true);
    void source(view).then((result) => {
      if (generation.current !== current) return;
      setPage(result);
      setPending(false);
    });
    return () => {
      generation.current++;
    };
  }, [source, view]);

  async function navigate(target?: string, direction: 'next' | 'previous' | 'reset' = 'reset') {
    if (pending || reducing) return;
    const current = ++generation.current;
    setPending(true);
    setError('');
    setSelection(null);
    const result = await source(view, target);
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

  async function reduce() {
    if (!selection || pending || reducing) return;
    setReducing(true);
    setError('');
    const result = await removeConsent(selection);
    setReducing(false);
    setSelection(null);
    if (result.kind === 'accepted') {
      // Consent reduction fences authentication. A historical receipt is not
      // a current inventory snapshot and cannot be patched into the old list.
      setNotice(m.auth_inventory_reduced());
      setPage({ kind: 'signed-out' });
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
      if (result.kind === 'signed-out') setPage({ kind: 'signed-out' });
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4 text-start">
      <h2 id={headingId} className="font-semibold">
        {heading}
      </h2>
      <p className="text-muted-foreground">
        {view === 'clients' ? m.auth_inventory_clients_description() : m.auth_inventory_consents_description()}
      </p>
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
                      <Badge variant="secondary">{m.auth_inventory_permissions({ count: row.granted.length })}</Badge>
                    ) : null}
                    {'granted' in row &&
                    row.reducible &&
                    row.status === 'current' &&
                    !row.pending_reduction &&
                    row.granted.length > 0 &&
                    !preflight ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending || reducing}
                        onClick={() => {
                          setSelection(row);
                          setError('');
                        }}
                      >
                        {m.auth_inventory_remove_named({
                          name: row.display_name?.trim() || m.auth_inventory_unnamed(),
                        })}
                      </Button>
                    ) : null}
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
          {selection ? (
            <Alert>
              <AlertDescription className="flex flex-col gap-3">
                <p>
                  {m.auth_inventory_remove_confirm({
                    name: selection.display_name?.trim() || m.auth_inventory_unnamed(),
                  })}
                </p>
                <div className="flex flex-wrap gap-3">
                  <Button type="button" disabled={reducing} aria-busy={reducing} onClick={() => void reduce()}>
                    {m.auth_inventory_remove()}
                  </Button>
                  <Button type="button" variant="outline" disabled={reducing} onClick={() => setSelection(null)}>
                    {m.auth_inventory_cancel()}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          <nav aria-label={heading} className="flex flex-wrap gap-3">
            {history.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing}
                onClick={() => void navigate(history.at(-1), 'previous')}
              >
                {m.auth_inventory_previous()}
              </Button>
            ) : null}
            {page.next ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing}
                onClick={() => void navigate(page.next!, 'next')}
              >
                {m.auth_inventory_next()}
              </Button>
            ) : null}
            <Button type="button" variant="outline" disabled={pending || reducing} onClick={() => void navigate()}>
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
}: {
  source?: InventorySource;
  preflight?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <InventoryList view="clients" source={source} preflight={preflight} />
      <InventoryList view="consents" source={source} preflight={preflight} />
    </div>
  );
}
