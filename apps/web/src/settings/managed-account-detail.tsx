import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { usePreferenceRetry } from './preference-failure-retry';
import { ManagedAccountActions } from './managed-account-actions';
import {
  ManagedAccountReader,
  readManagedAccountDetail,
  type DetailFailure,
  type DetailSection,
  type DetailSnapshot,
  type ManagementIdentity,
} from './managed-account-detail-read';

function Identity({ account, accountId }: { account: ManagementIdentity | null; accountId: string }) {
  return (
    <div className="min-w-0 break-words">
      <p className="font-medium">{account?.displayName || (account?.handle ? `@${account.handle}` : accountId)}</p>
      {account?.displayName && account.handle ? (
        <p className="text-sm text-muted-foreground">@{account.handle}</p>
      ) : null}
      {!account ? (
        <p className="text-sm text-muted-foreground">{m.settings_managed_detail_identity_unavailable()}</p>
      ) : null}
    </div>
  );
}

function Failure({
  failure,
  retry,
  restart,
  section,
  pending,
}: {
  failure: DetailFailure;
  retry?: (() => void) | undefined;
  restart?: (() => void) | undefined;
  section?: DetailSection;
  pending: boolean;
}) {
  const waiting = usePreferenceRetry(failure);
  const label = section === 'members' ? m.managed_holders_title() : m.managed_operated_title();
  return (
    <Alert
      variant="destructive"
      data-response-status={failure.status ?? ''}
      data-response-code={failure.code ?? ''}
      data-retry-after={failure.retryAfter}
    >
      <AlertTitle>{m.managed_unavailable_title()}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{m.settings_managed_unavailable()}</p>
        {waiting ? <p>{m.settings_retry_wait()}</p> : null}
        <div className="flex flex-wrap gap-2">
          {retry ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 min-w-11 whitespace-normal"
              disabled={pending || waiting}
              aria-label={section ? `${m.settings_retry()} · ${label}` : undefined}
              onClick={retry}
            >
              {m.settings_retry()}
            </Button>
          ) : null}
          {restart ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 min-w-11 whitespace-normal"
              disabled={pending || waiting}
              aria-label={`${m.settings_managed_start_first_page()} · ${label}`}
              onClick={restart}
            >
              {m.settings_managed_start_first_page()}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

function Paging({
  reader,
  section,
  next,
  cursor,
  pending,
}: {
  reader: ManagedAccountReader;
  section: DetailSection;
  next: string | null;
  cursor?: string | undefined;
  pending: boolean;
}) {
  const label = section === 'members' ? m.managed_holders_title() : m.managed_operated_title();
  return (
    <div className="flex flex-wrap gap-2">
      {cursor ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 min-w-11 whitespace-normal"
          disabled={pending}
          aria-label={`${m.settings_managed_first_page()} · ${label}`}
          onClick={() => void reader.load(section)}
        >
          {m.settings_managed_first_page()}
        </Button>
      ) : null}
      {next ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 min-w-11 whitespace-normal"
          disabled={pending}
          aria-label={`${m.managed_next()} · ${label}`}
          onClick={() => void reader.load(section, next)}
        >
          {m.managed_next()}
        </Button>
      ) : null}
    </div>
  );
}

