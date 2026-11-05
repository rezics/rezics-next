import type { ReactNode } from 'react';
import { ContentItem, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Tombstone } from '@rezics/ui/tombstone';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { managedAccountHref } from '../../settings/managed-accounts-read';
import type { WindowNavigation } from './window-route';
import { issuerPage, type Cursors, type Detail, type Identity, type Inventory, type Page } from './data';

const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center whitespace-normal wrap-anywhere rounded-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const retryClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-3 text-start';
export function managementHref(account: Identity) {
  return `/${getLocale()}/${account.kind === 'organization' ? 'organizations' : 'accounts'}/${encodeURIComponent(account.id)}`;
}
function name(account: Identity) {
  return account.displayName || (account.handle ? `@${account.handle}` : m.managed_unnamed());
}
function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-4xl min-w-0 space-y-8 pb-8 wrap-anywhere">
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
          <Button className={retryClass} variant="outline" onClick={retry}>
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
function WindowControls({
  cursor,
  field,
  cursors,
  navigation,
}: {
  cursor: string | null;
  field: keyof Cursors;
  cursors: Cursors;
  navigation?: WindowNavigation;
}) {
  const previous = navigation?.previous(field);
  const control = (target: string | undefined, movement: 'next' | 'previous' | 'first', label: string) => {
    const search = { ...cursors };
    if (target === undefined) delete search[field];
    else search[field] = target;
    return (
      <a
        className={linkClass}
        rel={movement === 'next' ? 'next' : movement === 'previous' ? 'prev' : undefined}
        href={`?${new URLSearchParams(search)}`}
        onClick={(event) => navigation?.move(event, field, target, movement)}
      >
        {label}
      </a>
    );
  };
  return (
    <nav
      className="flex flex-wrap gap-x-6 gap-y-2"
      aria-label={
        field === 'organizationsCursor'
          ? m.managed_organizations_title()
          : field === 'membersCursor'
            ? m.managed_holders_title()
            : m.managed_operated_title()
      }
    >
      {previous ? control(previous.cursor, 'previous', m.prq_previous()) : null}
      {cursors[field] ? control(undefined, 'first', m.settings_managed_start_first_page()) : null}
      {cursor ? control(cursor, 'next', m.managed_next()) : null}
    </nav>
  );
}
const regionClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
function Responsibilities({
  page,
  cursors,
  navigation,
}: {
  page: Inventory['responsibilities'];
  cursors: Cursors;
  navigation?: WindowNavigation;
}) {
  return (
    <Card
      role="region"
      aria-label={m.managed_operated_title()}
      tabIndex={-1}
      data-management-feed="operatorsCursor"
      className={regionClass}
    >
      <CardHeader>
        <CardTitle>
          <ContentItemHeading level={2}>{m.managed_operated_title()}</ContentItemHeading>
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
                  <Badge
                    variant="secondary"
                    className="h-auto min-h-5 max-w-full whitespace-normal wrap-anywhere text-start"
                  >
                    {item.state === 'current' ? m.managed_current() : m.managed_reconciling()}
                  </Badge>
                }
              />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{m.managed_no_responsibilities()}</p>
        )}
        <WindowControls navigation={navigation} cursor={page.next} field="operatorsCursor" cursors={cursors} />
      </CardContent>
    </Card>
  );
}
export function ManagedAccountsPage({
  page,
  cursors = {},
  retry,
  navigation,
}: {
  page: Page<Inventory>;
  cursors?: Cursors;
  retry: () => void;
  navigation?: WindowNavigation;
}) {
  if (page.state !== 'ready')
    return (
      <Frame title={m.managed_title()}>
        <Failure page={page} retry={retry} />
        {page.state !== 'signed-out' &&
          (['organizationsCursor', 'operatorsCursor', 'membersCursor'] as const)
            .filter((field) => cursors[field])
            .map((field) => (
              <WindowControls key={field} cursor={null} field={field} cursors={cursors} navigation={navigation} />
            ))}
      </Frame>
    );
  const create = page.organizationsAvailable === true ? issuerPage(page.issuer, '/organizations/new') : null;
  return (
    <Frame title={m.managed_title()}>
      <Card>
        <CardHeader>
          <CardTitle>
            <ContentItemHeading level={2}>{m.managed_your_account()}</ContentItemHeading>
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
      <Card
        role="region"
        aria-label={m.managed_organizations_title()}
        tabIndex={-1}
        data-management-feed="organizationsCursor"
        className={regionClass}
      >
        <CardHeader>
          <CardTitle>
            <ContentItemHeading level={2}>{m.managed_organizations_title()}</ContentItemHeading>
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
                  state={
                    <Badge
                      variant="secondary"
                      className="h-auto min-h-5 max-w-full whitespace-normal wrap-anywhere text-start"
                    >
                      {role === 'owner' ? m.managed_owner() : m.managed_member()}
                    </Badge>
                  }
                />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              {page.value.organizations.next ? m.managed_no_current_page() : m.managed_no_organizations()}
            </p>
          )}
          <WindowControls
            navigation={navigation}
            cursor={page.value.organizations.next}
            field="organizationsCursor"
            cursors={cursors}
          />
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
      <Responsibilities page={page.value.responsibilities} cursors={cursors} navigation={navigation} />
      <Alert>
        <AlertTitle>{m.managed_automation_title()}</AlertTitle>
        <AlertDescription>{m.managed_automation_unavailable()}</AlertDescription>
      </Alert>
      <Button className={retryClass} variant="outline" onClick={retry}>
        {m.managed_refresh()}
      </Button>
    </Frame>
  );
}
export function AccountManagementPage({
  page,
  cursors = {},
  retry,
  navigation,
}: {
  page: Page<Detail>;
  cursors?: Cursors;
  retry: () => void;
  navigation?: WindowNavigation;
}) {
  if (page.state !== 'ready')
    return (
      <Frame title={m.managed_detail_title()}>
        <Failure page={page} retry={retry} />
        {page.state !== 'signed-out' &&
          (['organizationsCursor', 'operatorsCursor', 'membersCursor'] as const)
            .filter((field) => cursors[field])
            .map((field) => (
              <WindowControls key={field} cursor={null} field={field} cursors={cursors} navigation={navigation} />
            ))}
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
            <ContentItemHeading level={2}>{m.managed_target_title()}</ContentItemHeading>
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
              <Badge
                variant="secondary"
                className="h-auto min-h-5 max-w-full whitespace-normal wrap-anywhere text-start"
              >
                {value.role === 'owner' ? m.managed_owner() : m.managed_member()}
              </Badge>
            </p>
          ) : null}
          {value.relation ? (
            <div>
              <ContentItemHeading level={3} className="font-medium">
                {m.managed_operator_title()}
              </ContentItemHeading>
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
        <Card
          role="region"
          aria-label={m.managed_holders_title()}
          tabIndex={-1}
          data-management-feed="membersCursor"
          className={regionClass}
        >
          <CardHeader>
            <CardTitle>
              <ContentItemHeading level={2}>{m.managed_holders_title()}</ContentItemHeading>
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
                      <Badge
                        variant="secondary"
                        className="h-auto min-h-5 max-w-full whitespace-normal wrap-anywhere text-start"
                      >
                        {item.role === 'owner' ? m.managed_owner() : m.managed_member()}
                      </Badge>
                    }
                  />
                ))}
              </ul>
            ) : (
              <p>{m.managed_no_holders()}</p>
            )}
            <WindowControls
              navigation={navigation}
              cursor={value.members.next}
              field="membersCursor"
              cursors={cursors}
            />
          </CardContent>
        </Card>
      ) : null}
      {value.responsibilities ? (
        <Responsibilities page={value.responsibilities} cursors={cursors} navigation={navigation} />
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <ContentItemHeading level={2}>{m.managed_changes_title()}</ContentItemHeading>
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
      <Button className={retryClass} variant="outline" onClick={retry}>
        {m.managed_refresh()}
      </Button>
    </Frame>
  );
}
