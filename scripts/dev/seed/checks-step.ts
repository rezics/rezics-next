import type { SeedState } from './state.ts';
import { works } from './plan.ts';

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
  for (const [id, receipt] of state.created) {
    await state.optional(`Work author check ${id}`, async () => {
      const author = works.find(work => work.id === id)?.author;
      const reader = author === 'moonlight' && state.penAgents.get('moonlight')
        ? { ...state.sessions[0]!, actingSubject: state.penAgents.get('moonlight')! }
        : state.sessions.find(session => session.id === author) ?? state.sessions[0]!;
      const path = `/v1/works/${receipt.work.slice(-36)}`;
      const read = (session: typeof reader) => {
        const query = `?actingSubject=${encodeURIComponent(session.actingSubject)}`;
        return Promise.all([
          state.api.get<{ items: { role: string }[] }>(`${path}/agent-credits${query}`, session.token),
          state.api.get<{ items: { role: string }[] }>(`${path}/credits${query}`, session.token),
        ]);
      };
      const [agents, sources] = await read(reader).catch(error => {
        if (reader === state.sessions[0]) throw error;
        return read(state.sessions[0]!);
      });
      if (![...agents.items, ...sources.items].some(credit => credit.role === 'author')) {
        findings.add(`Work ${id} has no credited author`);
      }
    });
  }
}
