import { expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import {
  activateHostedPublicationCandidate,
  advanceHostedPublicationActivationAuthority,
  startHostedPublicationActivation,
} from '../../src/content/hosted-publication-activation.ts';
import type { HostedPublicationActivationDependencies } from '../../src/content/hosted-publication-activation.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);

const commandContext = () => ({
  idempotencyKey: crypto.randomUUID(),
  deadline: Date.now() + 120_000,
  requestId: crypto.randomUUID(),
});

function dependencies(f: Awaited<ReturnType<typeof hostedChaptersFixture>>) {
  return {
    pool: f.native.pool,
    access: f.native.system.access,
    tokens: f.native.system.tokenKeys,
    routeKey: f.native.system.routeKey,
    clock: () => new Date(),
  } satisfies HostedPublicationActivationDependencies;
}

test('authorized author prepares and activates a Book across account homes with exact readback and receipt replay', async () => {
  const f = await hostedChaptersFixture();
  try {
    const accountHome = partitionOf(routeOf(f.native.author.actor.accountId)!);
    const catalogue = await f.native.threadOutsidePartition(accountHome);
    const catalogueId = catalogue.firstPost.id;
    const path = `/v1/hostedCatalogues/${catalogueId}`;
    expect(partitionOf(routeOf(catalogueId)!)).not.toBe(accountHome);

    const sourceBody = fromPlainText('The exact selected chapter revision');
    const source = await f.native.thread('published', sourceBody);
    const target = f.target(source);
    const occurrenceId = f.newOccurrenceIdFor(catalogueId);
    const created = await f.native.command('/v1/hostedCatalogues', {
      postId: catalogueId,
      threadId: catalogue.id,
      placements: [{ occurrenceId, parentId: null, position: 0, title: 'Selected chapter', kind: 'chapter', target }],
    });

    const stageId = f.newOccurrenceIdFor(catalogueId);
    const stagePath = `${path}/publicationPreparations/${stageId}`;
    const prepared = await f.native.call('POST', `${path}:prepareRelease`, {
      stageId,
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      mode: 'whole',
    });
    expect(prepared.status).toBe(202);
    const advanced = await f.native.call('POST', `${stagePath}:advance`, {
      stepId: f.newOccurrenceIdFor(catalogueId),
    });
    expect(advanced.status).toBe(200);
    expect(advanced.value.candidate.coverageComplete).toBe(true);
    const sealed = await f.native.call('POST', `${stagePath}:seal`, {});
    expect(sealed.status).toBe(200);
    expect(sealed.value.candidateReady).toBe(true);

    const deps = dependencies(f);
    const actor = f.native.author.actor;
    let authority = await startHostedPublicationActivation(deps, actor, catalogueId, stageId, commandContext());
    while (authority.value.state === 'checking') {
      authority = await advanceHostedPublicationActivationAuthority(
        deps,
        actor,
        catalogueId,
        stageId,
        commandContext(),
      );
    }
    expect(authority.value.state).toBe('ready');

    const activationContext = commandContext();
    const activate = () => activateHostedPublicationCandidate(deps, actor, catalogueId, stageId, activationContext);
    const activated = await activate();
    expect(activated.value.state).toBe('activated');
    await f.native.command(
      `${path}:revise`,
      {
        expectedRevisionId: created.revisionId,
        placements: [
          { occurrenceId, parentId: null, position: 0, title: 'Later draft title', kind: 'chapter', target },
        ],
      },
      200,
    );
    const readback = await f.native.call(
      'GET',
      `${path}/occurrences/${occurrenceId}?kind=publication&revisionId=${activated.value.publicationId}`,
      undefined,
      { anonymous: true },
    );
    expect(readback.status).toBe(200);
    expect(readback.value.document).toEqual({
      encoding: 'base64',
      canonicalBytes: Buffer.from(serializeDocument(sourceBody), 'utf8').toString('base64'),
      sha256: target.sha256,
      authorId: actor.accountId,
      licence: 'MIT',
    });

    const replayed = await activate();
    expect(replayed.value).toEqual(activated.value);
  } finally {
    await f.close();
  }
});
