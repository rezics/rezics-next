import { useId, useLayoutEffect, useRef } from 'react';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Item, ItemContent, ItemGroup } from '@rezics/ui/shadcn/item';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import { Permission } from './permission-view';
import { useOwnedApplicationReview, type OwnedApplicationReviewOptions } from './owned-application-review';

export function OwnedApplicationReview(options: OwnedApplicationReviewOptions) {
  const review = useOwnedApplicationReview(options);
  const id = useId();
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const section = useRef<HTMLElement>(null);
  const { observation } = review;
  const pending = observation.kind === 'loading';
  const page = observation.kind === 'ready' ? observation.page : null;
  const failure = observation.kind === 'failed' ? observation.failure : null;
  const retired = observation.kind === 'retired';

  useLayoutEffect(() => {
    if (review.expanded) detailsHeading.current?.focus();
  }, [review.expanded]);

  function close(clientId: string, index: number) {
    review.toggle(clientId);
    section.current?.querySelector<HTMLButtonElement>(`[data-owned-control="${index}"]`)?.focus();
  }

  const failureText =
    failure === 'signed-out'
      ? m.auth_account_operation_sign_in_required()
      : failure === 'denied'
        ? m.auth_inventory_denied()
        : failure === 'expired'
          ? m.auth_owned_expired()
          : m.auth_inventory_unavailable();
  const copyText =
    review.copy === 'pending'
      ? m.auth_owned_copy_pending()
      : review.copy === 'copied'
        ? m.auth_owned_copied()
        : review.copy === 'failed'
          ? m.auth_owned_copy_failed()
          : '';

  return (
    <section
      ref={section}
      aria-labelledby={`${id}-heading`}
      className="flex min-w-0 flex-col gap-4 text-start wrap-anywhere"
    >
      <h2
        ref={review.heading}
        id={`${id}-heading`}
        tabIndex={-1}
        className="font-semibold focus-visible:outline-2 focus-visible:outline-ring"
      >
        {m.auth_inventory_clients_heading()}
      </h2>
      <p className="text-muted-foreground">{m.auth_owned_description()}</p>
      {options.preflight ? <p>{m.auth_inventory_preflight()}</p> : null}
      <div id={`${id}-status`} role="status" aria-live="polite" aria-atomic="true" className="text-sm">
        {pending ? <p>{m.auth_inventory_loading()}</p> : null}
        {failure ? <p>{failureText}</p> : null}
        {page ? (
          <p>
            {m.auth_owned_page_count({ count: page.rows.length })}{' '}
            {page.next ? m.auth_owned_next_available() : m.auth_owned_no_next()}
          </p>
        ) : null}
        {copyText ? <p>{copyText}</p> : null}
      </div>
      {page ? (
        page.rows.length ? (
          <ItemGroup aria-label={m.auth_inventory_clients_heading()}>
            {page.rows.map((row, index) => {
              const name = row.display_name?.trim() ? row.display_name : m.auth_inventory_unnamed();
              const expanded = review.expanded === row.client_id;
              const detailsId = `${id}-details-${index}`;
              return (
                <Item key={row.client_id} render={<li />} variant="outline" className="min-w-0">
                  <ItemContent className="min-w-0 gap-3">
                    <p className="font-medium wrap-anywhere">{name}</p>
                    <div className="grid min-w-0 gap-1">
                      <span className="text-sm text-muted-foreground">{m.auth_owned_identifier()}</span>
                      <code className="select-text font-mono text-sm wrap-anywhere">{row.client_id}</code>
                    </div>
                    <Badge variant="secondary" className="max-w-full whitespace-normal wrap-anywhere">
                      {row.disabled ? m.auth_owned_disabled() : m.auth_owned_enabled()}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      className="self-start text-start"
                      data-owned-control={index}
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      aria-label={m.auth_owned_details_for({ name, identifier: row.client_id })}
                      onClick={() => (expanded ? close(row.client_id, index) : review.toggle(row.client_id))}
                    >
                      {expanded ? m.auth_owned_close() : m.auth_owned_details()}
                    </Button>
                    {expanded ? (
                      <div
                        id={detailsId}
                        role="region"
                        aria-labelledby={`${detailsId}-heading`}
                        className="grid min-w-0 gap-3 rounded-md border p-4"
                      >
                        <h3
                          ref={detailsHeading}
                          id={`${detailsId}-heading`}
                          tabIndex={-1}
                          className="grid min-w-0 gap-1 font-semibold focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <span>{name}</span>
                          <code className="select-text font-mono text-sm wrap-anywhere">{row.client_id}</code>
                        </h3>
                        <Button
                          type="button"
                          variant="outline"
                          className="justify-self-start"
                          disabled={review.copy === 'pending'}
                          aria-describedby={`${id}-status`}
                          onClick={() => void review.copyNow()}
                        >
                          {m.auth_owned_copy()}
                        </Button>
                        <h4 className="font-medium">{m.auth_owned_scopes()}</h4>
                        <p className="text-sm text-muted-foreground">{m.auth_owned_capabilities()}</p>
                        {row.scopes.length ? (
                          <ul aria-label={m.auth_owned_scopes()} className="grid min-w-0 gap-3">
                            {row.scopes.map((scope) => (
                              <li key={scope} className="grid min-w-0 gap-1 select-text">
                                <Permission scope={scope} />
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>{m.auth_owned_scopes_empty()}</p>
                        )}
                        {row.disabled ? (
                          <p className="text-sm text-muted-foreground">{m.auth_owned_disabled_note()}</p>
                        ) : null}
                        <Button
                          type="button"
                          variant="outline"
                          className="justify-self-start"
                          onClick={() => close(row.client_id, index)}
                        >
                          {m.auth_owned_close()}
                        </Button>
                      </div>
                    ) : null}
                  </ItemContent>
                </Item>
              );
            })}
          </ItemGroup>
        ) : (
          <p>{m.auth_owned_empty()}</p>
        )
      ) : null}
      {!retired ? (
        <nav
          aria-label={m.auth_inventory_clients_heading()}
          className="flex min-w-0 flex-wrap gap-3"
          aria-busy={pending}
        >
          {failure ? (
            <Button type="button" variant="outline" disabled={pending} onClick={review.retry}>
              {m.auth_owned_retry()}
            </Button>
          ) : null}
          {review.previous ? (
            <Button type="button" variant="outline" disabled={pending} onClick={review.previousPage}>
              {m.auth_inventory_previous()}
            </Button>
          ) : null}
          {page?.next ? (
            <Button type="button" variant="outline" disabled={pending} onClick={review.next}>
              {m.auth_inventory_next()}
            </Button>
          ) : null}
          {review.accepted ? (
            <Button type="button" variant="outline" disabled={pending} onClick={review.reload}>
              {m.auth_owned_reload()}
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={pending} onClick={review.restart}>
            {m.auth_owned_restart()}
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
