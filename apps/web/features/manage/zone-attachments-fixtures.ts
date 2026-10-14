import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { direction } from '@rezics/main/language';
import type { AnswerPersona } from '../../../../scripts/api/answer-record.ts';
import type { ZoneAttachmentsRead } from './zone-attachments-page.tsx';
import { iriOf } from './types.ts';

// Contract-derived, unrecorded states: the two Zone outcome tests do not yet retain answers.
// Synthetic localized Zone names are original fixture text. Identity is bound to the selected persona's client.
export const attachmentRealm = '00000000-0000-4000-8000-000000000101';
export const attachmentActor = iriOf('00000000-0000-4000-8000-000000000102');
export const attachmentZones = Array.from({ length: 51 }, (_, index) => iriOf(`00000000-0000-4000-8000-${String(index + 201).padStart(12, '0')}`));
export type AttachmentState = 'populated' | 'empty' | 'loading' | 'error' | 'pending' | 'refused' | 'revoked' | 'moved';
type Page = Extract<ZoneAttachmentsRead, { ok: true }>['data'];
export const attachmentRequests = {
  first: `/v1/realms/${attachmentRealm}/zone-attachments?actingSubject=${encodeURIComponent(attachmentActor)}&limit=24`,
  second: `/v1/realms/${attachmentRealm}/zone-attachments?actingSubject=${encodeURIComponent(attachmentActor)}&limit=24&cursor=24`,
  last: `/v1/realms/${attachmentRealm}/zone-attachments?actingSubject=${encodeURIComponent(attachmentActor)}&limit=24&cursor=48`,
  withdraw: `/v1/zones/${attachmentZones[0]!.slice(-36)}/realm-attachment-withdrawals`,
  body: { realm: iriOf(attachmentRealm), actingSubject: attachmentActor },
} as const;

export function attachmentPage(offset = 0, empty = false): Page {
  const items = empty ? [] : attachmentZones.slice(offset, offset + 24).map((zone, index) => {
    const name = `Reading room ${offset + index + 1}`;
    const language = 'en';
    return { zone, name, language, direction: direction(language, name),
    address: { prefix: '~', key: zone.slice(-36), suffixSource: 'id' }, attachedAt: '2026-10-01T12:00:00.000Z',
    withdraw: { method: 'POST' as const, path: `/v1/zones/${zone.slice(-36)}/realm-attachment-withdrawals` },
    };
  });
  const nextCursor = !empty && offset + 24 < attachmentZones.length ? String(offset + 24) : null;
  return { realm: iriOf(attachmentRealm), items, nextCursor, complete: nextCursor === null,
    cost: { graphReads: 1, sqlReads: 1, rows: items.length } };
}

export function attachmentFixture(state: AttachmentState, persona: AnswerPersona = 'owner', delegated = false) {
  const requests: { path: string; method: string; body: unknown; key: string | null }[] = [];
  let refusedCursor = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(BFF_PREFIX, '');
    const raw = await request.clone().text();
    requests.push({ path: path + url.search, method: request.method, body: raw ? JSON.parse(raw) : undefined,
      key: request.headers.get('idempotency-key') });
    if (state === 'loading') return new Promise<Response>(() => {});
    if (request.method === 'GET') {
      if (state === 'moved' && url.searchParams.has('cursor') && !refusedCursor) {
        refusedCursor = true;
        return Response.json({ type: 'https://rezics.com/problems/stale_zone_attachment_cursor', status: 409,
          code: 'stale_zone_attachment_cursor', title: 'Attachment inventory changed' }, { status: 409 });
      }
      if (state === 'revoked' && url.searchParams.has('cursor') || persona !== 'owner' && !delegated) {
        return Response.json({ type: 'https://rezics.com/problems/realm_unavailable', status: 404, code: 'realm_unavailable', title: 'Realm is unavailable' }, { status: 404 });
      }
      if (state === 'error') return Response.json({ type: 'https://rezics.com/problems/realm_unavailable', status: 503, code: 'realm_unavailable', title: 'Realm is unavailable' }, { status: 503 });
      return Response.json(attachmentPage(Number(url.searchParams.get('cursor') ?? 0), state === 'empty'));
    }
    if (state === 'pending') return Response.json({ operationId: 'attachment-withdrawal', status: 'reconciling',
      phase: 'realm-attachment-withdrawal', result: null, retry: { allowed: true, afterMs: 1000 } }, { status: 202 });
    if (state === 'refused') return Response.json({ type: 'https://rezics.com/problems/realm_attachment_denied',
      status: 403, code: 'realm_attachment_denied', title: 'Realm stewardship has ended' }, { status: 403 });
    return Response.json({ zone: iriOf(path.split('/')[3]!), realm: iriOf(attachmentRealm), receipt: 'attachment-withdrawn',
      replayed: false, sourcePosition: { datasetId: 'product', dataEpoch: 'contract-fixture', sequence: '2' } });
  }) as typeof fetch;
  return { requests, client: () => browserMainApi('https://contract.invalid', { fetcher }) };
}
