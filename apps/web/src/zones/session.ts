import { SESSION_HEADER } from '@rezics/client';
import type { ReadCredentialMode } from '../kernel/credential';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

export type ZoneSessionBinding = {
  authorization?: string;
  kernelSession?: string;
};

/** One current BFF session: anonymous SSR stays credential-free; a signed-in reread uses the personal driver. */
export async function bindZoneSession(
  request: Request,
  env: Partial<SessionEnv>,
  credentialMode: ReadCredentialMode | undefined,
): Promise<ZoneSessionBinding> {
  if (credentialMode !== 'session') return {};
  await prepareSession(request, env);
  const authorization = viewerCredential(request) ?? undefined;
  const kernelSession = request.headers.get(SESSION_HEADER) ?? undefined;
  return {
    ...(authorization === undefined ? {} : { authorization }),
    ...(kernelSession === undefined ? {} : { kernelSession }),
  };
}

export type ZoneKernelCall = {
  headers?: { authorization?: string; [SESSION_HEADER]?: string };
};

export function zoneKernelHeaders(binding: ZoneSessionBinding, kernelSession?: string): ZoneKernelCall['headers'] {
  const session = kernelSession ?? binding.kernelSession;
  if (!binding.authorization && !session) return;
  return {
    ...(binding.authorization ? { authorization: binding.authorization } : {}),
    ...(session ? { [SESSION_HEADER]: session } : {}),
  };
}

export function nextKernelSession(response: Response, previous?: string): string | undefined {
  return response.headers.get(SESSION_HEADER) ?? previous;
}

/**
 * Media download, upload intent and completion stay on the existing personal `/media` driver. Each
 * later BFF request calls `prepareSession` again, so revocation and suspension take effect immediately.
 */
export function zoneMediaCredential(request: Request): string | null {
  return viewerCredential(request);
}

export function zoneSessionRevoked(
  binding: ZoneSessionBinding,
  credentialMode: ReadCredentialMode | undefined,
): boolean {
  return credentialMode === 'session' && binding.authorization === undefined;
}
