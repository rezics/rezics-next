import { mkdir, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { grantSeedAuthority } from './franchises-step.ts';
import { loadScopedSubjects, type ScopedSubjectRater } from './scoped-subjects.ts';
import type { ScopedSubjectApi } from './scoped-subjects-questions.ts';
import { refreshSeedTokens, type SeedState, type Session } from './state.ts';

/** Small scoped-subject demo through public APIs; existing local fixture
 * machinery supplies permissions, never semantic records or rating values. */
export async function seedScopedSubjects(state: SeedState,
  load: typeof loadScopedSubjects = loadScopedSubjects): Promise<void> {
  const owner = state.sessions[0];
  if (!owner || !state.operatorInput) throw new Error('Scoped subjects need the local fixture operator');
  const started = Date.now();
  const transport = (session: Session): ScopedSubjectApi => ({
    get: path => state.api.get(path, session.token),
    post: (path, body, key) => state.api.post(path, body, session.token, key),
    put: (path, body, key) => state.api.put(path, body, session.token, key),
  });
  // Later steps read state.sessions as the plan's people. The extra principals this ranking signs in
  // stay on this list; the plan's own people are its first raters and remain where they are.
  const raters: Session[] = state.sessions.slice(0, 50);
  while (raters.length < 50) {
    const index = raters.length;
    const id = `scoped-rater-${index + 1}`;
    const signed = await state.api.signInOrUp({ email: `${id}@demo.rezics.local`,
      password: 'Rezics-demo-scoped-2026!', name: `Map reader ${index + 1}` });
    const token = await state.api.token(signed.cookie);
    const agent = await state.api.post<{ agent: string }>('/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: `Map reader ${index + 1}`,
    }, token, `demo-scoped:agent:${index}`);
    raters.push({ id, accountId: signed.id, cookie: signed.cookie, token,
      issuedAt: Date.now(), actingSubject: agent.agent });
    if (Date.now() - started > 600_000) throw new Error('Scoped-subject preparation exceeded 600 seconds');
  }
  await refreshSeedTokens(state, raters);
  const principals: ScopedSubjectRater[] = raters.map(session => ({ actor: session.actingSubject, api: transport(session) }));
  const pool = new Pool({ connectionString: state.operatorInput.accessDatabaseUrl });
  const authority = new Set<string>();
  try {
    const manifest = await load({ api: transport(owner), actor: owner.actingSubject,
      namespace: 'demo-scoped', raters: principals,
      authorize: async (scope, action, actor = owner.actingSubject) => {
        const tuple = `${actor}\0${scope}\0${action}`;
        if (authority.has(tuple)) return;
        await grantSeedAuthority(pool, { ...state.operatorInput!, ownerAccountSubject: owner.accountId,
          actingSubject: actor }, scope, action);
        authority.add(tuple);
      },
    });
    await mkdir('.temp/seed', { recursive: true });
    await writeFile('.temp/seed/scoped-subjects.json', `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Scoped subjects: ${Object.keys(manifest.subjects).length} resources, ${Object.keys(manifest.projections).length} projections; index .temp/seed/scoped-subjects.json.`);
  } finally { await pool.end(); }
}
