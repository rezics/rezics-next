import type { KernelClient } from '@rezics/client';
import { serverSettingsTimer } from './adapters/ambient';
import { settingsCommandKeyHeader } from './command-headers';
import {
  createEditableProfileSource,
  parseProfilePatchAck,
  type EditableProfileSource,
} from './editable-profile-source';
import { withProfileDeadline } from './profile-request-deadline';
import {
  profileChanges,
  profileCommandValues,
  projectProfileRecord,
  type ObservedProfile,
  type ProfileSaveResult,
  type ProfileValues,
} from './profile-model';
import { nativeProfileFailure } from './profile-failure';

export async function loadProfileRecord(
  client: KernelClient,
  authorization: string,
  accountId: string,
  source: EditableProfileSource = createEditableProfileSource(client),
  signal?: AbortSignal,
): Promise<ObservedProfile> {
  const { profile, editing } = await source.read(authorization, accountId, signal);
  if (profile.id !== accountId) throw new Error('Profile unavailable');
  return projectProfileRecord(profile, editing);
}

export async function saveProfileRecord(
  client: KernelClient,
  authorization: string,
  accountId: string,
  before: ProfileValues,
  after: ProfileValues,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ProfileSaveResult> {
  if (after.links.length > 5) throw new Error('At most five links are allowed');
  const body = profileChanges(before, after);
  if (!Object.keys(body).length) return { ok: true, profile: profileCommandValues(before) };
  const headers = {
    authorization,
    'idempotency-key': settingsCommandKeyHeader(idempotencyKey),
    'cache-control': 'no-store',
  };
  const result = await withProfileDeadline(
    (bounded) => client.accounts({ accountId }).patch(body, { headers, fetch: { cache: 'no-store', signal: bounded } }),
    signal,
    serverSettingsTimer(),
  );
  if (!result.error && result.data) {
    const ack = parseProfilePatchAck(result.data, accountId);
    if (!ack) return { ok: false, status: 503, message: '' };
    return { ok: true, profile: profileCommandValues(after) };
  }
  const errorBody = result.error?.value;
  const message =
    errorBody && typeof errorBody === 'object' && 'detail' in errorBody && typeof errorBody.detail === 'string'
      ? errorBody.detail
      : '';
  const failure = nativeProfileFailure(result.status, errorBody, result.headers);
  return {
    ok: false,
    status: result.status,
    message,
    ...(Object.keys(failure).length > 1 ? { failure } : {}),
  };
}
