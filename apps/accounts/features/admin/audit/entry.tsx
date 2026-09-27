'use client';

import { Badge } from '@rezics/ui/badge';
import type { AuditEntry } from '../api/types.ts';
import { useTranslation } from '../../../i18n/client.ts';

type AdminText = ReturnType<typeof useTranslation<'admin'>>['t'];

/** A readable name for an audit action; unknown actions show as recorded. */
export function actionLabel(action: string, t: AdminText): string {
  return (t.actionLabels as Record<string, string>)[action] ?? action;
}

export function reasonLabel(code: string | null, t: AdminText): string | null {
  return code ? (t.reasonCodes as Record<string, string>)[code] ?? code : null;
}

export const userHref = (id: string) => `/admin/users/${encodeURIComponent(id)}`;

/** Who did it: their name (linked to their user page) or the recorded ID. */
export function Actor({ entry }: { entry: Pick<AuditEntry, 'actorId' | 'actorName' | 'actorEmail'> }) {
  return <a href={userHref(entry.actorId)} className="font-medium hover:underline">
    {entry.actorName || entry.actorEmail || entry.actorId}</a>;
}

/** What it was done to: a user (linked), an OAuth client or a recorded ID. */
export function Target({ entry }: { entry: Pick<AuditEntry, 'targetId' | 'targetKind' | 'targetName' | 'targetEmail'> }) {
  if (entry.targetKind === 'user') {
    return <a href={userHref(entry.targetId)} className="font-medium hover:underline">
      {entry.targetName || entry.targetEmail || entry.targetId}</a>;
  }
  if (entry.targetKind === 'client') return <span className="font-medium">{entry.targetName ?? entry.targetId}</span>;
  return <span className="font-mono text-xs text-muted-foreground">{entry.targetId}</span>;
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  const { t } = useTranslation('admin');
  if (outcome === 'succeeded') return <Badge variant="success" size="sm">{t.outcomes.succeeded}</Badge>;
  if (outcome === 'failed') return <Badge variant="destructive" size="sm">{t.outcomes.failed}</Badge>;
  return <Badge variant="warning" size="sm">{(t.outcomes as Record<string, string>)[outcome] ?? outcome}</Badge>;
}
