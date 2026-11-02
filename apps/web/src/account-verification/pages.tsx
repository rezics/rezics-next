import type { ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Tombstone } from '@rezics/ui/tombstone';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import type { AccountPage, AgentVerificationRequest, Identity, Operation, ReadState, ReviewPage } from './transport';
import {
  actionLabel,
  OperationFeedback,
  OperationForm,
  useOperationAttempt,
  type SubmitOperation,
  VerificationDeparture,
  VerificationDecisions,
  VerificationLink,
  useVerificationNavigation,
} from './operation';

const linkClass = 'font-medium text-primary underline underline-offset-4 break-words';
export const verificationHref = (id: string) => `/${getLocale()}/accounts/${encodeURIComponent(id)}/verification`;
export const reviewHref = () => `/${getLocale()}/review/account-verifications`;

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
      <VerificationLink className={linkClass} href={`/${getLocale()}/accounts`}>
        {m.av_accounts()}
      </VerificationLink>
      <h1 className="text-3xl font-semibold tracking-tight text-balance">{title}</h1>
      {children}
    </section>
  );
}

export function PageState({
  state,
  retry,
}: {
  state: 'loading' | 'denied' | 'preparing' | 'unavailable' | 'invalid';
  retry?: () => void;
}) {
  const message = {
    loading: m.av_loading,
    denied: m.av_denied,
    preparing: m.av_preparing,
    unavailable: m.av_unavailable,
    invalid: m.av_invalid,
  }[state]();
  return (
    <div className="space-y-3 rounded-xl border border-border p-5" aria-busy={state === 'loading'}>
      <p role={state === 'unavailable' || state === 'invalid' ? 'alert' : 'status'}>{message}</p>
      {retry && state !== 'loading' && (
        <Button type="button" variant="outline" onClick={retry}>
          {m.av_refresh()}
        </Button>
      )}
    </div>
  );
}

