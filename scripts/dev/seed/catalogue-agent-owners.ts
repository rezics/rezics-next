import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Pool } from 'pg';
import { seedKey } from './plan.ts';
import type { SeedState, Session } from './state.ts';

interface Custodian {
  name: string; email: string; password: string; accountId?: string; agent?: string; principalId?: string;
}
interface Inventory { custodians: Custodian[]; assignments?: Record<string, number> }
const inventoryPath = resolve(import.meta.dir, '../../../.temp/seed/catalogue-custodians.json');
const sessions = new WeakMap<SeedState, Map<string, { token: string; cookie: string; issuedAt: number }>>();

/** Catalogue authors and publishers are maintained separately from the people
 * demonstrating Studio. Keep at most 32 catalogue identities per custodian,
 * below Main's complete 50-identity discovery contract. Existing creation
 * receipts retain their original issuer, key and Agent identity. */
export async function catalogueAgentToken(state: SeedState, pool: Pool, curator: Session, key: string): Promise<string> {
  if (!state.fixture.accessDatabaseUrl
    || !['127.0.0.1', 'localhost'].includes(new URL(state.fixture.accessDatabaseUrl).hostname)) {
    throw new Error('Catalogue custodians require the local fixture database');
  }
  const inventory: Inventory = existsSync(inventoryPath)
    ? JSON.parse(readFileSync(inventoryPath, 'utf8')) : { custodians: [] };
  const save = () => {
    mkdirSync(dirname(inventoryPath), { recursive: true });
    writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2), { mode: 0o600 });
  };
  const owners = [curator.accountId, ...inventory.custodians.flatMap(owner => owner.accountId ? [owner.accountId] : [])];
  const retained = await pool.query<{ account_subject: string }>(`SELECT p.account_subject
    FROM access.agent_provision a JOIN access.principal p ON p.id=a.principal_id
    WHERE a.idempotency_key=$1 AND p.account_subject=ANY($2::text[])`, [key, owners]);
  if (retained.rows.length > 1) throw new Error(`Catalogue Agent creation has multiple retained owners: ${key}`);
  if (retained.rows[0]?.account_subject === curator.accountId) return curator.token;

  let owner = inventory.custodians.find(item => item.accountId === retained.rows[0]?.account_subject);
  if (!owner && inventory.assignments?.[key] !== undefined) owner = inventory.custodians[inventory.assignments[key]!];
  if (!owner) {
    for (const candidate of inventory.custodians) {
      if (!candidate.principalId) { owner = candidate; break; }
      const count = await pool.query<{ count: number }>(`SELECT count(DISTINCT subject_id)::int AS count
        FROM access.representation WHERE principal_id=$1 AND action='agent.control'
          AND active AND valid_until>clock_timestamp()`, [candidate.principalId]);
      if (count.rows[0]!.count < 33) { owner = candidate; break; }
    }
  }
  if (!owner) {
    const number = inventory.custodians.length + 1;
    owner = { name: `Catalogue Custodian ${number}`, email: `rezics-catalogue-${number}@example.test`,
      password: `Rezics-catalogue-2026-${number}` };
    inventory.custodians.push(owner);
    save();
  }
  let signed = sessions.get(state);
  if (!signed) { signed = new Map(); sessions.set(state, signed); }
  let session = signed.get(owner.email);
  if (!session) {
    const account = await state.api.signInOrUp(owner);
    owner.accountId = account.id;
    session = { cookie: account.cookie, token: await state.api.token(account.cookie), issuedAt: Date.now() };
    signed.set(owner.email, session);
    const admitted = await pool.query<{ id: string }>('SELECT id FROM access.principal WHERE account_subject=$1 AND active', [account.id]);
    if (!owner.agent || !admitted.rows.length) {
      const made = await state.api.post<{ agent: string; state: string }>('/v1/agents', {
        profile: 'agent-provision-v1', kind: 'person', displayName: owner.name }, session.token,
        seedKey('catalogue-custodian', String(inventory.custodians.indexOf(owner) + 1)));
      if (made.state !== 'active') throw new Error('Catalogue custodian is not active');
      owner.agent = made.agent;
    }
    const principal = await pool.query<{ id: string }>('SELECT id FROM access.principal WHERE account_subject=$1 AND active', [account.id]);
    if (principal.rows.length !== 1) throw new Error('Catalogue custodian principal is ambiguous');
    owner.principalId = principal.rows[0]!.id;
  } else if (Date.now() - session.issuedAt > 120_000) {
    session.token = await state.api.token(session.cookie);
    session.issuedAt = Date.now();
  }
  inventory.assignments ??= {};
  inventory.assignments[key] = inventory.custodians.indexOf(owner);
  save();
  return session.token;
}
