const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Existing status journey with a fixed local return address; only the native cursor is opaque. */
export function reporterHistoryStatusHref(reportId: string, cursor?: string): string {
  const search = new URLSearchParams();
  search.set('historyReportId', reportId);
  if (cursor !== undefined) search.set('historyCursor', cursor);
  return `/moderation/reports/${encodeURIComponent(reportId)}?${search}`;
}

/** Ignore arbitrary return URLs and accept only the selected report's exact history operands. */
export function reporterHistoryReturnHref(search: unknown, routeReportId: string): string | null {
  if (!uuid.test(routeReportId) || !search || typeof search !== 'object' || Array.isArray(search)) return null;
  const values = search as Record<string, unknown>;
  const reportId = values.historyReportId;
  const cursor = values.historyCursor;
  if (reportId !== routeReportId || typeof reportId !== 'string' || !uuid.test(reportId)) return null;
  if (cursor !== undefined && typeof cursor !== 'string') return null;
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set('cursor', cursor);
  params.set('reportId', reportId);
  return `/moderation/reports?${params}`;
}

/** Closed consumed search on the status route. Invalid context recovers to the local inventory. */
export function reporterHistoryStatusSearch(search: unknown): { historyReportId?: string; historyCursor?: string } {
  if (!search || typeof search !== 'object' || Array.isArray(search)) return {};
  const values = search as Record<string, unknown>;
  if (typeof values.historyReportId !== 'string' || !uuid.test(values.historyReportId)) return {};
  if (values.historyCursor !== undefined && typeof values.historyCursor !== 'string') return {};
  return {
    historyReportId: values.historyReportId,
    ...(values.historyCursor === undefined ? {} : { historyCursor: values.historyCursor }),
  };
}
