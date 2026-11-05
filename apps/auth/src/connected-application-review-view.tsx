import { useLayoutEffect, useRef, type Ref } from 'react';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@rezics/ui/shadcn/item';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { m } from './paraglide/messages.js';
import {
  useConnectedApplicationReview,
  type ConnectedApplicationReviewOptions,
  type ConnectedApplicationReviewViewProps,
} from './connected-application-review';
import { Permission, PermissionLimits, RemovablePermission } from './permission-view';
import type { ConsentOperationBoundary, ConsentReviewHistory, GrantedConsent } from './security-inventory';
import type { InventoryPage } from './security-inventory';

export function ConnectedApplicationHistory({
  history,
  reference,
}: {
  history: ConsentReviewHistory;
  reference?: Ref<HTMLDivElement>;
}) {
  if (history === 'none') return null;
  const message =
    history === 'unsent'
      ? m.auth_connected_operation_unsent()
      : history === 'dispatched'
        ? m.auth_connected_operation_dispatched()
        : history === 'acknowledged'
          ? m.auth_connected_operation_acknowledged()
          : history === 'refused'
            ? m.auth_connected_operation_refused()
            : m.auth_connected_operation_unknown();
  return (
    <div
      ref={reference}
      tabIndex={-1}
      role="status"
      aria-labelledby="connected-operation-history-heading"
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted/40 p-4 text-start"
    >
      <h2 id="connected-operation-history-heading" className="font-semibold">
        {m.auth_connected_operation_heading()}
      </h2>
      <p>{message}</p>
    </div>
  );
}

function inventoryMessage(kind: Exclude<InventoryPage<'consents'>['kind'], 'ready'>): string {
  if (kind === 'signed-out') return m.auth_account_operation_sign_in_required();
  if (kind === 'denied') return m.auth_inventory_denied();
  if (kind === 'expired') return m.auth_inventory_expired();
  return m.auth_inventory_unavailable();
}

