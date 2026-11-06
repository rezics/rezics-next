import type { AccessSnapshot, Grant } from './data';

export type GrantDraft = {
  kind: 'role' | 'direct';
  role: string;
  action: string;
  recipient: string;
  handle: string;
  groupRole: 'owner' | 'member';
  startsAt: string;
  endsAt: string;
  permissionFilter: string;
};
export type TransferDraft = { handle: string };
type Draft = { kind: 'grant'; value: GrantDraft } | { kind: 'transfer'; value: TransferDraft };

export function accessAuthority(page: AccessSnapshot): string {
  return JSON.stringify([page.resource.id, page.resource.route, page.resource.type, page.authority]);
}
export function grantReference(grant: Grant | null): string {
  return JSON.stringify(grant && [grant.kind, grant.subject, grant.role, grant.actions, grant.valid]);
}

/** Local text and choices survive a recoverable read, never a reviewed identity or permission decision.
 * One mounted editor owns at most one draft. No storage or automatic command replay is involved.
 */
export class AccessDraftStore {
  private entry: { scope: string; reference: string; draft: Draft; changed: boolean } | null = null;
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  get changed() {
    return this.entry?.changed ?? false;
  }
  readGrant(page: AccessSnapshot, grant: Grant | null): GrantDraft | undefined {
    const entry = this.match(page, grant);
    return this.entry?.changed && entry?.kind === 'grant' ? entry.value : undefined;
  }
  readTransfer(page: AccessSnapshot, grant: Grant): TransferDraft | undefined {
    const entry = this.match(page, grant);
    return entry?.kind === 'transfer' ? entry.value : undefined;
  }
  private match(page: AccessSnapshot, grant: Grant | null): Draft | undefined {
    return this.entry?.scope === accessAuthority(page) && this.entry.reference === grantReference(grant)
      ? this.entry.draft
      : undefined;
  }
  rememberGrant(page: AccessSnapshot, grant: Grant | null, value: GrantDraft, changed: boolean) {
    this.remember(page, grant, { kind: 'grant', value: { ...value } }, changed);
  }
  rememberTransfer(page: AccessSnapshot, grant: Grant, value: TransferDraft) {
    this.remember(page, grant, { kind: 'transfer', value: { ...value } }, value.handle !== '');
  }
  private remember(page: AccessSnapshot, grant: Grant | null, draft: Draft, changed: boolean) {
    const next = { scope: accessAuthority(page), reference: grantReference(grant), draft, changed };
    if (JSON.stringify(next) === JSON.stringify(this.entry)) return;
    this.entry = next;
    this.publish();
  }
  clear = () => {
    if (!this.entry) return;
    this.entry = null;
    this.publish();
  };
  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}
