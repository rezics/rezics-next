import type { KernelClient } from '@rezics/client';

// The installed method owns both command advice and independent optional disclosure variants.
type RealmRoute = ReturnType<KernelClient['realms']>;
type PublicationRoute = ReturnType<RealmRoute['publications']>;
type PreparationRead = PublicationRoute['preparation']['get'];
export type RealmPublicationPreparation = NonNullable<Awaited<ReturnType<PreparationRead>>['data']>['preparation'];
export type PublicationCommand = RealmPublicationPreparation['commands']['publish'];
export type PublicationPresentation = RealmPublicationPreparation['subject']['presentation'];
export type PublicationPreparationResult =
  | { kind: 'ready'; preparation: RealmPublicationPreparation }
  | { kind: 'denied' }
  | { kind: 'unavailable'; seam?: 'generated-publication-preparation' };
export type PublicationPrepare = (input: {
  realmId: string;
  subjectId: string;
}) => Promise<PublicationPreparationResult>;

export const unavailablePublicationPreparation: PublicationPrepare = async () => ({
  kind: 'unavailable',
  seam: 'generated-publication-preparation',
});

/** One private, authenticated generated read; never placed in a shared query cache. */
export async function readPublicationPreparation(
  client: KernelClient,
  authorization: string | null,
  input: { realmId: string; subjectId: string },
  signal?: AbortSignal,
): Promise<PublicationPreparationResult> {
  if (!authorization) return { kind: 'denied' };
  if (signal?.aborted) return { kind: 'unavailable' };
  try {
    const result = await client
      .realms({ realmId: input.realmId })
      .publications({ subjectId: input.subjectId })
      .preparation.get({ headers: { authorization }, ...(signal ? { fetch: { signal } } : {}) });
    if (signal?.aborted) return { kind: 'unavailable' };
    if (result.error || !result.data) {
      return { kind: [401, 403, 404].includes(result.status) ? 'denied' : 'unavailable' };
    }
    const preparation = result.data.preparation;
    if (preparation.realm.realmId !== input.realmId || preparation.subject.originalId !== input.subjectId)
      return { kind: 'denied' };
    return { kind: 'ready', preparation };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function publicationCommandHref(realmId: string, subjectId: string, action: 'publish' | 'withdraw' | 'reject') {
  const base = `/v1/realms/${realmId}/publications`;
  return action === 'publish' ? base : `${base}/${subjectId}:${action}`;
}

/** Advice is only eligible for the existing command; that command reauthorizes at execution. */
export function admittedPublicationCommand(
  preparation: RealmPublicationPreparation,
  action: 'publish' | 'withdraw' | 'reject',
): PublicationCommand | null {
  const command = preparation.commands[action];
  const head = preparation.current?.publicationId ?? null;
  if (
    !command ||
    command.method !== 'POST' ||
    command.subjectId !== preparation.subject.originalId ||
    command.href !== publicationCommandHref(preparation.realm.realmId, preparation.subject.originalId, action) ||
    command.expectedHead !== head ||
    command.ifMatch !== (head === null ? null : JSON.stringify(head)) ||
    (action !== 'publish' && head === null)
  )
    return null;
  return command;
}
