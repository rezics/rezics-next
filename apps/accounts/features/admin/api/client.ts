// Browser calls to the Account operator API through this origin's proxy.
import type { AccountErrorCode, ActionBody, ActivityPage, AdminMe, AppPage, AuditExportFormat, AuditPage, AuditParams, BulkBody,
  ClientActionBody, ClientPage, CommandResult, Directory, DirectoryParams, Installation, InstallationChange, Job,
  OperatorRole, Operators, Overview, PreferenceChange, Preferences, ReviewBody, SessionPage, Signals, TimelineCategory,
  TimelinePage, UserDetail } from './types.ts';

/** `network`: the request never reached the service. */
export type AdminFailure = { ok: false; code: AccountErrorCode | 'network'; status: number };
export type AdminResult<T> = { ok: true; data: T } | AdminFailure;

type Query = Record<string, string | number | boolean | null | undefined>;
export function queryString(query: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<AdminResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal,
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { ok: false, code: 'network', status: 0 };
  }
  const data = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const code = typeof data === 'object' && data && 'error' in data && typeof data.error === 'string'
      ? data.error as AccountErrorCode : 'temporarily_unavailable';
    return { ok: false, code, status: response.status };
  }
  return { ok: true, data: data as T };
}

interface AuditExport { blob: Blob; rows: number; truncated: boolean }

export interface AdminApi {
  me(): Promise<AdminResult<AdminMe>>;
  overview(): Promise<AdminResult<Overview>>;
  signals(): Promise<AdminResult<Signals>>;
  reviewSignal(body: ReviewBody): Promise<AdminResult<CommandResult>>;
  users(params: DirectoryParams, signal?: AbortSignal): Promise<AdminResult<Directory>>;
  user(userId: string): Promise<AdminResult<UserDetail>>;
  sessions(userId: string, cursor: string): Promise<AdminResult<SessionPage>>;
  apps(userId: string, cursor: string): Promise<AdminResult<AppPage>>;
  activity(userId: string, cursor: string): Promise<AdminResult<ActivityPage>>;
  timeline(userId: string, query: { category?: TimelineCategory; cursor?: string }): Promise<AdminResult<TimelinePage>>;
  audit(params: AuditParams): Promise<AdminResult<AuditPage>>;
  exportAudit(params: AuditParams, format?: AuditExportFormat): Promise<AdminResult<AuditExport>>;
  operators(): Promise<AdminResult<Operators>>;
  clients(cursor?: string): Promise<AdminResult<ClientPage>>;
  job(jobId: string): Promise<AdminResult<Job>>;
  act(userId: string, body: ActionBody): Promise<AdminResult<CommandResult>>;
  bulk(body: BulkBody): Promise<AdminResult<{ jobId: string }>>;
  /** Cancels what a job hasn't done yet: all of it inside its undo window. */
  cancelJob(jobId: string): Promise<AdminResult<{ cancelled: number }>>;
  setRole(userId: string, role: OperatorRole | null, reason: string): Promise<AdminResult<CommandResult>>;
  setClient(clientId: string, body: ClientActionBody): Promise<AdminResult<CommandResult>>;
  changeInstallation(body: InstallationChange): Promise<AdminResult<Installation>>;
  reauthenticate(password: string, totpCode?: string): Promise<AdminResult<{ verifiedUntil: string }>>;
  savePreferences(change: PreferenceChange): Promise<AdminResult<Preferences>>;
}

const admin = '/api/account/admin';
const path = (value: string) => encodeURIComponent(value);

export const browserAdminApi: AdminApi = {
  me: () => call(`${admin}/me`),
  overview: () => call(`${admin}/overview`),
  signals: () => call(`${admin}/signals`),
  reviewSignal: body => call(`${admin}/signals/review`, body),
  users: (params, signal) => call(`${admin}/users${queryString(params)}`, undefined, signal),
  user: userId => call(`${admin}/users/${path(userId)}`),
  sessions: (userId, cursor) => call(`${admin}/users/${path(userId)}/sessions${queryString({ cursor, limit: 25 })}`),
  apps: (userId, cursor) => call(`${admin}/users/${path(userId)}/apps${queryString({ cursor, limit: 25 })}`),
  activity: (userId, cursor) => call(`${admin}/users/${path(userId)}/security-activity${queryString({ cursor, limit: 25 })}`),
  timeline: (userId, query) => call(`${admin}/users/${path(userId)}/timeline${queryString({ ...query, limit: 25 })}`),
  audit: params => call(`${admin}/audit${queryString(params)}`),
  async exportAudit(params, format = 'csv') {
    let response: Response;
    try { response = await fetch(`${admin}/audit/export${queryString({ ...params, format })}`, { credentials: 'same-origin' }); }
    catch { return { ok: false, code: 'network', status: 0 }; }
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: AccountErrorCode } | null;
      return { ok: false, code: data?.error ?? 'temporarily_unavailable', status: response.status };
    }
    return { ok: true, data: { blob: await response.blob(), rows: Number(response.headers.get('x-rezics-rows') ?? 0),
      truncated: response.headers.get('x-rezics-truncated') === 'true' } };
  },
  operators: () => call(`${admin}/operators`),
  clients: cursor => call(`${admin}/clients${queryString({ cursor, limit: 100 })}`),
  job: jobId => call(`${admin}/bulk-actions/${path(jobId)}`),
  act: (userId, body) => call(`${admin}/users/${path(userId)}/actions`, body),
  bulk: body => call(`${admin}/bulk-actions`, body),
  cancelJob: jobId => call(`${admin}/bulk-actions/${path(jobId)}/cancel`, {}),
  setRole: (userId, role, reason) => call(`${admin}/operators/${path(userId)}`, { role, reason }),
  setClient: (clientId, body) => call(`${admin}/clients/${path(clientId)}/actions`, body),
  changeInstallation: body => call('/api/account/installation-changes', body),
  reauthenticate: (password, totpCode) => call('/api/account/reauthenticate', { password, ...(totpCode ? { totpCode } : {}) }),
  savePreferences: change => call(`${admin}/preferences`, change),
};
