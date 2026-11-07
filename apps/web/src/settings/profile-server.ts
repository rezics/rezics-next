import type { SettingsContentFailureReader } from './ports/content';
import type { SessionEnv } from '../session/client';
import { serverSettingsTimer } from './adapters/ambient';
import { loadProfileRecord, saveProfileRecord } from './profile-data';
import { withProfileDeadline } from './profile-request-deadline';
import {
  profileChanges,
  profileCommandValues,
  profileControlFlow,
  profilePatchAdmitted,
  profileReadResult,
  profileReadSetupFailure,
  profileSaveSetupFailure,
  serializeProfileResult,
  type ProfileReadResult,
  type ProfileSaveResult,
  type ProfileValues,
} from './profile-model';
import { EditableProfileReadError, profileReadFailure } from './profile-failure';

export async function runReadProfile(
  mediaFailure: SettingsContentFailureReader = () => undefined,
): Promise<ProfileReadResult> {
  try {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../kernel/client');
    const { prepareSession, sessionSubject, viewerCredential } = await import('../session/request');
    try {
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      const accountId = sessionSubject(request);
      return serializeProfileResult(
        await profileReadResult(async () => {
          if (!authorization || !accountId) throw new EditableProfileReadError(401);
          return loadProfileRecord(kernelClient(), authorization, accountId);
        }, mediaFailure),
      );
    } catch (error) {
      profileControlFlow(error);
      const failure = profileReadFailure(error, mediaFailure);
      if (failure)
        return serializeProfileResult({
          ok: false as const,
          status: failure.status,
          ...(Object.keys(failure).length > 1 ? { failure } : {}),
        });
      return serializeProfileResult(profileReadSetupFailure(error));
    }
  } catch (error) {
    return serializeProfileResult(profileReadSetupFailure(error));
  }
}

export async function runSaveProfile(
  data: {
    before: ProfileValues;
    after: ProfileValues;
    idempotencyKey: string;
  },
  mediaFailure: SettingsContentFailureReader = () => undefined,
): Promise<ProfileSaveResult> {
  try {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../kernel/client');
    const { prepareSession, sessionSubject, viewerCredential } = await import('../session/request');
    try {
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      const accountId = sessionSubject(request);
      if (!authorization || !accountId)
        return serializeProfileResult({
          ok: false as const,
          status: 403,
          message: 'Sign in to change your profile.',
        });
      if (data.before.accountId !== accountId || data.after.accountId !== accountId)
        return serializeProfileResult({
          ok: false as const,
          status: 403,
          message: 'You can only change your own profile.',
        });
      const client = kernelClient();
      return serializeProfileResult(
        await withProfileDeadline(
          async (signal) => {
            // Preflight and PATCH share one absolute wait. Recovery keeps the original body and key.
            const current = await loadProfileRecord(client, authorization, accountId, undefined, signal);
            if (!profilePatchAdmitted(profileChanges(data.before, data.after), current.editing))
              return { ok: false as const, status: 403, message: '' };
            return saveProfileRecord(
              client,
              authorization,
              accountId,
              profileCommandValues(data.before),
              profileCommandValues(data.after),
              data.idempotencyKey,
              signal,
            );
          },
          request.signal,
          serverSettingsTimer(),
        ),
      );
    } catch (error) {
      profileControlFlow(error);
      const failure = profileReadFailure(error, mediaFailure);
      if (failure)
        return serializeProfileResult({
          ok: false as const,
          status: failure.status >= 500 ? failure.status : 503,
          message: '',
          ...(Object.keys(failure).length > 1 ? { failure } : {}),
        });
      return serializeProfileResult(profileSaveSetupFailure(error));
    }
  } catch (error) {
    return serializeProfileResult(profileSaveSetupFailure(error));
  }
}
