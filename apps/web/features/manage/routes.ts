import type { ModerationKind } from './types.ts';

export type RealmSection = 'queue' | 'log' | 'members' | 'roles' | 'settings';

/** A Realm's management page, unlocalized; links localize it (`features/shell/localized-link.tsx`). */
export function realmHref(realm: string, section: RealmSection = 'queue'): string {
  return section === 'queue' ? `/manage/r/${realm}` : `/manage/r/${realm}/${section}`;
}

export interface QueueView { state: 'open' | 'closed'; type: ModerationKind | null }

const kinds: readonly ModerationKind[] = ['content_report', 'rights_complaint', 'contribution_submission',
  'correction_submission'];

/** The queue filters in the address. A malformed value falls back to the default view. */
export function parseQueueView(params: Record<string, string | string[] | undefined>): QueueView {
  const state = params.state === 'closed' ? 'closed' : 'open';
  const type = typeof params.type === 'string' && (kinds as readonly string[]).includes(params.type)
    ? params.type as ModerationKind : null;
  return { state, type };
}

export function queueHref(realm: string, view: QueueView): string {
  const search = new URLSearchParams();
  if (view.state === 'closed') search.set('state', 'closed');
  if (view.type) search.set('type', view.type);
  const query = search.toString();
  return `${realmHref(realm)}${query ? `?${query}` : ''}`;
}

export type AuditFilter = 'content_moderation' | 'rights_disposition' | 'organization_publication_rejection'
  | 'realm_management';
const auditKinds: readonly AuditFilter[] = ['content_moderation', 'rights_disposition',
  'organization_publication_rejection', 'realm_management'];

export interface LogView { view: 'public' | 'audit'; kind: AuditFilter | null }

export function parseLogView(params: Record<string, string | string[] | undefined>): LogView {
  const view = params.view === 'public' ? 'public' : 'audit';
  const kind = typeof params.kind === 'string' && (auditKinds as readonly string[]).includes(params.kind)
    ? params.kind as AuditFilter : null;
  return { view, kind: view === 'audit' ? kind : null };
}

export function logHref(realm: string, view: LogView): string {
  const search = new URLSearchParams();
  if (view.view === 'public') search.set('view', 'public');
  else if (view.kind) search.set('kind', view.kind);
  const query = search.toString();
  return `${realmHref(realm, 'log')}${query ? `?${query}` : ''}`;
}
