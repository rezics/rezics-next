import { randomUUID } from 'node:crypto';
import { startHomeStack, type HomeStack } from '../../../tests/qa/integration/feed-read-support.ts';
import { cloneOwners, requireQa } from '../../../tests/qa/integration/recommendation-support.ts';
import { projectDiscoveryBatch } from '../src/modules/discovery/source.ts';
import type { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { workRead } from '../src/modules/work/read-session.ts';

/** Independent policy/recovery, Content and relay owners share the shard's
 * immutable graph and objects. No preceding file's singleton or SQL projection
 * can become this probe's setup, and no recovery injection fences that file. */
export async function startQueryHome(label: string, retainedOwners = false) {
  const owners = retainedOwners
    ? undefined
    : await cloneOwners(requireQa(), ['access', 'content', 'relay']);
  if (owners)
    Object.assign(process.env, {
      ACCESS_DATABASE_URL: owners.urls.access,
      CONTENT_DATABASE_URL: owners.urls.content,
      ACCOUNT_RELAY_DATABASE_URL: owners.urls.relay,
    });
  try {
    const home = await startHomeStack(`${label}-${randomUUID()}`, { projectionStart: 'current' });
    const stop = home.stop;
    home.stop = async () => {
      try {
        await stop();
      } finally {
        await owners?.close();
      }
    };
    return home;
  } catch (error) {
    await owners?.close();
    throw error;
  }
}

/** Preparation enumerates this file's complete known population through the
 * real source projector. Register/activate and measured Query still use their
 * public APIs; foreign Works cannot pollute a negative/no-text cost oracle. */
export async function advanceQueryPopulation(
  home: HomeStack,
  projection: DiscoveryProjection,
  generation: { generation: string; checkpoint: string },
  works: readonly string[],
) {
  const context = {
    principal: { ...home.author.principal, emailVerified: true },
    actingSubject: home.author.actor,
  };
  const step = await projection.beginStep(context, generation.generation, generation.checkpoint);
  const prepared = await workRead(
    home.deps,
    new Request('http://main.internal/query-fixture'),
    {},
    async (session) => ({
      position: session.position,
      result: await projectDiscoveryBatch(
        session,
        { scope: 'global', realm: null, context: null },
        generation.checkpoint,
        { works: [...new Set(works)].sort() },
      ),
    }),
  );
  const row = await projection.commitBatch(
    context,
    generation.generation,
    step.lease,
    generation.checkpoint,
    prepared.result,
    prepared.position,
  );
  return { generation: row.generation_id, checkpoint: row.checkpoint, complete: row.complete };
}