/** Read-only presentation shared by the connected settings region and focused component stories. */
export function ManagedAccountDetailCard({
  reader,
  backHref,
}: {
  reader: ManagedAccountReader | null;
  backHref: string;
}) {
  const state = useSyncExternalStore(
    reader?.subscribe ?? noSubscribe,
    reader?.snapshot ?? unavailable,
    reader?.snapshot ?? unavailable,
  );
  const detail = state.detail;
  const members = state.members;
  const responsibilities = state.responsibilities;
  const busy = state.pending || members.pending || responsibilities.pending;
  return (
    <Card>
      <CardHeader>
        <a className="w-fit text-sm text-primary underline underline-offset-4" href={backHref}>
          {m.managed_back()}
        </a>
        <CardTitle>
          <h2 id="settings-account-heading">{m.managed_detail_title()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_managed_read_only()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {state.pending || (reader && !detail && !state.failure) ? (
          <p role="status">{m.settings_managed_detail_loading()}</p>
        ) : null}
        {state.failure ? (
          <Failure
            failure={state.failure}
            pending={busy}
            retry={reader ? () => void reader.load() : () => window.location.reload()}
          />
        ) : null}
        {detail && reader ? (
          <>
            <section className="space-y-3" aria-label={m.managed_target_title()}>
              <Identity account={detail.account} accountId={detail.account.id} />
              <p className="text-sm text-muted-foreground">
                {detail.account.kind === 'organization'
                  ? m.managed_organization_identity()
                  : detail.self
                    ? m.managed_human_identity()
                    : m.managed_automated_identity()}
              </p>
              {!detail.account.handle ? <p className="text-sm">{m.managed_handleless()}</p> : null}
              {detail.role ? (
                <p>
                  {m.managed_your_role()} {detail.role === 'owner' ? m.managed_owner() : m.managed_member()}
                </p>
              ) : null}
              {detail.operator ? (
                <div className="space-y-2">
                  <h3 className="font-medium">{m.managed_operator_title()}</h3>
                  <Identity account={detail.operator} accountId={detail.operator.id} />
                  <p className="text-sm text-muted-foreground">{m.managed_operator_text()}</p>
                </div>
              ) : null}
            </section>
            <section className="space-y-3" aria-label={m.managed_holders_title()} aria-busy={members.pending}>
              <h3 className="font-medium">{m.managed_holders_title()}</h3>
              <p className="text-sm text-muted-foreground">{m.managed_holders_text()}</p>
              {members.failure ? (
                <Failure
                  failure={members.failure}
                  pending={state.pending || members.pending}
                  section="members"
                  retry={() => void reader.load('members', members.cursor)}
                  restart={members.cursor ? () => void reader.load('members') : undefined}
                />
              ) : null}
              {members.page?.state === 'denied' ? (
                <p role="status">{m.managed_holders_denied()}</p>
              ) : members.page ? (
                <>
                  {members.page.items.length ? (
                    <ul className="divide-y rounded-lg border px-4">
                      {members.page.items.map((item) => (
                        <li className="flex flex-wrap items-start justify-between gap-3 py-3" key={item.accountId}>
                          <Identity account={item.account} accountId={item.accountId} />
                          <span className="text-sm">
                            {item.role === 'owner' ? m.managed_owner() : m.managed_member()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{m.managed_no_holders()}</p>
                  )}
                  {!members.failure ? (
                    <Paging
                      reader={reader}
                      section="members"
                      next={members.page.next}
                      cursor={members.cursor}
                      pending={state.pending || members.pending}
                    />
                  ) : null}
                </>
              ) : null}
            </section>
            <section className="space-y-3" aria-label={m.managed_operated_title()} aria-busy={responsibilities.pending}>
              <h3 className="font-medium">{m.managed_operated_title()}</h3>
              <p className="text-sm text-muted-foreground">{m.managed_responsibility_text()}</p>
              {responsibilities.failure ? (
                <Failure
                  failure={responsibilities.failure}
                  pending={state.pending || responsibilities.pending}
                  section="responsibilities"
                  retry={() => void reader.load('responsibilities', responsibilities.cursor)}
                  restart={responsibilities.cursor ? () => void reader.load('responsibilities') : undefined}
                />
              ) : null}
              {responsibilities.page === null ? (
                <p role="status">{m.settings_managed_responsibilities_unavailable()}</p>
              ) : responsibilities.page ? (
                <>
                  {responsibilities.page.items.length ? (
                    <ul className="divide-y rounded-lg border px-4">
                      {responsibilities.page.items.map((item) => (
                        <li className="space-y-2 py-3" key={item.reservationId}>
                          <Identity account={item.account} accountId={item.accountId} />
                          <p className="text-sm">
                            {item.state === 'current' ? m.managed_current() : m.managed_reconciling()}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{m.managed_no_responsibilities()}</p>
                  )}
                  {!responsibilities.failure ? (
                    <Paging
                      reader={reader}
                      section="responsibilities"
                      next={responsibilities.page.next}
                      cursor={responsibilities.cursor}
                      pending={state.pending || responsibilities.pending}
                    />
                  ) : null}
                </>
              ) : null}
              <p className="text-sm text-muted-foreground">{m.settings_managed_observation()}</p>
            </section>
            <ManagedAccountActions
              accountId={detail.account.id}
              nativeAccountKind={detail.account.kind}
              operated={detail.operated}
              self={detail.self}
              authNavigation={state.authNavigation}
              authCsrfToken={reader.csrfToken}
            />
            <Button type="button" variant="outline" disabled={busy} onClick={() => void reader.load()}>
              {m.managed_refresh()}
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

const noSubscribe = () => () => {};
const invalidState: DetailSnapshot = {
  pending: false,
  failure: { status: null, transient: false },
  members: { page: undefined, pending: false },
  responsibilities: { page: undefined, pending: false },
};
const unavailable = () => invalidState;

export function ManagedAccountDetail({ accountId, backHref }: { accountId: string | null; backHref: string }) {
  const session = useSession();
  // A new/unknown identity never renders a previous reader, even before effect cleanup runs.
  const viewerId = session.state === 'signed-in' ? session.subject : null;
  const reader = useMemo(
    () =>
      viewerId && accountId
        ? new ManagedAccountReader(viewerId, accountId, (data) => readManagedAccountDetail({ data }), session.csrfToken)
        : null,
    [viewerId, accountId, session.csrfToken],
  );
  useEffect(() => {
    if (reader) void reader.load();
    return () => reader?.clear();
  }, [reader]);
  return <ManagedAccountDetailCard reader={reader} backHref={backHref} />;
}
