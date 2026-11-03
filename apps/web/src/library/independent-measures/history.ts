import { getLocale } from '../../paraglide/runtime.js';

export function independentSessionHref(sessionId: string, search?: { changes?: string; logs?: string }): string {
  const locale = getLocale();
  const params = new URLSearchParams();
  if (search?.changes) params.set('changes', search.changes);
  if (search?.logs) params.set('logs', search.logs);
  const query = params.size ? `?${params.toString()}` : '';
  return `/${locale}/library/progress/${encodeURIComponent(sessionId)}${query}`;
}

export function independentIndexHref(subjectId: string): string {
  const locale = getLocale();
  return `/${locale}/library/progress?subjectId=${encodeURIComponent(subjectId)}`;
}

export function independentLogsHref(sessionId: string, logs?: string): string {
  return independentSessionHref(sessionId, logs ? { logs } : undefined);
}
