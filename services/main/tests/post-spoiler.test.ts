import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { ContentCore, PublicationPreparation } from '../../content/src/core.ts';
import type { RegisteredAdmission } from '../src/modules/access/admission.ts';
import {
  assertContentPublicationBody,
  buildPinnedContentPublicationUpdate,
  contentPublicationDigest,
  ContentPublicationConflict,
  type PublishPinnedContentInput,
} from '../src/modules/content-publication/publish.ts';
import { saveMemberReplyDraft } from '../src/modules/content-publication/reply-draft.ts';
import { readPost } from '../src/modules/post/read.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { profileValidations } from '../src/infrastructure/profile.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';

const post = `https://rezics.com/id/${randomUUID()}`;
const actor = `https://rezics.com/id/${randomUUID()}`;
const input: PublishPinnedContentInput = {
  resourceId: post,
  variantId: `urn:rezics:variant:${randomUUID()}`,
  revisionId: randomUUID(),
  preparationId: randomUUID(),
  expectedDigest: 'a'.repeat(64),
  expectedContentEpoch: randomUUID(),
  expectedPublicationHead: null,
};
const env = {
  lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() },
} as WorkActivationEnvironment;
const admission = {
  id: randomUUID(),
  authorityEpoch: '1',
  scope: `content:publish:${post}`,
} as RegisteredAdmission;
const preparation = {
  reference: {
    model: 'content-shape-v1',
    format: 'rezics-content-json-v1',
    language: { kind: 'tag', tag: 'en' },
    direction: 'ltr',
  },
  position: { dataEpoch: input.expectedContentEpoch, sequence: '1' },
} as PublicationPreparation;

test('Post publication binds optional spoiler intent and preserves omission while replacing explicit false atomically', () => {
  expect(contentPublicationDigest(input)).not.toBe(
    contentPublicationDigest({ ...input, spoiler: false }),
  );
  expect(contentPublicationDigest({ ...input, spoiler: true })).not.toBe(
    contentPublicationDigest({ ...input, spoiler: false }),
  );
  expect(buildPinnedContentPublicationUpdate(env, admission, input, preparation)).not.toContain(
    'rv:spoiler',
  );
  for (const spoiler of [true, false]) {
    const update = buildPinnedContentPublicationUpdate(
      env,
      admission,
      { ...input, spoiler },
      preparation,
    );
    expect(update).toContain(`<${post}> rv:spoiler ${spoiler} .`);
    expect(update).toContain(`<${post}> rv:spoiler ?priorSpoiler`);
    expect(update).toContain(`<${post}> a rv:Post`);
  }
});

test('Post publication rejects a spoiler on a Work before creating a pin', async () => {
  const content = {
    readExactBatch: async () => [
      {
        status: 'available',
        reference: {
          resourceId: input.resourceId,
          variantId: input.variantId,
          revisionId: input.revisionId,
          byteDigest: input.expectedDigest,
          model: 'content-shape-v1',
        },
        body: { body: 'Text' },
      },
    ],
  } as unknown as ContentCore;
  for (const postTarget of [true, false]) {
    const environment = {
      ...env,
      fuseki: { query: async () => ({ boolean: postTarget }) },
    } as unknown as WorkActivationEnvironment;
    const result = assertContentPublicationBody(content, { ...input, spoiler: false }, environment);
    if (postTarget) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toBeInstanceOf(ContentPublicationConflict);
  }
});

test('Post reads return omitted, false and true declarations without another graph call', async () => {
  for (const spoiler of [undefined, false, true]) {
    let calls = 0;
    const session = {
      options: {},
      deps: { access: {} },
      position: { dataEpoch: env.lineage.dataEpoch, sequence: '1' },
      query: async (query: string) => {
        calls++;
        if (query.includes('SELECT DISTINCT ?book')) return [];
        expect(query).toContain('OPTIONAL');
        return [
          {
            head: { value: actor },
            publisher: { value: actor },
            label: { value: 'Post title', 'xml:lang': 'en' },
            public: { value: 'true' },
            ...(spoiler !== undefined
              ? {
                  spoiler: {
                    type: 'literal',
                    datatype: 'http://www.w3.org/2001/XMLSchema#boolean',
                    value: String(spoiler),
                  },
                }
              : {}),
          },
        ];
      },
    } as unknown as WorkReadSession;
    const read = await readPost(session, post);
    expect(read.spoiler).toBe(spoiler);
    expect(Object.hasOwn(read, 'spoiler')).toBe(spoiler !== undefined);
    expect(calls).toBe(2);
  }
});

test('Post command validation requires a nonempty focus', async () => {
  const graph = {
    commandHealth: async () => ({ profiles: { 'post-v1': profileRegistry['post-v1'].sha256 } }),
  } as unknown as FusekiClient;
  await expect(
    profileValidations(
      graph,
      'post-v1',
      [
        {
          shape: 'https://rezics.com/definition/post-v1/post-shape',
          focus: [],
          graphs: ['urn:rezics:graph:current'],
        },
      ],
      { post, publisher: actor, revision: actor },
    ),
  ).rejects.toThrow('required validation focus or graph is empty');
});

test('Reply draft rejects nonboolean declarations before admission or byte custody', async () => {
  for (const spoiler of [null, 'true', 1]) {
    await expect(
      saveMemberReplyDraft(
        env,
        {} as ContentCore,
        {
          verify: async () => {
            throw new Error('invalid draft authenticated');
          },
        },
        {} as never,
        new Request('http://main.local'),
        {
          reply: post,
          variantId: input.variantId,
          rootTarget: actor,
          rootRevision: actor,
          expectedHead: null,
          language: 'en',
          direction: 'ltr',
          body: 'Reply',
          actingSubject: actor,
          spoiler: spoiler as unknown as boolean,
        },
        randomUUID(),
      ),
    ).rejects.toThrow('invalid reply spoiler');
  }
});
