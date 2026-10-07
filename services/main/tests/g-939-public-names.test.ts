import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { readResourceVisibility } from '../src/modules/space/visibility.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import {
  configureNamePreferences,
  reconcileNamePreferences,
  publishNamePolicies,
} from '../src/modules/search/name-preferences.ts';
import { backfillPublicNameProjections } from '../src/modules/search/backfill.ts';
import { publicResources } from '../src/modules/query/resources.ts';
import { RV } from '../src/modules/work/activate.ts';
import visibilityCases from '../../../infra/jena/command-module/src/test/resources/g939-visibility.json';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = (value: string) => ({ type: 'literal', value });
test('G939: native public-name policy shares the live Space disclosure/listing truth table', async () => {
  for (const row of visibilityCases) {
    const env = {
      lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
      fuseki: {
        query: async (query: string) =>
          query.includes('ASK')
            ? { boolean: true }
            : {
                results: {
                  bindings: [
                    {
                      kind: binding('space'),
                      space: binding(id(1)),
                      disclosure: binding(
                        RV + (row.visibility === 'public' ? 'Public' : 'Private'),
                      ),
                      listing: binding(row.listing),
                    },
                  ],
                },
              },
      },
    } as unknown as WorkActivationEnvironment;
    expect((await readResourceVisibility(env, id(1)))?.discovery.indexable).toBe(row.indexable);
  }
  expect(publicResources()).toContain('rv:listing');
  expect(publicResources()).toContain('rv:nameListing "unlisted"');
  expect(publicResources()).not.toContain('rv:visibility');
});

function fixture(inventory = 129) {
  const checkpoints = new Map<string, { after_resource: string; complete: boolean }>();
  const commands: { receipt: string; update: string }[] = [];
  const receipts = new Set<string>();
  let failCheckpoint = false;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT after_resource'))
        return {
          rows: checkpoints.has(String(params[1])) ? [checkpoints.get(String(params[1]))] : [],
        };
      if (sql.startsWith('INSERT INTO access.public_name_backfill_checkpoint')) {
        if (failCheckpoint) {
          failCheckpoint = false;
          throw new Error('Lost checkpoint');
        }
        checkpoints.set(String(params[1]), {
          after_resource: String(params[2]),
          complete: Boolean(params[3]),
        });
        return { rows: [] };
      }
      if (sql.includes('access.authority_subject'))
        return {
          rows: Array.from({ length: inventory }, (_, i) => ({
            agent: id(i + 1),
            visibility: i % 2 ? 'private' : 'public',
            version: 1,
            listing: i % 3 ? 'listed' : 'unlisted',
            listing_version: 2,
          }))
            .filter((row) => row.agent > String(params[0]))
            .slice(0, 64),
        };
      throw new Error('Unexpected Access query');
    },
  } as unknown as Pool;
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: {
      commandWithReceipt: async (command: { receipt: string; update: string }) => {
        commands.push(command);
        receipts.add(command.receipt);
        return { status: 'committed' };
      },
      query: async () => ({ results: { bindings: [] } }),
    },
  } as unknown as WorkActivationEnvironment;
  return {
    pool,
    env,
    checkpoints,
    commands,
    receipts,
    loseCheckpoint: () => {
      failCheckpoint = true;
    },
  };
}
test('G939: startup writes one batch; resume and lost checkpoint replay the same native receipt', async () => {
  const f = fixture();
  await configureNamePreferences(f.env, f.pool);
  expect(f.commands).toHaveLength(1);
  expect(
    f.commands[0]!.update.match(/nameResource ([^\n]+)/)?.[1].match(/https:\/\/rezics.com\/id\//g),
  ).toHaveLength(64);
  expect(f.checkpoints.get('agent-name-policy-v2')?.complete).toBe(false);
  f.loseCheckpoint();
  await expect(reconcileNamePreferences(f.env, f.pool)).rejects.toThrow('Lost checkpoint');
  const receipt = f.commands.at(-1)!.receipt;
  expect((await reconcileNamePreferences(f.env, f.pool)).processed).toBe(64);
  expect(f.commands.at(-1)!.receipt).toBe(receipt);
  expect(f.receipts.size).toBe(2);
  expect((await backfillPublicNameProjections(f.env, f.pool, 2)).complete).toBe(true);
  expect(f.checkpoints.get('agent-name-policy-v2')?.complete).toBe(true);
  expect(f.checkpoints.get('public-names-v4')?.complete).toBe(true);
});
test('G939: startup failures are nonfatal, partial batches remain resumable and population size is not a request limit', async () => {
  const f = fixture(50_001);
  f.checkpoints.set('agent-name-policy-v2', { after_resource: id(50_000), complete: false });
  expect(await reconcileNamePreferences(f.env, f.pool)).toMatchObject({
    processed: 1,
    complete: true,
  });
  const broken = {
    ...f.env,
    fuseki: {
      ...f.env.fuseki,
      commandWithReceipt: async () => {
        throw new Error('Writer restarting');
      },
    },
  } as unknown as WorkActivationEnvironment;
  f.checkpoints.clear();
  expect(await configureNamePreferences(broken, f.pool)).toBeUndefined();
  expect(f.checkpoints.size).toBe(0);
  await expect(backfillPublicNameProjections(broken, f.pool, 1)).rejects.toThrow(
    'Writer restarting',
  );
  await expect(
    publishNamePolicies(
      f.env,
      Array.from({ length: 65 }, (_, i) => ({ agent: id(i) })),
    ),
  ).rejects.toThrow('64');
  expect((await backfillPublicNameProjections(f.env, f.pool, 1)).complete).toBe(false);
  expect(f.commands.at(-1)!.update).toContain('rv:listingVersion');
});
