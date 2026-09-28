import { Pool } from 'pg';
import { SeedApiError } from './api.ts';
import { publicWork } from './community-step.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { seedKey } from './plan.ts';
import { coReaderWorks } from './reading-lives-plan.ts';
import type { SeedState } from './state.ts';

// "Readers also enjoyed" reads an active co-reader generation, which Main
// builds only on request and retires as soon as a shelf, rating or library
// visibility changes. So this is the seed's last write: when the three planned
// Works already show co-readers nothing happens; otherwise the first person
// builds, advances and activates a new generation through Main.

const short = (id: string) => id.slice(-36);

/** Which planned Works lack co-readers now; an empty list means the active generation serves them. */
export async function missingCoReaders(state: SeedState): Promise<string[]> {
  const missing: string[] = [];
  for (const id of coReaderWorks) {
    const work = publicWork(state, id)?.work.work ?? state.created.get(id)?.work;
    if (!work) { missing.push(id); continue; }
    const page = await state.api.getPublic<{ items: { basis: string }[] }>(`/v1/works/${short(work)}/also-enjoyed?limit=6`);
    if (!page.items.some(item => item.basis === 'co-readers')) missing.push(id);
  }
  return missing;
}

/**
 * The active generation's head revision, which activation compares. Main
 * answers a stale head with a bare 409 and has no read for it yet, so the
 * local fixture reads the one number from Access, as operator.ts reads grants.
 */
async function headRevision(accessDatabaseUrl: string): Promise<string | null> {
  const url = new URL(accessDatabaseUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port) {
    throw new Error('Co-reader activation reads a loopback database only');
  }
  const pool = new Pool({ connectionString: accessDatabaseUrl });
  try {
    return (await pool.query<{ revision: string }>(`SELECT revision::text FROM access.derived_generation_head
      WHERE family = 'also-enjoyed'`)).rows[0]?.revision ?? null;
  } finally { await pool.end(); }
}

async function build(state: SeedState, attempt: number) {
  const manager = state.sessions[0]!, body = { actingSubject: manager.actingSubject };
  const stamp = `${new Date().toISOString()}:${attempt}`;
  const { generation } = await state.api.post<{ generation: string }>('/v1/also-enjoyed/generation-builds', body,
    manager.token, seedKey('also-enjoyed-build', stamp));
  let view = { phase: 'ratings', signalCount: 0, pairCount: 0 };
  for (let step = 0; view.phase !== 'complete'; step++) {
    if (step >= 400) throw new Error('Co-reader generation did not complete within 400 steps');
    view = await state.api.post(`/v1/also-enjoyed/generations/${generation}/advance`, body, manager.token,
      seedKey('also-enjoyed-advance', `${generation}:${step}`));
  }
  await state.api.post('/v1/also-enjoyed/generation-activations', { ...body, generation,
    expectedHeadRevision: await headRevision(state.fixture.accessDatabaseUrl!) }, manager.token,
  seedKey('also-enjoyed-activation', generation));
  return view;
}

export async function seedCoReaders(state: SeedState) {
  const operator = state.operatorInput;
  if (!operator) return;
  await state.optional('Readers also enjoyed', async () => {
    const before = await missingCoReaders(state);
    if (!before.length) {
      console.log('Readers also enjoyed: the active co-reader generation is current.');
      return;
    }
    await grantHomeSeedAuthority(operator, [{ action: 'recommendation.generation.manage',
      scope: 'recommendation:manage' }]);
    // Another writer on the shared stack can move a source during the build; Main then asks for a restart.
    for (let attempt = 0; ; attempt++) {
      try {
        const view = await build(state, attempt);
        const after = await missingCoReaders(state);
        if (after.length) throw new Error(`No co-readers for ${after.join(', ')} after a complete generation`);
        console.log(`Readers also enjoyed: ${view.signalCount} signals, ${view.pairCount} pairs.`);
        return;
      } catch (error) {
        if (attempt >= 2 || !(error instanceof SeedApiError) || error.status !== 409) throw error;
      }
    }
  });
}
