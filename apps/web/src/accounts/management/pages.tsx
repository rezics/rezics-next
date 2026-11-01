import type { ReactNode } from 'react';
import { ContentItem } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Tombstone } from '@rezics/ui/tombstone';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { managedAccountHref } from '../../settings/managed-accounts-read';
import { issuerPage, type Cursors, type Detail, type Identity, type Inventory, type Page } from './data';

const linkClass =
  'inline-flex min-h-11 max-w-full items-center wrap-anywhere text-primary underline underline-offset-4';
export function managementHref(account: Identity) {
  return `/${getLocale()}/${account.kind === 'organization' ? 'organizations' : 'accounts'}/${encodeURIComponent(account.id)}`;
}
function name(account: Identity) {
  return account.displayName || (account.handle ? `@${account.handle}` : m.managed_unnamed());
}
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-4xl space-y-8 pb-8">
      <header className="space-y-3">
        <PageHeading>{title}</PageHeading>
        <p className="max-w-prose text-muted-foreground">{m.managed_intro()}</p>
      </header>
      {children}
    </article>
  );
}
function Failure({ page, retry }: { page: Exclude<Page<unknown>, { state: 'ready' }>; retry: () => void }) {
  const title =
    page.state === 'denied'
      ? m.managed_denied_title()
      : page.state === 'preparing'
        ? m.managed_preparing_title()
        : page.state === 'missing'
          ? m.managed_missing_title()
          : page.state === 'signed-out'
            ? m.managed_sign_in_title()
            : m.managed_unavailable_title();
  const text =
    page.state === 'denied'
      ? m.managed_denied_text()
      : page.state === 'preparing'
        ? m.managed_preparing_text()
        : page.state === 'missing'
          ? m.managed_missing_text()
          : page.state === 'signed-out'
            ? m.managed_sign_in_text()
            : m.managed_unavailable_text();
  return (
    <Alert>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{text}</p>
        {page.state === 'signed-out' ? (
          <a className={linkClass} href={`/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/accounts`)}`}>
            {m.managed_sign_in_title()}
          </a>
        ) : (
          <Button variant="outline" onClick={retry}>
            {m.managed_refresh()}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
function IdentityLink({ account, management = true }: { account: Identity | null; management?: boolean }) {
  return account ? (
    <div className="min-w-0">
      {management || account.handle ? (
        <a
          className={`${linkClass} break-words font-medium`}
          href={management ? managementHref(account) : `/${getLocale()}/@${encodeURIComponent(account.handle!)}`}
        >
          {name(account)}
        </a>
      ) : (
        <p className="break-words font-medium">{name(account)}</p>
      )}
      {account.handle && account.displayName ? (
        <p className="break-words text-sm text-muted-foreground">@{account.handle}</p>
      ) : null}
    </div>
  ) : (
    <Tombstone shape="row" labels={{ unavailable: m.managed_missing_title() }} />
  );
}
function Next({ cursor, field, cursors }: { cursor: string | null; field: keyof Cursors; cursors: Cursors }) {
  const query = new URLSearchParams({ ...cursors, ...(cursor ? { [field]: cursor } : {}) });
  return cursor ? (
    <a className={linkClass} rel="next" href={`?${query}`}>
      {m.managed_next()}
    </a>
  ) : null;
}
function Responsibilities({ page, cursors }: { page: Inventory['responsibilities']; cursors: Cursors }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.managed_operated_title()}</h2>
        </CardTitle>
        <CardDescription>{m.managed_responsibility_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {page.items.length ? (
          <ul>
            {page.items.map((item) => (
              <ContentItem
                key={item.reservationId}
                headingLevel={3}
                title={item.account ? name(item.account) : m.managed_missing_title()}
                {...(item.account && (item.state === 'current' || item.account.handle)
                  ? {
                      href:
                        item.state === 'current'
                          ? managementHref(item.account)
                          : `/${getLocale()}/@${encodeURIComponent(item.account.handle!)}`,
                    }
                  : {})}
                metadata={item.account?.handle && item.account.displayName ? <p>@{item.account.handle}</p> : null}
                state={
                  <Badge variant="secondary">
                    {item.state === 'current' ? m.managed_current() : m.managed_reconciling()}
                  </Badge>
                }
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{m.managed_no_responsibilities()}</p>
        )}
        <Next cursor={page.next} field="operatorsCursor" cursors={cursors} />
      </CardContent>
    </Card>
  );
}
export function ManagedAccountsPage({
  page,
  cursors = {},
  retry,
}: {
  page: Page<Inventory>;
  cursors?: Cursors;
  retry: () => void;
}) {
  if (page.state !== 'ready')
    return (
      <Frame title={m.managed_title()}>
        <Failure page={page} retry={retry} />
      </Frame>
    );
  const create = page.organizationsAvailable === true ? issuerPage(page.issuer, '/organizations/new') : null;
  return (
    <Frame title={m.managed_title()}>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{m.managed_your_account()}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <IdentityLink account={page.value.account} />
          <nav aria-label={m.av_accounts()} className="flex flex-wrap gap-x-6 gap-y-2">
            <a
              className={linkClass}
              href={`/${getLocale()}/accounts/${encodeURIComponent(page.value.account.id)}/verification`}
            >
              {m.av_my_verification()}
            </a>
            <a className={linkClass} href={`/${getLocale()}/review/account-verifications`}>
              {m.av_review_title()}
            </a>
            <a className={linkClass} href={`/${getLocale()}/settings`}>
              {m.av_applicant_settings()}
            </a>
          </nav>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{m.managed_organizations_title()}</h2>
          </CardTitle>
          <CardDescription>{m.managed_membership_text()}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {page.value.organizations.state === 'preparing' ? (
            <p role="status">{m.managed_preparing_text()}</p>
          ) : page.value.organizations.items.length ? (
            <ul>
              {page.value.organizations.items.map(({ account, role }) => (
                <ContentItem
                  key={account.id}
                  headingLevel={3}
                  title={name(account)}
                  href={managementHref(account)}
                  metadata={account.handle && account.displayName ? <p>@{account.handle}</p> : null}
                  state={<Badge variant="secondary">{role === 'owner' ? m.managed_owner() : m.managed_member()}</Badge>}
                />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              {page.value.organizations.next ? m.managed_no_current_page() : m.managed_no_organizations()}
            </p>
          )}
          <Next cursor={page.value.organizations.next} field="organizationsCursor" cursors={cursors} />
          {create ? (
            <a className={linkClass} href={create}>
              {m.managed_create_organization()}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">
              {page.organizationsAvailable === false ? m.managed_creation_closed() : m.managed_creation_unavailable()}
            </p>
          )}
        </CardContent>
      </Card>
      <Responsibilities page={page.value.responsibilities} cursors={cursors} />
      <Alert>
        <AlertTitle>{m.managed_automation_title()}</AlertTitle>
        <AlertDescription>{m.managed_automation_unavailable()}</AlertDescription>
      </Alert>
      <Button variant="outline" onClick={retry}>
        {m.managed_refresh()}
      </Button>
    </Frame>
  );
}
export function AccountManagementPage({
  page,
  cursors = {},
  retry,
}: {
  page: Page<Detail>;
  cursors?: Cursors;
  retry: () => void;
}) {
  if (page.state !== 'ready')
    return (
      <Frame title={m.managed_detail_title()}>
        <Failure page={page} retry={retry} />
      </Frame>
    );
  const value = page.value;
  const deletion = value.self ? issuerPage(page.issuer, '/account/delete') : null;
  return (
    <Frame title={name(value.account)}>
      <nav aria-label={m.managed_title()}>
        <a href={`/${getLocale()}/accounts`} className={linkClass}>
          {m.managed_back()}
        </a>
      </nav>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{m.managed_target_title()}</h2>
          </CardTitle>
          <CardDescription>
            {value.account.kind === 'organization'
              ? m.managed_organization_identity()
              : value.relation
                ? m.managed_automated_identity()
                : m.managed_human_identity()}
          </CardDescription>
        </CardHeader>
        <CardContent data-slot="account-management-identity" className="grid min-w-0 gap-3">
          {value.account.handle ? (
            <a className={linkClass} href={`/${getLocale()}/@${encodeURIComponent(value.account.handle)}`}>
              @{value.account.handle}
            </a>
          ) : (
            <p>{m.managed_handleless()}</p>
          )}
          {value.role ? (
            <p>
              {m.managed_your_role()}{' '}
              <Badge variant="secondary">{value.role === 'owner' ? m.managed_owner() : m.managed_member()}</Badge>
            </p>
          ) : null}
          {value.relation ? (
            <div>
              <h3 className="font-medium">{m.managed_operator_title()}</h3>
              <IdentityLink account={value.operator} management={false} />
              <p className="text-sm text-muted-foreground">{m.managed_operator_text()}</p>
            </div>
          ) : null}
          {value.self ? (
            <a href={`/${getLocale()}/settings`} className={linkClass}>
              {m.managed_edit_profile()}
            </a>
          ) : null}
        </CardContent>
      </Card>
      {value.account.kind === 'organization' ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{m.managed_holders_title()}</h2>
            </CardTitle>
            <CardDescription>{m.managed_holders_text()}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {value.members.state === 'denied' ? (
              <p>{m.managed_holders_denied()}</p>
            ) : value.members.items.length ? (
              <ul>
                {value.members.items.map((item) => (
                  <ContentItem
                    key={item.accountId}
                    headingLevel={3}
                    title={item.account ? name(item.account) : m.managed_missing_title()}
                    {...(item.account?.handle
                      ? { href: `/${getLocale()}/@${encodeURIComponent(item.account.handle)}` }
                      : {})}
                    metadata={item.account?.handle && item.account.displayName ? <p>@{item.account.handle}</p> : null}
                    state={
                      <Badge variant="secondary">
                        {item.role === 'owner' ? m.managed_owner() : m.managed_member()}
                      </Badge>
                    }
                  />
                ))}
              </ul>
            ) : (
              <p>{m.managed_no_holders()}</p>
            )}
            <Next cursor={value.members.next} field="membersCursor" cursors={cursors} />
          </CardContent>
        </Card>
      ) : null}
      {value.responsibilities ? <Responsibilities page={value.responsibilities} cursors={cursors} /> : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{m.managed_changes_title()}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <a className={linkClass} href={managedAccountHref(`/${getLocale()}/settings`, value.account.id)}>
            {m.managed_options()}
          </a>
          <p>{m.managed_options_guidance()}</p>
          {value.relation ? <p>{m.managed_transfer_unavailable()}</p> : null}
          <p>{m.managed_operation_status()}</p>
          {deletion ? (
            <a className={linkClass} href={deletion}>
              {m.managed_delete_self()}
            </a>
          ) : null}
        </CardContent>
      </Card>
      <Button variant="outline" onClick={retry}>
        {m.managed_refresh()}
      </Button>
    </Frame>
  );
}