function AccountReference({ account }: { account: Identity | null }) {
  return account ? (
    account.handle ? (
      <VerificationLink className={linkClass} href={`/${getLocale()}/@${encodeURIComponent(account.handle)}`}>
        {account.name}
      </VerificationLink>
    ) : (
      <span className="break-words">{account.name}</span>
    )
  ) : (
    <Tombstone shape="row" labels={{ unavailable: m.av_profile_unavailable() }} />
  );
}
function safeProof(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
function requestState(request: AgentVerificationRequest) {
  return {
    pending: m.av_pending,
    approving: m.av_approving,
    approved: m.av_approved,
    rejected: m.av_rejected,
    withdrawn: m.av_withdrawn,
    failed: m.av_failed,
  }[request.state]();
}

function Evidence({ request }: { request: AgentVerificationRequest }) {
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{requestState(request)}</p>
      <p className="max-w-prose leading-7 whitespace-pre-wrap break-words">{request.statement}</p>
      {request.links.length ? (
        <ul className="list-disc space-y-2 pl-5" aria-label={m.av_proof_links()}>
          {request.links.map((link, index) => (
            <li key={`${index}-${link.url}`}>
              {safeProof(link.url) ? (
                <a href={link.url} className={linkClass} target="_blank" rel="noopener noreferrer nofollow ugc">
                  {link.label}
                </a>
              ) : (
                <span>{link.label}</span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{m.av_no_links()}</p>
      )}
      {request.reason && (
        <p className="whitespace-pre-wrap break-words">
          {m.av_reason()}: {request.reason}
        </p>
      )}
      {request.problem && (
        <p role="alert" className="break-words">
          {request.problem.detail}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {m.av_updated()}{' '}
        <time dateTime={request.updatedAt}>
          {new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(
            new Date(request.updatedAt),
          )}{' '}
          UTC
        </time>
      </p>
    </div>
  );
}

function ReviewContent({
  children,
}: {
  children: (navigate: ReturnType<typeof useVerificationNavigation>) => ReactNode;
}) {
  return children(useVerificationNavigation());
}

export function ReviewPageView(props: Parameters<typeof ReviewPageViewContent>[0]) {
  return (
    <VerificationDeparture>
      <ReviewPageViewContent key={props.viewerId} {...props} />
    </VerificationDeparture>
  );
}

function ReviewPageViewContent({
  page,
  operations,
  viewerId,
  submit,
  refresh,
  next,
  first,
  canWrite = true,
}: {
  page: ReadState<ReviewPage> | { state: 'loading' };
  operations: string[];
  viewerId: string | null;
  submit: SubmitOperation;
  refresh: () => void;
  next: (cursor: string) => void;
  first: () => void;
  canWrite?: boolean;
}) {
  const actions: Operation['action'][] = [];
  if (operations.includes('verification_request.approve')) actions.push('approve');
  if (operations.includes('verification_request.reject')) actions.push('reject');
  const authorized = !!viewerId && page.state !== 'denied' && page.state !== 'preparing' && actions.length > 0;
  const operation = useOperationAttempt(
    viewerId ? `verification:${viewerId}:review` : null,
    submit,
    refresh,
    canWrite,
    `${authorized}:${actions.join(',')}`,
  );
  const disabled = !viewerId || !canWrite || operation.busy || !!operation.attempt;
  const command = operation.command;
  return (
    <VerificationDecisions operation={operation} authorized={authorized}>
      <ReviewContent>
        {(navigate) => (
          <Frame title={m.av_review_title()}>
            <p className="max-w-prose text-muted-foreground">{m.av_review_help()}</p>
            {viewerId &&
              page.state !== 'denied' &&
              page.state !== 'preparing' &&
              (operation.result || operation.attempt) && (
                <div className="space-y-3">
                  {command && (
                    <div className="space-y-2 break-words">
                      <p>
                        {m.av_application()}: {command.targetId}
                      </p>
                      <p>
                        {m.av_decision()}: {actionLabel(command.action)}
                      </p>
                      <p className="whitespace-pre-wrap">
                        {m.av_reason()}: {command.reason}
                      </p>
                    </div>
                  )}
                  <OperationFeedback
                    operation={operation}
                    disabled={!canWrite || page.state !== 'ready' || !command || !actions.includes(command.action)}
                  />
                </div>
              )}
            {page.state !== 'ready' ? (
              <div className="space-y-3">
                <PageState state={page.state} retry={refresh} />
                {page.state !== 'loading' && (
                  <Button type="button" variant="ghost" onClick={() => navigate(first)}>
                    {m.av_first_page()}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-3">
                  <Button type="button" variant="outline" onClick={refresh}>
                    {m.av_refresh()}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => navigate(first)}>
                    {m.av_first_page()}
                  </Button>
                </div>
                {page.value.requests.length === 0 && (
                  <p role="status" className="rounded-xl border border-border p-5">
                    {m.av_empty()}
                  </p>
                )}
                <div className="space-y-5">
                  {page.value.requests.map(({ request, account, subject }) => (
                    <Card key={request.id}>
                      <CardHeader>
                        <CardTitle>
                          {account ? (
                            <h2 className="text-xl">
                              <AccountReference account={account} />
                            </h2>
                          ) : (
                            <AccountReference account={null} />
                          )}
                        </CardTitle>
                        {subject ? (
                          <VerificationLink
                            className={linkClass}
                            href={subjectHref({ id: subject.id, label: subject.name }, getLocale()).href}
                          >
                            {subject.name}
                          </VerificationLink>
                        ) : (
                          <Tombstone shape="row" labels={{ unavailable: m.av_subject_unavailable() }} />
                        )}
                        <VerificationLink className={linkClass} href={verificationHref(request.accountId)}>
                          {m.av_status_title()}
                        </VerificationLink>
                      </CardHeader>
                      <CardContent className="space-y-5">
                        <details className="space-y-4">
                          <summary className="cursor-pointer py-2 font-medium text-primary">{m.av_evidence()}</summary>
                          <Evidence request={request} />
                          {request.state === 'pending' && actions.length > 0 && (
                            <OperationForm
                              key={`${viewerId}:${request.id}:${actions.join(',')}`}
                              reconciled={command?.targetId === request.id && operation.result?.state === 'accepted'}
                              actions={actions}
                              targetId={request.id}
                              draft={command?.targetId === request.id ? command : null}
                              disabled={
                                disabled || (command?.targetId === request.id && operation.result?.state === 'accepted')
                              }
                              onSubmit={(input) => void operation.run(input)}
                            />
                          )}
                        </details>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                {page.value.next && (
                  <Button type="button" variant="outline" onClick={() => navigate(() => next(page.value.next!))}>
                    {m.av_next_page()}
                  </Button>
                )}
              </>
            )}
          </Frame>
        )}
      </ReviewContent>
    </VerificationDecisions>
  );
}

export function AccountVerificationPageView(props: Parameters<typeof AccountVerificationPageViewContent>[0]) {
  return (
    <VerificationDeparture>
      <AccountVerificationPageViewContent key={props.viewerId} {...props} />
    </VerificationDeparture>
  );
}

function AccountVerificationPageViewContent({
  page,
  accountId,
  viewerId,
  submit,
  refresh,
  canWrite = true,
}: {
  page: ReadState<AccountPage> | { state: 'loading' };
  accountId: string;
  viewerId: string | null;
  submit: SubmitOperation;
  refresh: () => void;
  canWrite?: boolean;
}) {
  const value = page.state === 'ready' ? page.value : null;
  const {
    account = null,
    latest = { state: 'denied' } as const,
    publication = { state: 'unverified' } as const,
    reviewer = false,
    operations = [],
  } = value ?? {};
  const request = latest.state === 'ready' ? latest.value : null;
  const actions: Operation['action'][] = [];
  // These controls express native results, never a role name or an inferred public profile grant.
  if (request?.state === 'pending' && operations.includes('account.withdraw_verification')) actions.push('withdraw');
  if (publication.state === 'verified') {
    if (latest.state === 'ready' && operations.includes('account.release_verification')) actions.push('release');
    if (reviewer && operations.includes('account.revoke_verification')) actions.push('revoke');
  }
  const authorized = !!viewerId && actions.length > 0;
  const operation = useOperationAttempt(
    viewerId ? `verification:${viewerId}:account:${accountId}` : null,
    submit,
    refresh,
    canWrite,
    `${authorized}:${actions.join(',')}`,
  );
  if (page.state !== 'ready')
    return (
      <Frame title={m.av_status_title()}>
        <PageState state={page.state} retry={refresh} />
      </Frame>
    );
  const privateVisible = latest.state === 'ready' || reviewer;
  return (
    <VerificationDecisions operation={operation} authorized={authorized}>
      <Frame title={m.av_status_title()}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {account ? (
            <h2 className="text-xl">
              <AccountReference account={account} />
            </h2>
          ) : (
            <AccountReference account={null} />
          )}
          <Button type="button" variant="outline" onClick={refresh}>
            {m.av_refresh()}
          </Button>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{m.av_public_identity()}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {publication.state === 'verified' ? (
              <>
                <p>{m.av_verified({ subject: publication.subject.label })}</p>
                <VerificationLink
                  className={linkClass}
                  href={subjectHref({ id: publication.subject.id, label: publication.subject.label }, getLocale()).href}
                >
                  {publication.subject.label}
                </VerificationLink>
                <p className="text-sm text-muted-foreground">{m.av_not_endorsement()}</p>
              </>
            ) : (
              <p role="status">
                {publication.state === 'unverified' ? m.av_not_verified() : m.av_public_unavailable()}
              </p>
            )}
            {request?.state === 'approved' && publication.state !== 'verified' && (
              <p role="status">{m.av_publication_pending()}</p>
            )}
          </CardContent>
        </Card>
        {privateVisible && (operation.result || operation.attempt) && (
          <OperationFeedback
            operation={operation}
            disabled={!canWrite || !operation.command || !actions.includes(operation.command.action)}
          />
        )}
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{m.av_application()}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {latest.state !== 'ready' ? (
              <PageState state={latest.state} retry={refresh} />
            ) : request ? (
              <>
                <VerificationLink
                  className={linkClass}
                  href={
                    subjectHref({ id: request.catalogueSubjectId, label: request.catalogueSubjectId }, getLocale()).href
                  }
                >
                  {m.av_requested_subject()}
                </VerificationLink>
                <Evidence request={request} />
              </>
            ) : (
              <p>{m.av_no_application()}</p>
            )}
            {latest.state === 'ready' && (
              <VerificationLink className={linkClass} href={`/${getLocale()}/settings`}>
                {m.av_applicant_settings()}
              </VerificationLink>
            )}
          </CardContent>
        </Card>
        {actions.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>{m.av_decision()}</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <OperationForm
                key={`${accountId}:${actions.join(',')}`}
                draft={operation.command}
                reconciled={operation.result?.state === 'accepted'}
                actions={actions}
                targetId={accountId}
                disabled={!canWrite || operation.busy || !!operation.attempt || operation.result?.state === 'accepted'}
                onSubmit={(input) => void operation.run(input)}
              />
            </CardContent>
          </Card>
        )}
        {reviewer && (
          <VerificationLink className={linkClass} href={reviewHref()}>
            {m.av_review_title()}
          </VerificationLink>
        )}
      </Frame>
    </VerificationDecisions>
  );
}

export function AccountManagementPageView({
  page,
  refresh,
}: {
  page: ReadState<string> | { state: 'loading' };
  refresh: () => void;
}) {
  return (
    <Frame title={m.av_accounts()}>
      {page.state !== 'ready' ? (
        <PageState state={page.state} retry={refresh} />
      ) : (
        <nav aria-label={m.av_accounts()} className="grid gap-5 rounded-xl border border-border p-5">
          <VerificationLink className={linkClass} href={verificationHref(page.value)}>
            {m.av_my_verification()}
          </VerificationLink>
          <VerificationLink className={linkClass} href={reviewHref()}>
            {m.av_review_title()}
          </VerificationLink>
          <VerificationLink className={linkClass} href={`/${getLocale()}/settings`}>
            {m.av_applicant_settings()}
          </VerificationLink>
        </nav>
      )}
    </Frame>
  );
}
