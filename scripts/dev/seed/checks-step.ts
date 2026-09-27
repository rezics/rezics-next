import type { SeedState } from './state.ts';

export async function checkPublicReads(state: SeedState) {
  const { endpoints, findings } = state;
  const search = await state.optional('Public search', () => fetch(`${endpoints.main}/v1/queries`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      profile: 'public-main-phrase-v1', phrase: 'Pride and Prejudice', language: null }) }));
  if (search && !search.ok) findings.add(`Public search: HTTP ${search.status} ${
    (await search.json() as { code?: string }).code ?? 'unknown'}`);
  const recent = await state.optional('Public Work list', () => fetch(`${endpoints.main}/v1/works?limit=5`));
  if (recent && !recent.ok) {
    const body = await recent.json() as { code?: string; title?: string };
    findings.add(`Public Work list: GET /v1/works?limit=5 HTTP ${recent.status} ${body.code ?? ''}: ${body.title ?? ''}`);
  } else if (recent && (await recent.json() as { items?: unknown[] }).items?.length === 0) {
    findings.add('Public Work list: zero visible Works; metadata-only records need a selected publication');
  }
}
