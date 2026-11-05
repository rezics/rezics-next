import {
  type DevelopmentCommunityOutcome,
  type DevelopmentSeedActor,
  type DevelopmentSeedFailure,
  type DevelopmentShowcaseClient,
} from './showcase-community.ts';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sourceFromResponse(value: unknown, expected: {
  accountId: string;
  postId: string;
  revisionId: string;
  subjectId: string;
  sha256: string;
}) {
  const envelope = record(value);
  const post = record(envelope?.post);
  const identity = record(envelope?.editionIdentity);
  const subjects = identity?.subjects;
  if (
    !post ||
    !identity ||
    post.id !== expected.postId ||
    post.revisionId !== expected.revisionId ||
    post.authorId !== expected.accountId ||
    post.availability !== 'available' ||
    post.licence !== 'CC-BY-4.0' ||
    typeof post.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(post.sha256) ||
    post.sha256 !== expected.sha256 ||
    !Array.isArray(post.subjectIds) ||
    post.subjectIds.length !== 1 ||
    post.subjectIds[0] !== expected.subjectId ||
    identity.postId !== expected.postId ||
    identity.revisionId !== expected.revisionId ||
    identity.sha256 !== post.sha256 ||
    !Array.isArray(subjects) ||
    !subjects.some((subject) => {
      const item = record(subject);
      return item?.id === expected.subjectId && item.kind === 'available';
    })
  )
    throw new TypeError('Native source read did not confirm the exact authored post, revision, subject, digest and licence');
  return {
    postId: expected.postId,
    revisionId: expected.revisionId,
    targetSubjectId: expected.subjectId,
    sha256: post.sha256,
    licence: post.licence,
  };
}

function editionCommand(value: unknown): { editionId: string; editionRevision: string } {
  const response = record(value);
  if (
    !response ||
    typeof response.editionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(response.editionId) ||
    typeof response.editionRevision !== 'string' ||
    !/^[1-9][0-9]*$/u.test(response.editionRevision)
  )
    throw new TypeError('Native edition command response is invalid');
  return { editionId: response.editionId, editionRevision: response.editionRevision };
}

function publishedEdition(value: unknown, expected: {
  editionId: string;
  accountId: string;
  source: { revisionId: string; targetSubjectId: string; sha256: string; licence: string };
}) {
  const edition = record(value);
  if (
    !edition ||
    edition.editionId !== expected.editionId ||
    edition.state !== 'published' ||
    edition.creatorAccountId !== expected.accountId ||
    edition.targetSubjectId !== expected.source.targetSubjectId ||
    edition.revisionId !== expected.source.revisionId ||
    edition.sha256 !== expected.source.sha256 ||
    edition.licence !== expected.source.licence ||
    typeof edition.editionRevision !== 'string' ||
    !/^[1-9][0-9]*$/u.test(edition.editionRevision)
  )
    throw new TypeError('Native edition read did not confirm the published source binding');
  return { editionId: edition.editionId, editionRevision: edition.editionRevision };
}

function creatorContainsEdition(
  value: unknown,
  expected: {
    editionId: string;
    editionRevision: string;
    accountId: string;
    source: { targetSubjectId: string; revisionId: string; sha256: string; licence: string };
  },
): boolean {
  const page = record(value);
  return (
    !!page &&
    Array.isArray(page.editions) &&
    page.editions.some((entry) => {
      const edition = record(entry);
      return (
        edition?.editionId === expected.editionId &&
        edition.editionRevision === expected.editionRevision &&
        edition.state === 'published' &&
        edition.creatorAccountId === expected.accountId &&
        edition.targetSubjectId === expected.source.targetSubjectId &&
        edition.revisionId === expected.source.revisionId &&
        edition.sha256 === expected.source.sha256 &&
        edition.licence === expected.source.licence
      );
    })
  );
}

export type DevelopmentContentEditionOutcome = Readonly<
  | DevelopmentSeedFailure
  | {
      state: 'published';
      editionId: string;
      editionRevision: string;
      source: {
        postId: string;
        revisionId: string;
        targetSubjectId: string;
        sha256: string;
        licence: 'CC-BY-4.0';
      };
    }
