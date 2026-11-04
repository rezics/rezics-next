import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@rezics/ui/shadcn/item';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { m } from './paraglide/messages.js';
import { loadInventory, type ConsentOperationBoundary, type InventoryPage } from './security-inventory';
import { ConnectedApplicationReview } from './connected-application-review-view';

export type InventorySource = typeof loadInventory;

function inventoryMessage(kind: Exclude<InventoryPage<'clients'>['kind'], 'ready'>): string {
  if (kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  if (kind === 'denied') return m.auth_inventory_denied();
  if (kind === 'expired') return m.auth_inventory_expired();
  return m.auth_inventory_unavailable();
}

function OwnedClientInventory({
  source,
  preflight,
  lifetime,
}: {
  source: InventorySource;
  preflight: boolean;
  lifetime?: AbortSignal;
}) {
  const [page, setPage] = useState<InventoryPage<'clients'> | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const pendingRef = useRef(false);

  useLayoutEffect(() => {
    function retire() {
      generation.current++;
      pendingRef.current = false;
      setPage(null);
      setCursor(undefined);
      setHistory([]);
      setError('');
      setPending(false);
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
    pendingRef.current = true;
    setPending(true);
    setPage(null);
    void source('clients')
      .catch((): InventoryPage<'clients'> => ({ kind: 'unavailable' }))
      .then((result) => {
        if (generation.current !== current) return;
        pendingRef.current = false;
        setPage(result);
        setPending(false);
      });
    return () => {
      generation.current++;
    };
  }, [source, lifetime]);

  async function navigate(target?: string, direction: 'next' | 'previous' | 'reset' = 'reset') {
    if (lifetime?.aborted || pendingRef.current) return;
    pendingRef.current = true;
    const current = ++generation.current;
    setPending(true);
    setError('');
    const result = await source('clients', target).catch(
      (): InventoryPage<'clients'> => ({ kind: 'unavailable' }),
    );
    if (generation.current !== current) return;
    pendingRef.current = false;
    setPending(false);
    setPage(result);
    if (result.kind !== 'ready') return;
    setHistory((previous) =>
      direction === 'next' ? [...previous, cursor] : direction === 'previous' ? previous.slice(0, -1) : [],
    );
    setCursor(target);
  }

  return (
    <section aria-labelledby="inventory-clients-heading" className="flex min-w-0 flex-col gap-4 text-start">
      <h2 id="inventory-clients-heading" className="font-semibold">
        {m.auth_inventory_clients_heading()}
      </h2>
      <p className="text-muted-foreground">{m.auth_inventory_clients_description()}</p>
      {preflight ? <p>{m.auth_inventory_preflight()}</p> : null}
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {pending ? <p role="status">{m.auth_inventory_loading()}</p> : null}
      {page && page.kind !== 'ready' ? (
        <>
          <ErrorAlert>{inventoryMessage(page.kind)}</ErrorAlert>
          <Button type="button" variant="outline" disabled={pending} onClick={() => void navigate()}>
            {m.auth_inventory_reload()}
          </Button>
        </>
      ) : null}
      {page?.kind === 'ready' ? (
        <>
          {!page.rows.length ? (
            <p>{m.auth_inventory_clients_empty()}</p>
          ) : (
            <ItemGroup aria-label={m.auth_inventory_clients_heading()}>
              {page.rows.map((row) => (
                <Item key={row.client_id} render={<li />} variant="outline">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none wrap-anywhere">
                      {row.display_name?.trim() || m.auth_inventory_unnamed()}
                    </ItemTitle>
                    <ItemDescription>
                      {row.disabled ? m.auth_inventory_client_disabled() : m.auth_inventory_client_owned()}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
          <nav aria-label={m.auth_inventory_clients_heading()} className="flex flex-wrap gap-3">
            {history.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void navigate(history.at(-1), 'previous')}
              >
                {m.auth_inventory_previous()}
              </Button>
            ) : null}
            {page.next ? (
              <Button type="button" variant="outline" disabled={pending} onClick={() => void navigate(page.next!, 'next')}>
                {m.auth_inventory_next()}
              </Button>
            ) : null}
            <Button type="button" variant="outline" disabled={pending} onClick={() => void navigate()}>
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
  onSessionEnded?: () => void;
  lifetime?: AbortSignal;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <OwnedClientInventory source={source} preflight={preflight} {...(lifetime ? { lifetime } : {})} />
      <ConnectedApplicationReview
        source={source}
        preflight={preflight}
        {...(operation ? { operation } : {})}
        {...(onSessionEnded ? { onSessionEnded } : {})}
        {...(lifetime ? { lifetime } : {})}
      />
    </div>
  );
}
