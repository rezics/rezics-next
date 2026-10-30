import { Menu } from '@rezics/ui/menu';
import { Tombstone } from '@rezics/ui/tombstone';
import { ListRow, ListRowControl } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { EllipsisIcon } from 'lucide-react';
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import {
  interval,
  type AccessIO,
  type AccessSnapshot,
  type AccessState,
  type Change,
  type Grant,
  type Identity,
  type Subject,
} from './data';
import { AccessRecovery } from './recovery';

function identityName(identity: Identity | undefined, fallback?: string) {
  if (identity?.state === 'deleted') return m.access_deleted_account();
  return identity?.displayName || (identity?.handle ? `@${identity.handle}` : fallback) || m.access_unknown_account();
}
function SubjectName({ subject, page }: { subject: Subject; page: AccessSnapshot }) {
  if (subject.kind === 'active_accounts') return <>{m.access_active_accounts()}</>;
  if (subject.kind === 'realm')
    return (
      <>
        {subject.id} · {subject.role === 'owner' ? m.access_realm_owners() : m.access_realm_members()}
      </>
    );
  const identity = page.identities.find((identity) => identity.id === subject.id);
  if (identity?.state === 'deleted')
    return <Tombstone shape="row" reason="deleted" labels={{ deleted: m.access_deleted_account() }} />;
  return (
    <>
      <span>{identityName(identity, subject.id)}</span>
      {subject.kind === 'organization' ? (
        <span className="text-muted-foreground">
          {' '}
          · {subject.role === 'owner' ? m.access_org_owners() : m.access_org_members()}
        </span>
      ) : null}
    </>
  );
}
function roleName(id: string) {
  const name = id.split('.').at(-1);
  if (name === 'owner') return m.access_role_owner();
  if (name === 'standing') return m.access_role_standing();
  if (name === 'moderator') return m.access_role_moderator();
  if (name === 'member') return m.access_role_member();
  return m.access_role_unavailable();
}
function actionName(action: string) {
  const names: Record<string, () => string> = {
    'collection:read': m.access_permission_read,
    'space:read': m.access_permission_read,
    'realm:read': m.access_permission_read,
    'collection:update': m.access_permission_edit,
    'space:manage': m.access_permission_manage,
    'realm:manage': m.access_permission_manage,
    'collection:delete': m.access_permission_delete,
    'realm:ban': m.access_permission_ban,
    'realm:publish': m.access_permission_publish,
    'board:create': m.access_permission_boards,
    'access:grant': m.access_permission_access,
    'moderation:takedown': m.access_permission_moderate,
    'realm:join': m.access_permission_join,
    'realm:participate': m.access_permission_participate,
  };
  return names[action]?.() ?? m.access_permission_other();
}
function dateLabel(value: string | null, fallback: string) {
  return value
    ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : fallback;
}
function localDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}

