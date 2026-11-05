import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { readNativeRealmMembers, type RealmMembersReadInput, type NativeRealmMembersRead } from './native';

/** Session/CSRF errors retain their existing boundary; an operand never supplies credentials. */
export async function readRealmMembersRequest(
  input: RealmMembersReadInput,
  request: Request,
  env: Partial<SessionEnv>,
  client: KernelClient,
): Promise<NativeRealmMembersRead> {
  await prepareSession(request, env);
  const authorization = viewerCredential(request);
  if (!authorization || sessionSubject(request) !== input.viewerId) return { kind: 'denied' };
  return readNativeRealmMembers(client, input, authorization);
}
