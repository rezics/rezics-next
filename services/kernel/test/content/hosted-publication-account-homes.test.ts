import { expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import type { Pool } from 'pg';
import {
  activateHostedPublicationCandidate,
  advanceHostedPublicationActivationAuthority,
  startHostedPublicationActivation,
} from '../../src/content/hosted-publication-activation.ts';
import type { HostedPublicationActivationDependencies } from '../../src/content/hosted-publication-activation.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import type { ContentCredential } from './support/system.ts';

setDefaultTimeout(360_000);

const commandContext = () => ({
  idempotencyKey: crypto.randomUUID(),
  deadline: Date.now() + 120_000,
  requestId: crypto.randomUUID(),
});

async function nativeRequest<T, Context extends { deadline: number }>(
  access: Access,
  credential: ContentCredential,
  pool: Pool,
  context: Context,
  operation: (actor: AccountActor, context: Context) => Promise<T>,
): Promise<T> {
  const actor = await access.authenticate(credential.bearer, { pool, deadline: context.deadline });
  return operation(actor, context);
}

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
    const catalogue = await f.threadOutsidePartition(accountHome);
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
    // This one-chapter fixture still advances through separate retained build, receiving and lifecycle steps.
    const preparationStepLimit = 16;
    let preparationSteps = 0;
    let preparationProgress = prepared.value;
    while (!preparationProgress.candidate?.coverageComplete) {
      if (preparationSteps >= preparationStepLimit)
        throw new Error('One-chapter candidate preparation exceeded 16 bounded steps');
      const advanced = await f.native.call('POST', `${stagePath}:advance`, {
        stepId: f.newOccurrenceIdFor(catalogueId),
      });
      expect(advanced.status).toBe(200);
      preparationProgress = advanced.value;
      preparationSteps += 1;
    }
    expect(preparationProgress.candidate?.coverageComplete).toBe(true);
    const sealed = await f.native.call('POST', `${stagePath}:seal`, {});
    expect(sealed.status).toBe(200);
    expect(sealed.value.candidateReady).toBe(true);

    const deps = dependencies(f);
    const author = f.native.author;
    const startContext = commandContext();
    let authority = await nativeRequest(f.native.system.access, author, deps.pool, startContext, (actor, context) =>
      startHostedPublicationActivation(deps, actor, catalogueId, stageId, context),
    );
    while (authority.value.state === 'checking') {
      const advanceContext = commandContext();
      authority = await nativeRequest(f.native.system.access, author, deps.pool, advanceContext, (actor, context) =>
        advanceHostedPublicationActivationAuthority(deps, actor, catalogueId, stageId, context),
      );
    }
    expect(authority.value.state).toBe('ready');

    const activationContext = commandContext();
    const activate = () =>
      nativeRequest(f.native.system.access, author, deps.pool, activationContext, (actor, context) =>
        activateHostedPublicationCandidate(deps, actor, catalogueId, stageId, context),
      );
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
      authorId: author.actor.accountId,
      licence: 'MIT',
    });

    const replayed = await activate();
    expect(replayed.value).toEqual(activated.value);
  } finally {
    await f.close();
  }
});
