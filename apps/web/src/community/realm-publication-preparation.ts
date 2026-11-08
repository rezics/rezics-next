import type { KernelClient } from '@rezics/client';

// The installed method owns both command advice and independent optional disclosure variants.
type RealmRoute = ReturnType<KernelClient['realms']>;
type PublicationRoute = ReturnType<RealmRoute['publications']>;
type PreparationRead = PublicationRoute['preparation']['get'];
export type RealmPublicationPreparation = NonNullable<Awaited<ReturnType<PreparationRead>>['data']>['preparation'];
export type PublicationCommand = RealmPublicationPreparation['commands']['publish'];
export type PublicationPresentation = RealmPublicationPreparation['subject']['presentation']['original'];
export type PublicationPreparationResult =
  | { kind: 'ready'; preparation: RealmPublicationPreparation }
  | { kind: 'denied' }
  | { kind: 'unavailable'; seam?: 'generated-publication-preparation' };
export const PUBLICATION_PREPARATION_MAX_UTF8_BYTES = 128 * 1024;
export type PublicationPrepare = (input: {
  realmId: string;
  subjectId: string;
}) => Promise<PublicationPreparationResult>;

export const unavailablePublicationPreparation: PublicationPrepare = async () => ({
  kind: 'unavailable',
  seam: 'generated-publication-preparation',
});

function jsonStringBytes(value: string, remaining: number): number | null {
  let bytes = 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes++;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > remaining) return null;
  }
  return bytes <= remaining ? bytes : null;
}

/** Check the response incrementally so an oversized sibling is never retained. */
function boundedJsonBytes(value: unknown, limit: number): number | null {
  let bytes = 0;
  const add = (amount: number) => {
    bytes += amount;
    return bytes <= limit;
  };
  const visit = (current: unknown): boolean => {
    if (current === null) return add(4);
    if (typeof current === 'string') {
      const length = jsonStringBytes(current, limit - bytes);
      return length !== null && add(length);
    }
    if (typeof current === 'number' || typeof current === 'boolean') {
      const text = JSON.stringify(current);
      return text !== undefined && add(text.length);
    }
    if (Array.isArray(current)) {
      if (!add(2)) return false;
      for (let index = 0; index < current.length; index++) {
        if ((index > 0 && !add(1)) || !visit(current[index])) return false;
      }
      return true;
    }
    if (typeof current === 'object') {
      const entries = Object.entries(current);
      if (!add(2)) return false;
      let first = true;
      for (const [key, entry] of entries) {
        if (entry === undefined) continue;
        const keyBytes = jsonStringBytes(key, limit - bytes);
        if ((!first && !add(1)) || keyBytes === null || !add(keyBytes) || !add(1) || !visit(entry)) return false;
        first = false;
      }
      return true;
    }
    return add(4);
  };
  return visit(value) ? bytes : null;
}

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
    if (boundedJsonBytes({ preparation }, PUBLICATION_PREPARATION_MAX_UTF8_BYTES) === null)
      return { kind: 'unavailable' };
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
