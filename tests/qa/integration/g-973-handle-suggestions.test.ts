import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { normalizeAddressName } from '@rezics/model/address/names';
import {
  AgentVanityHandles,
  VANITY_SUGGESTION_COST,
} from '../../../services/main/src/modules/agent/vanity.ts';
import { NameRegistry } from '../../../services/main/src/modules/address/registry.ts';

test('G-973: readable handle variants respect reserved, retained and cross-Space confusable names within a bounded budget', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const base = `reader_${randomUUID().slice(0, 8)}`;
  const keys = Array.from({ length: VANITY_SUGGESTION_COST.sequentialCandidates }, (_, index) =>
    index ? `${base}${index + 1}` : base,
  );
  let availabilityQueries = 0;
  const probePool = new Proxy(pool, {
    get(target, property) {
      if (property === 'connect')
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, method) {
              if (method === 'query')
                return (...args: unknown[]) => {
                  if (String(args[0]).includes('AS wanted(key text')) availabilityQueries++;
                  return Reflect.apply(connection.query, connection, args);
                };
              const value = Reflect.get(connection, method);
              return typeof value === 'function' ? value.bind(connection) : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const handles = new AgentVanityHandles(probePool),
    registry = new NameRegistry(pool);
  const occupy = async (key: string, scope = 'agent', state = 'current', spelling = key) => {
    const name = normalizeAddressName(spelling, 'ascii-handle');
    const holder = `https://rezics.com/id/${randomUUID()}`;
    await pool.query(
      `INSERT INTO access.name_registry(scope,key,display,skeleton,holder,controller,state)
      VALUES ($1,$2,$3,$4,$5,$5,$6)`,
      [scope, name.key, spelling, name.skeleton, holder, state],
    );
  };
  try {
    expect(await handles.suggest(base)).toBe(base);
    expect(availabilityQueries).toBe(1);
    await occupy(base);
    expect(await handles.suggest(base)).toBe(`${base}2`);
    await occupy(`${base}2`, 'agent', 'redirect');
    await occupy(`${base}3`, 'agent', 'retired');
    await pool.query('INSERT INTO access.name_reserved_word(word) VALUES ($1)', [`${base}4`]);
    // Digit zero and lowercase o share a skeleton across Agent/Space handles.
    const confusable = `${base}5`.replace('reader', 'reader0');
    const confusableBase = base.replace('reader', 'readero');
    await occupy(confusable, 'space');
    expect((await registry.availability('agent', `${confusableBase}5`)).reason).toBe('confusable');
    expect(await registry.firstAvailable('agent', [`${confusableBase}5`, `${base}6`])).toBe(
      `${base}6`,
    );
    expect(await handles.suggest(base)).toBe(`${base}5`);
    expect((await registry.availability('agent', await handles.suggest(base))).available).toBe(
      true,
    );
    // Fill the first batch and prove the next batch preserves the readable base.
    for (const key of keys.slice(4, 64)) await occupy(key);
    availabilityQueries = 0;
    expect(await handles.suggest(base)).toBe(`${base}65`);
    expect(availabilityQueries).toBe(2);
    for (const key of keys.slice(64)) await occupy(key);
    availabilityQueries = 0;
    const crowded = await handles.suggest(base);
    expect(crowded).toMatch(new RegExp(`^${base}[0-9]+$`));
    expect(Number(crowded.slice(base.length))).toBeGreaterThan(
      VANITY_SUGGESTION_COST.sequentialCandidates,
    );
    expect(availabilityQueries).toBe(VANITY_SUGGESTION_COST.availabilityQueries);
    expect((await registry.availability('agent', crowded)).available).toBe(true);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM access.name_registry WHERE key = $1', [
          `${base}257`,
        ])
      ).rows[0]?.n,
    ).toBe(0);
  } finally {
    // Name ownership is permanent. The disposable QA project removes these
    // randomly scoped fixtures; cleanup must not bypass the registry's guard.
    await pool.end();
  }
});
