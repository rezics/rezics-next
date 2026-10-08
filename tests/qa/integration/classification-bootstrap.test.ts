import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { CommandRejected, FusekiClient, type CommandEnvelope } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { ensureGlobalClassificationContext, globalClassificationTerminal, GLOBAL_CLASSIFICATION_CONTEXT }
  from '../../../services/main/src/modules/classification/global.ts';
import { classificationContextDigest, createClassificationContext }
  from '../../../services/main/src/modules/classification/context.ts';
import { classificationPropositionDigest, createClassificationProposition }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { readZoneGenres } from '../../../services/main/src/modules/zone-modules/genres.ts';
import { READ_PREFIX, type WorkReadSession } from '../../../services/main/src/modules/work/read-session.ts';
import { DATASET, GRAPHS, ID, RV, iri, initializeFreshGraph, PendingActivation,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

test('G-380: fresh proposition bootstraps once, concurrent callers agree, relay reads it and reset reboots', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL!, Bun.env.FUSEKI_MAINTENANCE_TOKEN!, Bun.env.FUSEKI_COMMAND_TOKEN!);
  const directory = resolve('.temp', `classification-bootstrap-${Bun.randomUUIDv7()}`);
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: directory,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } };
  const actingSubject = ID + Bun.randomUUIDv7();
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => ({
    id: Bun.randomUUIDv7(), principalId: Bun.randomUUIDv7(), actingSubject, scope, action,
    idempotencyKey: Bun.randomUUIDv7(), requestDigest, authorityEpoch: '0', state: 'claimed',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), dispatchEligible: true, replayed: false,
  });
  const sequence = async () => (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?n WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }`)).results!.bindings[0]!.n!.value;
  const reset = async () => {
    await fuseki.resetDataset();
    env.lineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: Bun.randomUUIDv7() };
    await initializeFreshGraph(fuseki, env.lineage);
  };
  try {
    const start = await sequence();
    const input = { actingSubject, label: 'Minecraft' };
    const admitted = admission('classification:define:global', 'classification.proposition.define', classificationPropositionDigest(input));
    const proposition = await createClassificationProposition(env, admitted, input);
    expect(proposition.outcome).toBe('succeeded');
    expect(await sequence()).toBe((BigInt(start) + 2n).toString());
    expect((await createClassificationProposition(env, admitted, input)).definitions).toEqual(proposition.definitions);
    const terminal = globalClassificationTerminal(env.lineage.dataEpoch);
    const batch = await readNextMainOutboxBatch(fuseki, env.lineage.dataEpoch, start);
    expect(batch!.eventIds).toEqual([terminal.event]);
    const event = await readMainOutboxEnvelope(fuseki, batch!, terminal.event);
    expect(event.type).toBe('com.rezics.classification.global-bootstrapped.v1');
    const count = await sequence();
    await Promise.all(Array.from({ length: 8 }, () => ensureGlobalClassificationContext(env)));
    expect(await sequence()).toBe(count);
    const contextId = ID + Bun.randomUUIDv7(), realmId = ID + Bun.randomUUIDv7();
    const session = { options: {}, deps: { environment: env, discovery: {
      active: async () => ({ generation_id: Bun.randomUUIDv7(), source_epoch: env.lineage.dataEpoch,
        source_sequence: count, stale: false }), selectedTerms: async () => [],
    } }, position: { dataEpoch: env.lineage.dataEpoch, sequence: count },
      query: async (query: string) => (await fuseki.query(`${READ_PREFIX}\n${query}`)).results!.bindings,
      summaries: async (ids: string[]) => ids.map(id => ({ reference: id, status: 'available',
        type: 'concept', disclosure: 'public', name: { value: 'Minecraft', language: 'en' } })),
    } as unknown as WorkReadSession;
    const chips = await readZoneGenres(session, realmId, contextId,
      async () => ({ presentation: { modules: [{ type: 'chip-nav', source: { kind: 'context', context: contextId } }] } }) as never,
      async () => ({ state: 'active', disclosure: 'public', revision: contextId, entries: [
        { target: proposition.definitions!.concept, state: 'defined', relation: null, definition: proposition.revision },
      ] }) as never);
    expect(chips.items).toEqual([{ id: proposition.definitions!.sense, concept: proposition.definitions!.concept,
      name: { value: 'Minecraft', language: 'en' }, workCount: 0 }]);

    await reset();
    await Promise.all(Array.from({ length: 8 }, () => ensureGlobalClassificationContext(env)));
    expect(await sequence()).toBe('1');
    expect(globalClassificationTerminal(env.lineage.dataEpoch).receipt).not.toBe(terminal.receipt);
    const once = await readNextMainOutboxBatch(fuseki, env.lineage.dataEpoch, '0');
    await readMainOutboxEnvelope(fuseki, once!, once!.eventIds[0]!);

    await reset();
    const realmInput = { name: 'Mods bootstrap', actingSubject };
    const realm = await createRealmSpace(env, admission('space:create:root', 'space.create', spaceCreationDigest(realmInput)), realmInput);
    const contextInput = { realm: realm.realm!, actingSubject };
    const context = await createClassificationContext(env, admission(`classification:context:${realm.realm}`,
      'classification.context.configure', classificationContextDigest(contextInput)), contextInput);
    expect(context.outcome).toBe('succeeded');
    expect(await sequence()).toBe('3');

    await reset();
    await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ; rv:contextState rv:Inactive } }`);
    await expect(ensureGlobalClassificationContext(env)).rejects.toBeInstanceOf(PendingActivation);
    expect(await sequence()).toBe('0');

    await reset();
    const impostor = ID + Bun.randomUUIDv7();
    const other = new Proxy(fuseki, { get(target, property) {
      if (property === 'commandWithReceipt') return (command: CommandEnvelope) => target.commandWithReceipt({ ...command,
        update: command.update.replaceAll(GLOBAL_CLASSIFICATION_CONTEXT, impostor),
        validations: command.validations.map(validation => ({ ...validation,
          focus: validation.focus.map(focus => focus === GLOBAL_CLASSIFICATION_CONTEXT ? impostor : focus) })) });
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    // A different identity cannot borrow the fixed Global's exemption from Realm binding.
    await expect(ensureGlobalClassificationContext({ ...env, fuseki: other })).rejects.toBeInstanceOf(CommandRejected);
    expect(await sequence()).toBe('0');

    await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }`);
    await expect(ensureGlobalClassificationContext(env)).rejects.toBeInstanceOf(PendingActivation);
    expect(await sequence()).toBe('0');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 120_000);