>;

/** Enroll and separately publish the exact native revision authored by the local persona. */
export async function seedDevelopmentContentEdition(input: {
  community: DevelopmentCommunityOutcome;
  actor: DevelopmentSeedActor;
  client: DevelopmentShowcaseClient;
}): Promise<DevelopmentContentEditionOutcome> {
  if (input.community.state !== 'published') return input.community;
  const { source, thread } = input.community;
  const sourceResult = await input.client.read(
    `/v1/posts/${thread.postId}/revisions/${thread.revisionId}?editionIdentity=true`,
  );
  if (sourceResult.state !== 'acknowledged') return { ...sourceResult, operation: 'post.revision.edition_identity' };
  let originalSource: ReturnType<typeof sourceFromResponse>;
  try {
    originalSource = sourceFromResponse(sourceResult.value, {
      accountId: input.actor.accountId,
      postId: thread.postId,
      revisionId: thread.revisionId,
      subjectId: source.subjectId,
      sha256: thread.sha256,
    });
  } catch {
    return { state: 'refused', operation: 'post.revision.edition_identity', code: 'source-binding-mismatch' };
  }

  const created = await input.client.command(
    {
      actionKey: `local-content-edition-create:${originalSource.postId}`,
      idempotencyKey: `local-content-edition-create:${originalSource.postId}`,
      method: 'POST',
      path: '/v1/contentEditions',
      body: {
        postId: originalSource.postId,
        revisionId: originalSource.revisionId,
        targetSubjectId: originalSource.targetSubjectId,
      },
    },
    editionCommand,
  );
  if (created.state !== 'acknowledged') return { ...created, operation: 'content_edition.create' };

  const published = await input.client.command(
    {
      actionKey: `local-content-edition-publish:${created.value.editionId}`,
      idempotencyKey: `local-content-edition-publish:${created.value.editionId}`,
      method: 'POST',
      path: `/v1/contentEditions/${created.value.editionId}:publish`,
      body: {},
      ifMatch: `"${created.value.editionRevision}"`,
    },
    editionCommand,
  );
  if (published.state !== 'acknowledged') return { ...published, operation: 'content_edition.publish' };
  if (
    published.value.editionId !== created.value.editionId ||
    BigInt(published.value.editionRevision) !== BigInt(created.value.editionRevision) + 1n
  )
    return { state: 'refused', operation: 'content_edition.publish', code: 'edition-acknowledgement-mismatch' };

  const current = await input.client.read(`/v1/contentEditions/${created.value.editionId}`);
  if (current.state !== 'acknowledged') return { ...current, operation: 'content_edition.read' };
  let edition: ReturnType<typeof publishedEdition>;
  try {
    edition = publishedEdition(current.value, {
      editionId: created.value.editionId,
      accountId: input.actor.accountId,
      source: originalSource,
    });
  } catch {
    return { state: 'refused', operation: 'content_edition.read', code: 'published-binding-mismatch' };
  }
  if (edition.editionRevision !== published.value.editionRevision)
    return { state: 'refused', operation: 'content_edition.read', code: 'edition-revision-mismatch' };

  const creatorRead = await input.client.read(`/v1/accounts/${input.actor.accountId}/editions?limit=20`);
  if (creatorRead.state !== 'acknowledged') return { ...creatorRead, operation: 'creator.editions' };
  if (
    !creatorContainsEdition(creatorRead.value, {
      editionId: edition.editionId,
      editionRevision: edition.editionRevision,
      accountId: input.actor.accountId,
      source: originalSource,
    })
  )
    return { state: 'refused', operation: 'creator.editions', code: 'published-edition-not-in-creator-read' };

  return {
    state: 'published',
    editionId: edition.editionId,
    editionRevision: edition.editionRevision,
    source: { ...originalSource, licence: 'CC-BY-4.0' },
  };
}
