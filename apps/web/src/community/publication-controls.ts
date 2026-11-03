import type { KernelClient } from '@rezics/client';
import { publicationCommandHref } from './realm-publication-preparation';

export type PublicationChange = {
  realmId: string;
  subjectId: string;
  action: 'publish' | 'withdraw' | 'reject';
  expectedHead?: string;
  idempotencyKey: string;
  href?: string;
  ifMatch?: string | null;
};
export type PublicationOutcome =
  | { kind: 'saved'; head: string }
  | { kind: 'conflict'; currentHead: string | null }
  | { kind: 'denied' | 'unavailable' | 'invalid' };

/** The native command evaluates current realm:publish and subject readability before receipt replay.
 * Membership, resource management and Context editorial grants are never publication authority.
 */
export async function changePublication(
  client: KernelClient,
  authorization: string | null,
  input: PublicationChange,
): Promise<PublicationOutcome> {
  if (!authorization) return { kind: 'denied' };
  if (input.action !== 'publish' && !input.expectedHead) return { kind: 'invalid' };
  if ((input.href !== undefined && input.href !== publicationCommandHref(input.realmId, input.subjectId, input.action)) ||
      (input.ifMatch !== undefined && input.ifMatch !== (input.expectedHead ? JSON.stringify(input.expectedHead) : null)))
    return { kind: 'invalid' };
  const realm = client.realms({ realmId: input.realmId });
  const headers = {
    authorization,
    'idempotency-key': JSON.stringify(input.idempotencyKey),
  };
  try {
    const result =
      input.action === 'publish'
        ? await realm.publications.post(
            { subjectId: input.subjectId },
            {
              headers: {
                ...headers,
                ...(input.expectedHead ? { 'if-match': (input.ifMatch ?? JSON.stringify(input.expectedHead)) } : {}),
              },
            },
          )
        : input.action === 'withdraw'
          ? await realm.publications({ subjectId: input.subjectId }).$withdraw.post(undefined, {
              headers: { ...headers, 'if-match': (input.ifMatch ?? JSON.stringify(input.expectedHead)) },
            })
          : await realm.publications({ subjectId: input.subjectId }).$reject.post(undefined, {
              headers: { ...headers, 'if-match': (input.ifMatch ?? JSON.stringify(input.expectedHead)) },
            });
    if (!result.error && result.data && result.status < 400)
      return { kind: 'saved', head: result.data.publication.publicationId };
    if (result.status === 401 || result.status === 403 || result.status === 404) return { kind: 'denied' };
    if (result.status === 409 || result.status === 412) {
      return { kind: 'conflict', currentHead: null };
    }
    return { kind: result.status === 400 ? 'invalid' : 'unavailable' };
  } catch {
    // Keep the original request for retry: a lost reply may have followed a committed command.
    return { kind: 'unavailable' };
  }
}
