import type { AccessSnapshot, Change, Grant } from './data';
import { resourceLabel } from './owner-transfer.tsx';
import { permissionPresentation, rolePresentation } from './permission-presentation';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { Button } from '@rezics/ui/shadcn/button';

function dateLabel(value: string | null, fallback: string) {
  return value
    ? new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : fallback;
}

function nativeDate(value: string) {
  return value ? new Date(value).toISOString() : null;
}

export function PermissionExpansion({ actions }: { actions: readonly string[] }) {
  return actions.length ? (
    <ul className="grid gap-2">
      {actions.map((identifier, index) => {
        const permission = permissionPresentation(identifier);
        return (
          <li key={`${identifier}:${index}`} className="min-w-0">
            <p className="font-medium">{permission.label}</p>
            <p className="text-sm text-muted-foreground">{permission.effect}</p>
            <code className="break-all text-xs text-muted-foreground">{permission.identifier}</code>
          </li>
        );
      })}
    </ul>
  ) : null;
}

export function GrantContents({
  kind,
  role,
  actions,
}: {
  kind: Grant['kind'];
  role: string | null;
  actions: readonly string[];
}) {
  const presentedRole = role ? rolePresentation(role) : null;
  return (
    <div className="grid gap-2">
      <p className="font-medium">{kind === 'role' ? m.access_named_role() : m.access_direct_action()}</p>
      {presentedRole ? (
        <div>
          <p>{presentedRole.label}</p>
          <code className="break-all text-xs text-muted-foreground">{presentedRole.identifier}</code>
        </div>
      ) : null}
      <p className="text-sm font-medium">{kind === 'role' ? m.access_review_expansion() : m.access_action()}</p>
      <PermissionExpansion actions={actions} />
    </div>
  );
}

function GrantValue({
  label,
  kind,
  role,
  actions,
  valid,
  startsAt,
  endsAt,
  state,
}: {
  label: string;
  kind: Grant['kind'];
  role: string | null;
  actions: readonly string[];
  valid: string;
  startsAt: string | null;
  endsAt: string | null;
  state?: string;
}) {
  return (
    <section aria-label={label} className="min-w-0 rounded-lg border p-3">
      <h4 className="font-semibold">{label}</h4>
      {state === 'active' ? <p>{m.access_active()}</p> : null}
      {state === 'scheduled' ? <p>{m.access_scheduled()}</p> : null}
      {state === 'expired' ? <p>{m.access_expired()}</p> : null}
      <GrantContents kind={kind} role={role} actions={actions} />
      <p className="mt-2 text-sm text-muted-foreground">
        {m.access_valid_interval({
          start: dateLabel(startsAt, m.access_no_start()),
          end: dateLabel(endsAt, m.access_no_end()),
        })}
      </p>
      <details className="text-sm">
        <summary>{m.access_identity_valid()}</summary>
        <code className="break-all">{valid}</code>
      </details>
    </section>
  );
}

export function GrantReview({
  page,
  grant,
  change,
  recipientLabel,
  recipientKind,
  recipientId,
  startsAt,
  endsAt,
  onBack,
  onConfirm,
}: {
  page: AccessSnapshot;
  grant: Grant | null;
  change: Omit<Change, 'key'>;
  recipientLabel: string;
  recipientKind: string;
  recipientId: string | null;
  startsAt: string;
  endsAt: string;
  onBack(): void;
  onConfirm(): void;
}) {
  const actor = page.identities.find((identity) => identity.id === page.authority.accountId);
  const principal = page.authority.principalId
    ? page.identities.find((identity) => identity.id === page.authority.principalId)
    : undefined;
  const actorName =
    actor?.state === 'active'
      ? actor.displayName || (actor.handle ? `@${actor.handle}` : m.access_unknown_account())
      : actor?.state === 'deleted'
        ? m.access_deleted_account()
        : m.access_unknown_account();
  const principalName =
    principal?.state === 'active'
      ? principal.displayName || (principal.handle ? `@${principal.handle}` : m.access_unknown_account())
      : principal?.state === 'deleted'
        ? m.access_deleted_account()
        : m.access_unknown_account();
  const role = page.roles.find((item) => item.id === change.role);
  const proposedActions = change.kind === 'role' ? (role?.actions ?? []) : change.actions;
  const proposedValid = change.valid;

  return (
    <section aria-labelledby="access-review-heading" className="space-y-4 rounded-xl border bg-background p-4 sm:p-6">
      <header className="space-y-1">
        <h3 id="access-review-heading" className="text-lg font-semibold">
          {m.access_review_title()}
        </h3>
        <p className="text-sm text-muted-foreground">{m.access_review_description()}</p>
      </header>
      <dl className="grid gap-3 [overflow-wrap:anywhere] sm:grid-cols-2">
        <div>
          <dt className="font-medium">{m.access_resource()}</dt>
          <dd>{resourceLabel(page.resource.type)}</dd>
          <dd>
            <code>{page.resource.id}</code>
          </dd>
        </div>
        <div>
          <dt className="font-medium">{m.access_acting_as({ name: actorName })}</dt>
          <dd>
            <code>{page.authority.accountId}</code>
          </dd>
          {page.authority.principalId ? <dd>{m.access_delegated_by({ name: principalName })}</dd> : null}
        </div>
        <div className="sm:col-span-2">
          <dt className="font-medium">{recipientKind}</dt>
          <dd>{recipientLabel}</dd>
          {recipientId ? (
            <dd>
              <code>{recipientId}</code>
            </dd>
          ) : null}
        </div>
      </dl>
      <div className="grid gap-3 sm:grid-cols-2">
        {grant ? (
          <GrantValue
            label={m.access_review_current()}
            kind={grant.kind}
            role={grant.role}
            actions={grant.actions}
            valid={grant.valid}
            startsAt={grant.startsAt}
            endsAt={grant.endsAt}
            state={grant.state}
          />
        ) : (
          <section aria-label={m.access_review_current()} className="rounded-lg border p-3">
            <h4 className="font-semibold">{m.access_review_current()}</h4>
            <p>{m.access_review_no_current()}</p>
          </section>
        )}
        <GrantValue
          label={m.access_review_proposed()}
          kind={change.kind}
          role={change.role}
          actions={proposedActions}
          valid={proposedValid}
          startsAt={nativeDate(startsAt)}
          endsAt={nativeDate(endsAt)}
        />
      </div>
      <p className="text-sm text-muted-foreground">{m.access_interval_semantics()}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          {m.access_review_edit()}
        </Button>
        <Button type="button" onClick={onConfirm}>
          {m.access_review_confirm()}
        </Button>
      </div>
    </section>
  );
}