function GrantForm({
  page,
  grant,
  io,
  onSubmit,
  onCancel,
}: {
  page: AccessSnapshot;
  grant: Grant | null;
  io: AccessIO;
  onSubmit(change: Omit<Change, 'key'>): void;
  onCancel(): void;
}) {
  const [kind, setKind] = useState<'role' | 'direct'>(grant?.kind ?? 'role');
  const [role, setRole] = useState(grant?.role ?? page.roles.find((role) => role.delegable)?.id ?? '');
  const [action, setAction] = useState(grant?.actions[0] ?? page.actions[0] ?? '');
  const [recipient, setRecipient] = useState('account');
  const [handle, setHandle] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [groupRole, setGroupRole] = useState<'owner' | 'member'>('member');
  const [startsAt, setStartsAt] = useState(localDate(grant?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(localDate(grant?.endsAt ?? null));
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const valid = interval(startsAt, endsAt);
    const subject: Subject | null =
      grant?.subject ??
      (recipient === 'active_accounts'
        ? { kind: 'active_accounts' }
        : identity
          ? recipient === 'organization'
            ? identity.kind === 'organization'
              ? { kind: 'organization', id: identity.id, role: groupRole }
              : null
            : { kind: 'account', id: identity.id }
          : null);
    if (
      !valid ||
      !subject ||
      subject.kind === 'realm' ||
      (kind === 'role'
        ? !page.roles.some((item) => item.id === role && item.delegable)
        : !page.actions.includes(action))
    ) {
      setError(m.access_form_invalid());
      return;
    }
    onSubmit({
      resourceId: page.resource.id,
      operation: grant ? 'change' : 'create',
      kind,
      subject,
      role: kind === 'role' ? role : null,
      actions: kind === 'direct' ? [action] : [],
      valid,
      ...(grant ? { previous: { role: grant.role, actions: grant.actions, valid: grant.valid } } : {}),
    });
  };
  const lookup = async () => {
    setFinding(true);
    setIdentity(null);
    setError(null);
    try {
      const found = await io.lookup(handle);
      if (!found || (recipient === 'organization' && found.kind !== 'organization')) setError(m.access_lookup_failed());
      else setIdentity(found);
    } catch {
      setError(m.access_unavailable());
    } finally {
      setFinding(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-5 rounded-xl bg-muted/40 p-4 sm:p-6"
      aria-labelledby="access-form-heading"
    >
      <h2 id="access-form-heading" className="text-lg font-semibold">
        {grant ? m.access_edit_grant() : m.access_add_grant()}
      </h2>
      {grant ? (
        <p>
          <SubjectName subject={grant.subject} page={page} />
        </p>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="access-recipient">{m.access_recipient()}</FieldLabel>
            <NativeSelect
              id="access-recipient"
              disabled={finding}
              value={recipient}
              onChange={(event) => {
                setRecipient(event.target.value);
                setIdentity(null);
              }}
            >
              <NativeSelectOption value="account">{m.access_account()}</NativeSelectOption>
              <NativeSelectOption value="organization">{m.access_organization_group()}</NativeSelectOption>
              <NativeSelectOption value="active_accounts">{m.access_active_accounts()}</NativeSelectOption>
            </NativeSelect>
          </Field>
          {recipient !== 'active_accounts' ? (
            <>
              <Field>
                <FieldLabel htmlFor="access-handle">{m.access_handle()}</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="access-handle"
                    disabled={finding}
                    className="min-w-32 flex-1"
                    value={handle}
                    onChange={(event) => {
                      setHandle(event.target.value);
                      setIdentity(null);
                    }}
                    autoComplete="off"
                    maxLength={64}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={finding || !handle.trim()}
                    onClick={() => void lookup()}
                  >
                    {m.access_find_account()}
                  </Button>
                </div>
                <FieldDescription>{identity ? identityName(identity) : m.access_confirm_identity()}</FieldDescription>
              </Field>
              {recipient === 'organization' ? (
                <Field>
                  <FieldLabel htmlFor="access-group-role">{m.access_group_membership()}</FieldLabel>
                  <NativeSelect
                    id="access-group-role"
                    value={groupRole}
                    onChange={(event) => setGroupRole(event.target.value as 'owner' | 'member')}
                  >
                    <NativeSelectOption value="member">{m.access_org_members()}</NativeSelectOption>
                    <NativeSelectOption value="owner">{m.access_org_owners()}</NativeSelectOption>
                  </NativeSelect>
                </Field>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{m.access_active_accounts_description()}</p>
          )}
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="access-kind">{m.access_grant_kind()}</FieldLabel>
          <NativeSelect
            id="access-kind"
            value={kind}
            disabled={grant !== null}
            onChange={(event) => setKind(event.target.value as 'role' | 'direct')}
          >
            <NativeSelectOption value="role">{m.access_named_role()}</NativeSelectOption>
            <NativeSelectOption value="direct">{m.access_direct_action()}</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="access-role">{kind === 'role' ? m.access_role() : m.access_action()}</FieldLabel>
          <NativeSelect
            id="access-role"
            value={kind === 'role' ? role : action}
            onChange={(event) => (kind === 'role' ? setRole(event.target.value) : setAction(event.target.value))}
            required
          >
            <NativeSelectOption value="" disabled>
              {m.access_choose()}
            </NativeSelectOption>
            {kind === 'role'
              ? page.roles
                  .filter((item) => item.delegable)
                  .map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {roleName(item.id)}
                    </NativeSelectOption>
                  ))
              : page.actions.map((item) => (
                  <NativeSelectOption key={item} value={item}>
                    {actionName(item)}
                  </NativeSelectOption>
                ))}
          </NativeSelect>
          {kind === 'role' ? (
            <FieldDescription>
              {page.roles
                .find((item) => item.id === role)
                ?.actions.map(actionName)
                .join(', ')}
            </FieldDescription>
          ) : null}
        </Field>
        <Field>
          <FieldLabel htmlFor="access-start">{m.access_starts()}</FieldLabel>
          <Input
            id="access-start"
            type="datetime-local"
            step="any"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="access-end">{m.access_ends()}</FieldLabel>
          <Input
            id="access-end"
            type="datetime-local"
            step="any"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
          />
        </Field>
      </div>
      <p className="text-sm text-muted-foreground">{m.access_interval_help()}</p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={finding}>
          {m.access_save()}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {m.access_cancel()}
        </Button>
      </div>
    </form>
  );
}

export function ResourceAccessPage({ initial, io }: { initial: AccessState; io: AccessIO }) {
  const [controller] = useState(() => new AccessRecovery(initial, io));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const [form, setForm] = useState<Grant | 'new' | null>(null);
  const [revoke, setRevoke] = useState<Grant | null>(null);
  const page = state.page.status === 'ready' ? state.page.page : null;
  const notice =
    state.phase === 'saved'
      ? m.access_saved()
      : state.phase === 'conflict'
        ? m.access_conflict()
        : state.phase === 'refused'
          ? m.access_refused()
          : state.phase === 'uncertain'
            ? m.access_uncertain()
            : state.phase === 'preparing'
              ? m.access_preparing()
              : state.phase === 'denied'
                ? m.access_denied()
                : null;
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-8 sm:py-10">
      <header className="space-y-2">
        <PageHeading>{m.access_heading()}</PageHeading>
        <p className="max-w-2xl text-muted-foreground">{m.access_description()}</p>
      </header>
      {notice ? (
        <p role="status" className="rounded-lg bg-muted p-3">
          {notice}
        </p>
      ) : null}
      {state.pending ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{m.access_retry_help()}</p>
          <Button type="button" disabled={state.busy} onClick={() => void controller.retry()}>
            {m.access_retry_operation()}
          </Button>
        </div>
      ) : null}
      {!page ? (
        <section aria-busy={state.busy || state.page.status === 'loading'} className="space-y-4">
          <p role={state.page.status === 'unavailable' ? 'alert' : 'status'}>
            {state.page.status === 'denied'
              ? m.access_denied()
              : state.page.status === 'loading'
                ? m.access_loading()
                : state.page.status === 'preparing'
                  ? m.access_preparing()
                  : m.access_unavailable()}
          </p>
          {state.page.status !== 'loading' ? (
            <Button type="button" variant="outline" disabled={state.busy} onClick={() => void controller.reload()}>
              {m.access_reload()}
            </Button>
          ) : null}
        </section>
      ) : (
        <>
          <section className="space-y-2" aria-label={m.access_resource()}>
            <p className="text-sm text-muted-foreground">
              {m.access_resource()} <span className="break-all font-medium text-foreground">{page.resource.id}</span>
            </p>
            <p className="text-sm">
              {m.access_acting_as({
                name: identityName(
                  page.identities.find((item) => item.id === page.authority.accountId),
                  page.authority.accountId,
                ),
              })}
            </p>
            {page.authority.principalId ? (
              <p className="text-sm text-muted-foreground">
                {m.access_delegated_by({
                  name: identityName(
                    page.identities.find((item) => item.id === page.authority.principalId),
                    page.authority.principalId,
                  ),
                })}
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">{m.access_authority_help()}</p>
          </section>
          {page.mutationState === 'realm_guard_unavailable' ? (
            <p role="status" className="rounded-lg bg-muted p-4">
              {m.access_realm_guard()}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">{m.access_current_grants()}</h2>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={state.busy}
                onClick={() => {
                  setForm(null);
                  void controller.reload();
                }}
              >
                {m.access_reload()}
              </Button>
              {page.mutationState === 'ready' &&
              (page.actions.length > 0 || page.roles.some((item) => item.delegable)) ? (
                <Button type="button" disabled={state.busy || !!state.pending} onClick={() => setForm('new')}>
                  {m.access_add_grant()}
                </Button>
              ) : null}
            </div>
          </div>
          {form !== null && !state.busy && !state.pending ? (
            <GrantForm
              key={form === 'new' ? 'new' : `${form.valid}:${form.role}:${form.actions.join()}`}
              page={page}
              grant={form === 'new' ? null : form}
              io={io}
              onCancel={() => setForm(null)}
              onSubmit={(change) => {
                setForm(null);
                void controller.submit(change);
              }}
            />
          ) : null}
          {page.grants.length === 0 ? (
            <p role="status" className="py-6 text-muted-foreground">
              {m.access_empty()}
            </p>
          ) : (
            <ul className="space-y-2">
              {page.grants.map((grant, index) => (
                <ListRow key={index} className="flex items-start gap-3 rounded-xl p-3 sm:p-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="break-words font-medium">
                      <SubjectName subject={grant.subject} page={page} />
                    </div>
                    <p className="text-sm">
                      {grant.kind === 'role' ? roleName(grant.role!) : m.access_direct_action()}
                      {grant.state === 'scheduled' ? <> · {m.access_scheduled()}</> : null}
                    </p>
                    <p className="break-words text-sm text-muted-foreground">
                      {grant.actions.map(actionName).join(', ') || m.access_role_unavailable()}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {m.access_valid_interval({
                        start: dateLabel(grant.startsAt, m.access_no_start()),
                        end: dateLabel(grant.endsAt, m.access_no_end()),
                      })}
                    </p>
                  </div>
                  {grant.manageable ? (
                    <ListRowControl>
                      <Menu
                        title={m.access_grant_actions()}
                        trigger={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={m.access_grant_actions()}
                            disabled={state.busy || !!state.pending}
                          >
                            <EllipsisIcon aria-hidden="true" />
                          </Button>
                        }
                        entries={[
                          { type: 'item', label: m.access_edit_grant(), onSelect: () => setForm(grant) },
                          { type: 'destructive', label: m.access_revoke(), onSelect: () => setRevoke(grant) },
                        ]}
                      />
                    </ListRowControl>
                  ) : null}
                </ListRow>
              ))}
            </ul>
          )}
          {page.next ? (
            <Button
              type="button"
              variant="outline"
              disabled={state.busy || !!state.pending}
              onClick={() => {
                setForm(null);
                void controller.reload(page.next!);
              }}
            >
              {m.access_next_page()}
            </Button>
          ) : null}
        </>
      )}
      <AlertDialog
        open={revoke !== null}
        onOpenChange={(open) => {
          if (!open) setRevoke(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.access_revoke_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.access_revoke_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.access_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!revoke || !page) return;
                const { kind, subject, role, actions, valid } = revoke;
                if (subject.kind === 'realm') return;
                setRevoke(null);
                setForm(null);
                void controller.submit({
                  resourceId: page.resource.id,
                  operation: 'revoke',
                  kind,
                  subject,
                  role,
                  actions,
                  valid,
                });
              }}
            >
              {m.access_revoke()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
