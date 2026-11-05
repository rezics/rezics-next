import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';

export type SelectedSpace = {
  spaceId: string;
  title: string;
  summary: string;
  address: string | null;
  realmId: string | null;
};
export type SpaceReading = { state: 'ready'; space: SelectedSpace } | { state: 'denied' | 'unavailable' | 'retired' };
export type SpaceReadInput = { spaceId: string; subject: string; locale: string };
export type SpaceRead = SpaceReadInput & { result: SpaceReading };

/** One explicit point read. Native resource admission remains the authority. */
export async function readSelectedSpace(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: SpaceReadInput,
  admit: (authorization: string) => Promise<boolean> = async () => true,
): Promise<SpaceRead> {
  const unavailable = (): SpaceRead => ({ ...input, result: { state: 'unavailable' } });
  if (await prepareSession(request, env)) return unavailable();
  const subject = sessionSubject(request);
  const authorization = viewerCredential(request);
  if (!subject || subject !== input.subject || !authorization) return unavailable();
  const envelope = { ...input, subject };
  try {
    if (!(await admit(authorization))) return { ...envelope, result: { state: 'denied' } };
    const response = await client.spaces({ spaceId: input.spaceId }).get({
      headers: { authorization, 'accept-language': input.locale },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    if (response.status === 401 || response.status === 403) return { ...envelope, result: { state: 'denied' } };
    if (response.status === 404 || response.status === 410) return { ...envelope, result: { state: 'retired' } };
    if (response.error || !response.data) return unavailable();
    const space = response.data.space;
    if (space.spaceId !== input.spaceId) return unavailable();
    if (space.state !== 'active') return { ...envelope, result: { state: 'retired' } };
    return {
      ...envelope,
      result: {
        state: 'ready',
        space: {
          spaceId: space.spaceId,
          title: space.title,
          summary: space.summary,
          address: space.address,
          realmId: space.realmId,
        },
      },
    };
  } catch {
    return unavailable();
  }
}