export function ConnectedApplicationReviewView({
  page,
  pending,
  reducing,
  error,
  selection,
  preflight,
  operation,
  reviewElement,
  currentReview,
  focusAcceptedPage,
  focusFailedPage,
  onReviewCurrent,
  onNavigate,
  onReloadCurrent,
  onRetryPage,
  onFirstPage,
  onSelect,
  onRemovePermission,
  onConfirmReview,
  onReduce,
  onCancel,
  canNavigatePrevious,
  previousCursor,
  canReloadCurrent,
  canNavigateFirstPage,
  canRetryPage,
  focusReturnClientId,
  onFocusReturned,
}: ConnectedApplicationReviewViewProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusReturned = useRef(onFocusReturned);
  focusReturned.current = onFocusReturned;

  useLayoutEffect(() => {
    if (!focusAcceptedPage || pending || page?.kind !== 'ready') return;
    headingRef.current?.focus();
  }, [focusAcceptedPage, pending, page]);

  useLayoutEffect(() => {
    if (!focusFailedPage || pending || !canRetryPage || page?.kind === 'ready') return;
    sectionRef.current?.querySelector<HTMLButtonElement>('[data-connected-retry]')?.focus();
  }, [focusFailedPage, pending, canRetryPage, page]);

  useLayoutEffect(() => {
    if (!focusReturnClientId || pending || page?.kind !== 'ready') return;
    const button = [...(sectionRef.current?.querySelectorAll<HTMLButtonElement>('[data-review-client]') ?? [])].find(
      (candidate) => candidate.getAttribute('data-review-client') === focusReturnClientId,
    );
    (button ?? headingRef.current)?.focus();
    focusReturned.current();
  }, [focusReturnClientId, pending, page]);

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
                  <RemovablePermission scope={scope} onRemove={() => onRemovePermission(scope)} />
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
            <Button type="button" disabled={reducing || pending} aria-busy={reducing} onClick={onReduce}>
              {selection.retained.length === 0 ? m.auth_inventory_remove() : m.auth_inventory_reduce()}
            </Button>
          ) : (
            <Button type="button" disabled={removed.length === 0 || reducing || pending} onClick={onConfirmReview}>
              {m.auth_inventory_review_removal()}
            </Button>
          )}
          <Button type="button" variant="outline" disabled={reducing || pending} onClick={onCancel}>
            {m.auth_inventory_cancel()}
          </Button>
        </div>
      </fieldset>
    );
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby="inventory-consents-heading"
      className="flex min-w-0 flex-col gap-4 text-start"
    >
      <h2 id="inventory-consents-heading" ref={headingRef} tabIndex={-1} className="font-semibold">
        {m.auth_inventory_consents_heading()}
      </h2>
      <p className="text-muted-foreground">{m.auth_inventory_consents_description()}</p>
      <PermissionLimits />
      {error ? <ErrorAlert>{error}</ErrorAlert> : null}
      {pending ? <p role="status">{m.auth_inventory_loading()}</p> : null}
      {page && page.kind !== 'ready' ? (
        <>
          <ErrorAlert>{inventoryMessage(page.kind)}</ErrorAlert>
          {page.kind === 'signed-out' ? <a href="/login">{m.auth_security_sign_in()}</a> : null}
          <div className="flex flex-wrap gap-3">
            {canRetryPage ? (
              <Button
                type="button"
                variant="outline"
                data-connected-retry
                disabled={pending || reducing || !!selection}
                onClick={onRetryPage}
              >
                {m.auth_connected_retry_page()}
              </Button>
            ) : null}
            {canReloadCurrent ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing || !!selection}
                onClick={onReloadCurrent}
              >
                {m.auth_connected_reload_current()}
              </Button>
            ) : null}
            {canNavigateFirstPage ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing || !!selection}
                onClick={onFirstPage}
              >
                {m.auth_connected_first_page()}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {!page && !pending && currentReview ? (
        <Button type="button" variant="outline" disabled={pending} onClick={onReviewCurrent}>
          {m.auth_connected_review_current()}
        </Button>
      ) : null}
      {page?.kind === 'ready' ? (
        <>
          <p role="status">{m.auth_connected_page_count({ count: page.rows.length })}</p>
          {!page.rows.length ? (
            <p>{m.auth_inventory_consents_empty()}</p>
          ) : (
            <ItemGroup aria-label={m.auth_inventory_consents_heading()}>
              {page.rows.map((row) => (
                <Item key={row.client_id} render={<li />} variant="outline">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="line-clamp-none wrap-anywhere">
                      {row.display_name?.trim() || m.auth_inventory_unnamed()}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {row.pending_reduction
                        ? m.auth_inventory_consent_pending()
                        : row.status === 'unavailable'
                          ? m.auth_inventory_consent_unavailable()
                          : row.status === 'inactive'
                            ? m.auth_inventory_consent_inactive()
                            : m.auth_inventory_consent_current()}
                    </ItemDescription>
                    {row.granted.length > 0 ? (
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
                    {row.reducible &&
                    row.status === 'current' &&
                    !row.pending_reduction &&
                    row.granted.length > 0 &&
                    !preflight ? (
                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          data-review-client={row.client_id}
                          disabled={pending || reducing || !!selection || operation?.blocked}
                          onClick={() => onSelect(row, false)}
                        >
                          {m.auth_inventory_review_named({
                            name: row.display_name?.trim() || m.auth_inventory_unnamed(),
                          })}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          data-review-client={row.client_id}
                          disabled={pending || reducing || !!selection || operation?.blocked}
                          onClick={() => onSelect(row, true)}
                        >
                          {m.auth_inventory_remove_named({
                            name: row.display_name?.trim() || m.auth_inventory_unnamed(),
                          })}
                        </Button>
                      </div>
                    ) : null}
                    {review(row)}
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          )}
          <nav aria-label={m.auth_inventory_consents_heading()} className="flex flex-wrap gap-3">
            {canNavigatePrevious ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing || !!selection}
                onClick={() => onNavigate(previousCursor, 'previous')}
              >
                {m.auth_inventory_previous()}
              </Button>
            ) : null}
            {page.next ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing || !!selection}
                onClick={() => onNavigate(page.next!, 'next')}
              >
                {m.auth_inventory_next()}
              </Button>
            ) : null}
            {canNavigateFirstPage ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing || !!selection}
                onClick={onFirstPage}
              >
                {m.auth_connected_first_page()}
              </Button>
            ) : null}
            {canReloadCurrent ? (
              <Button
                type="button"
                variant="outline"
                disabled={pending || reducing || !!selection}
                onClick={onReloadCurrent}
              >
                {m.auth_connected_reload_current()}
              </Button>
            ) : null}
          </nav>
        </>
      ) : null}
    </section>
  );
}

export function ConnectedApplicationReview(options: ConnectedApplicationReviewOptions) {
  return <ConnectedApplicationReviewView {...useConnectedApplicationReview(options)} />;
}
