import { useEffect, useMemo, useSyncExternalStore, type MouseEventHandler, type ReactNode } from 'react';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { ContentItem } from '@rezics/ui/content-item';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import {
  ContentSection,
  ContentSectionBody,
  ContentSectionDescription,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
import { m } from '../paraglide/messages.js';
import type { SettingsContentFailureReader } from './ports/content';
import { useAccounts } from './managed-account-capabilities';
import { useManagedReaderLifetime, useManagedSessionReader } from './managed-session-reader';
import { useSettingsAmbient } from './adapters/ambient-view.tsx';
import { usePreferenceRetry } from './preference-failure-retry';
import { ManagedAccountActions } from './managed-account-actions';
import {
  ManagedAccountReader,
  type DetailFailure,
  type DetailSection,
  type DetailSnapshot,
  type ManagementIdentity,
} from './managed-account-detail-read';

// These controls grow with localized labels instead of clipping at the shared button height.
const recoveryButtonClassName =
  'h-auto max-w-full shrink whitespace-normal wrap-anywhere text-center min-h-7';
const statusCardClassName =
  'min-w-0 max-w-full rounded-lg border bg-muted/20 px-4 py-3 text-sm text-muted-foreground wrap-anywhere';

function identityName(account: ManagementIdentity | null) {
  return account
    ? account.displayName || (account.handle ? `@${account.handle}` : m.managed_unnamed())
    : m.settings_managed_detail_identity_unavailable();
}

function IdentityAvatar({
  account,
  initials,
}: {
  account: ManagementIdentity | null;
  initials: (name: string, fallback?: string) => string;
}) {
  return (
    <Avatar aria-hidden="true">
      <AvatarFallback>{initials(account?.displayName || account?.handle || '')}</AvatarFallback>
    </Avatar>
  );
}

function AccountDetails({ accountId }: { accountId: string }) {
  return (
    <details className="min-w-0 max-w-full">
      <summary className="cursor-pointer py-2 text-sm wrap-anywhere focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
        {m.lifecycle_identity_details()}
      </summary>
      <dl className="min-w-0 space-y-1">
        <dt className="text-sm text-muted-foreground">{m.lifecycle_account_id()}</dt>
        <dd className="select-all break-all font-mono text-sm">{accountId}</dd>
      </dl>
    </details>
  );
}

function Identity({
  account,
  accountId,
  initials,
}: {
  account: ManagementIdentity;
  accountId: string;
  initials: (name: string, fallback?: string) => string;
}) {
  return (
    <div className="flex min-w-0 gap-3">
      <IdentityAvatar account={account} initials={initials} />
      <div className="min-w-0 flex-1 wrap-anywhere">
        <p className="min-w-0 text-lg font-semibold wrap-anywhere">{identityName(account)}</p>
        {account.displayName && account.handle ? (
          <p className="min-w-0 text-sm text-muted-foreground wrap-anywhere">@{account.handle}</p>
        ) : null}
        <AccountDetails accountId={accountId} />
      </div>
    </div>
  );
}

function IdentityRow({
  account,
  accountId,
  state,
  initials,
}: {
  account: ManagementIdentity | null;
  accountId: string;
  state: ReactNode;
  initials: (name: string, fallback?: string) => string;
}) {
  return (
    <ContentItem
      className="min-w-0 max-w-full wrap-anywhere"
      headingLevel={4}
      title={identityName(account)}
      visual={<IdentityAvatar account={account} initials={initials} />}
      metadata={
        account?.displayName && account.handle ? (
          <p className="min-w-0 wrap-anywhere">@{account.handle}</p>
        ) : null
      }
      preview={<AccountDetails accountId={accountId} />}
      state={state}
    />
  );
}

function Failure({
  failure,
  retry,
  restart,
  section,
  pending,
  waiting,
}: {
  failure: DetailFailure;
  retry?: (() => void) | undefined;
  restart?: (() => void) | undefined;
  section?: DetailSection;
  pending: boolean;
  waiting: boolean;
}) {
  const label = section === 'members' ? m.managed_holders_title() : m.managed_operated_title();
  return (
    <Alert
      variant="destructive"
      className="min-w-0 max-w-full wrap-anywhere"
      data-response-status={failure.status ?? ''}
      data-response-code={failure.code ?? ''}
      data-retry-after={failure.retryAfter}
    >
      <AlertTitle className="min-w-0">{m.managed_unavailable_title()}</AlertTitle>
      <AlertDescription className="min-w-0 space-y-3">
        <p>{m.settings_managed_unavailable()}</p>
        <div className="flex min-w-0 max-w-full flex-wrap gap-2">
          {retry ? (
            <Button
              type="button"
              variant="outline"
              className={recoveryButtonClassName}
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
              className={recoveryButtonClassName}
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
    <div className="flex min-w-0 max-w-full flex-wrap gap-2">
      {cursor ? (
        <Button
          type="button"
          variant="outline"
          className={recoveryButtonClassName}
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
          className={recoveryButtonClassName}
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
  onBack,
  initials,
  mediaFailure,
}: {
  reader: ManagedAccountReader | null;
  backHref: string;
  onBack?: MouseEventHandler<HTMLAnchorElement> | undefined;
  initials: (name: string, fallback?: string) => string;
  mediaFailure: SettingsContentFailureReader;
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
  const waiting = usePreferenceRetry(undefined, state.retryAt ?? 0);
  return (
    <ContentSection className="min-w-0 max-w-full wrap-anywhere">
      <ContentSectionHeader className="min-w-0">
        <a
          className="flex w-fit max-w-full items-center py-2 text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          href={backHref}
          onClick={onBack}
        >
          {m.managed_back()}
        </a>
        <ContentSectionTitle className="min-w-0">
          <h2 id="settings-account-heading">{m.managed_detail_title()}</h2>
        </ContentSectionTitle>
        <ContentSectionDescription>{m.settings_managed_read_only()}</ContentSectionDescription>
      </ContentSectionHeader>
      <ContentSectionBody className="min-w-0 space-y-5 sm:space-y-6">
        {waiting ? (
          <p className={statusCardClassName} role="status">
            {m.settings_retry_wait()}
          </p>
        ) : null}
        {state.pending || (reader && !detail && !state.failure) ? (
          <p className={statusCardClassName} role="status">
            {m.settings_managed_detail_loading()}
          </p>
        ) : null}
        {state.failure ? (
          <Failure
            failure={state.failure}
            pending={busy}
            waiting={waiting}
            retry={reader ? () => void reader.load() : () => window.location.reload()}
          />
        ) : null}
        {detail && reader ? (
          <>
            <div className={`grid min-w-0 gap-4 ${detail.operator ? 'md:grid-cols-2' : ''}`}>
              <section
                className="min-w-0 space-y-3 rounded-xl border bg-card p-4 sm:p-5"
                aria-label={m.managed_target_title()}
              >
                <h3 className="text-base font-semibold">{m.managed_target_title()}</h3>
                <Identity account={detail.account} accountId={detail.account.id} initials={initials} />
                <p className="text-sm text-muted-foreground">
                  {detail.account.kind === 'organization'
                    ? m.managed_organization_identity()
                    : detail.self
                      ? m.managed_human_identity()
                      : m.managed_automated_identity()}
                </p>
                {!detail.account.handle ? (
                  <p className="text-sm text-muted-foreground">{m.managed_handleless()}</p>
                ) : null}
                {detail.role ? (
                  <p className="text-sm">
                    {m.managed_your_role()} {detail.role === 'owner' ? m.managed_owner() : m.managed_member()}
                  </p>
                ) : null}
              </section>
              {detail.operator ? (
                <section
                  className="min-w-0 space-y-3 rounded-xl border bg-card p-4 sm:p-5"
                  aria-label={m.managed_operator_title()}
                >
                  <h3 className="text-base font-semibold">{m.managed_operator_title()}</h3>
                  <Identity account={detail.operator} accountId={detail.operator.id} initials={initials} />
                  <p className="text-sm text-muted-foreground">{m.managed_operator_text()}</p>
                </section>
              ) : null}
            </div>
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <section
                className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5"
                aria-label={m.managed_holders_title()}
                aria-busy={members.pending}
              >
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">{m.managed_holders_title()}</h3>
                  <p className="text-sm text-muted-foreground">{m.managed_holders_text()}</p>
                </div>
                {members.pending ? (
                  <p className={statusCardClassName} role="status">
                    {m.settings_managed_detail_loading()}
                  </p>
                ) : null}
                {members.failure ? (
                  <Failure
                    failure={members.failure}
                    pending={state.pending || members.pending}
                    waiting={waiting}
                    section="members"
                    retry={() => void reader.load('members', members.cursor)}
                    restart={members.cursor ? () => void reader.load('members') : undefined}
                  />
                ) : null}
                {members.page?.state === 'denied' ? (
                  <p className={statusCardClassName} role="status">
                    {m.managed_holders_denied()}
                  </p>
                ) : members.page ? (
                  <>
                    {members.page.items.length ? (
                      <ul>
                        {members.page.items.map((item) => (
                          <IdentityRow
                            key={item.accountId}
                            account={item.account}
                            accountId={item.accountId}
                            state={
                              <span className="text-sm">
                                {item.role === 'owner' ? m.managed_owner() : m.managed_member()}
                              </span>
                            }
                            initials={initials}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className={statusCardClassName}>{m.managed_no_holders()}</p>
                    )}
                    {!members.failure ? (
                      <Paging
                        reader={reader}
                        section="members"
                        next={members.page.next}
                        cursor={members.cursor}
                        pending={state.pending || members.pending || waiting}
                      />
                    ) : null}
                  </>
                ) : null}
              </section>
              <section
                className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5"
                aria-label={m.managed_operated_title()}
                aria-busy={responsibilities.pending}
              >
                <div className="space-y-1">
                  <h3 className="text-base font-semibold">{m.managed_operated_title()}</h3>
                  <p className="text-sm text-muted-foreground">{m.managed_responsibility_text()}</p>
                </div>
                {responsibilities.pending ? (
                  <p className={statusCardClassName} role="status">
                    {m.settings_managed_detail_loading()}
                  </p>
                ) : null}
                {responsibilities.failure ? (
                  <Failure
                    failure={responsibilities.failure}
                    pending={state.pending || responsibilities.pending}
                    waiting={waiting}
                    section="responsibilities"
                    retry={() => void reader.load('responsibilities', responsibilities.cursor)}
                    restart={responsibilities.cursor ? () => void reader.load('responsibilities') : undefined}
                  />
                ) : null}
                {responsibilities.page === null ? (
                  <p className={statusCardClassName} role="status">
                    {m.settings_managed_responsibilities_unavailable()}
                  </p>
                ) : responsibilities.page ? (
                  <>
                    {responsibilities.page.items.length ? (
                      <ul>
                        {responsibilities.page.items.map((item) => (
                          <IdentityRow
                            key={item.reservationId}
                            account={item.account}
                            accountId={item.accountId}
                            state={
                              <p className="text-sm">
                                {item.state === 'current' ? m.managed_current() : m.managed_reconciling()}
                              </p>
                            }
                            initials={initials}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className={statusCardClassName}>{m.managed_no_responsibilities()}</p>
                    )}
                    {!responsibilities.failure ? (
                      <Paging
                        reader={reader}
                        section="responsibilities"
                        next={responsibilities.page.next}
                        cursor={responsibilities.cursor}
                        pending={state.pending || responsibilities.pending || waiting}
                      />
                    ) : null}
                  </>
                ) : null}
                <p className="border-t pt-3 text-sm text-muted-foreground">{m.settings_managed_observation()}</p>
              </section>
            </div>
            <div className="min-w-0 space-y-4 rounded-xl border bg-muted/20 p-4 sm:p-5">
              <ManagedAccountActions
                accountId={detail.account.id}
                nativeAccountKind={detail.account.kind}
                operated={detail.operated}
                self={detail.self}
                authNavigation={state.authNavigation}
                authCsrfToken={reader.csrfToken}
                mediaFailure={mediaFailure}
              />
              {!state.failure ? (
                <div className="flex min-w-0 justify-end border-t pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className={recoveryButtonClassName}
                    disabled={busy || waiting}
                    onClick={() => void reader.load()}
                  >
                    {m.managed_refresh()}
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </ContentSectionBody>
    </ContentSection>
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

export function ManagedAccountDetail({
  accountId,
  backHref,
  onBack,
  initials,
  mediaFailure,
}: {
  accountId: string | null;
  backHref: string;
  onBack?: MouseEventHandler<HTMLAnchorElement> | undefined;
  initials: (name: string, fallback?: string) => string;
  mediaFailure: SettingsContentFailureReader;
}) {
  const ambient = useSettingsAmbient();
  const { session, readDetail } = useAccounts();
  const viewerId = session.state === 'signed-in' ? session.subject : null;
  const owner = useManagedSessionReader(viewerId, accountId, session.csrfToken);
  const reader = useMemo(
    () =>
      viewerId && accountId
        ? new ManagedAccountReader(viewerId, accountId, readDetail, ambient, session.csrfToken, owner.isCurrent)
        : null,
    [ambient, viewerId, accountId, session.csrfToken, owner, readDetail],
  );
  useManagedReaderLifetime(reader?.clear ?? noDispose, owner);
  useEffect(() => {
    if (reader) void reader.load();
  }, [reader]);
  return (
    <ManagedAccountDetailCard
      reader={owner.isCurrent() ? reader : null}
      backHref={backHref}
      onBack={onBack}
      initials={initials}
      mediaFailure={mediaFailure}
    />
  );
}

const noDispose = () => {};
