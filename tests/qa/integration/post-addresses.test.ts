import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { deriveAddressSuffix, uuidToSid } from '@rezics/model/address';
import {
  activateMetadataWork,
  metadataWorkRequestDigest,
} from '../../../services/main/src/modules/work/activate.ts';
import {
  mainSelectionDigest,
  selectMainDefault,
} from '../../../services/main/src/modules/work/select-main.ts';
import { ALIAS_COST } from '../../../services/main/src/modules/address/registry.ts';
import { startMediaStack } from './media-support.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status)
    throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
interface Address {
  holder: string;
  state: string;
  canonical: { prefix: string; key: string; suffixSource: string };
}

test('former chapter IDs and aliases move to a readable Book placement; multiplicity and retirement stay exact', async () => {
  const stack = await startMediaStack('post-addresses');
  try {
    const owner = await stack.member('chapter-address-owner');
    const guest = await stack.member('chapter-address-guest');
    const objects = stack.objects('semantic/structure/');
    await objects.initialize();
    Object.assign(stack.env, { structureObjects: objects });
    const book = async (title: string) => {
      const semanticTypes = ['https://schema.org/Book'];
      const made = await activateMetadataWork(stack.env, {
        title,
        semanticTypes,
        admission: stack.admission(
          owner.actor,
          'work:create:root',
          'work.create',
          metadataWorkRequestDigest(title, semanticTypes),
        ),
      });
      if (!made.work || !made.mainVersion) throw new Error('Book was not created');
      await owner.grant(`work:edit:${made.work}`, 'work.edit');
      await owner.grant(`work:read:${made.work}`, 'work.read');
      const composition = await json<{ structure: string; revision: string }>(
        await owner.send('POST', '/v1/compositions', {
          profile: 'book-composition',
          work: made.work,
          mainVersion: made.mainVersion,
          actingSubject: owner.actor,
        }),
        201,
      );
      return { ...composition, work: made.work, mainVersion: made.mainVersion, title };
    };
    const first = await book('First address book');
    const second = await book('Second address book');
    const chapter = await json<{
      post: string;
      occurrence: string;
      compositionRevision: string;
      variantId: string;
    }>(
      await owner.send('POST', `/v1/works/${short(first.work)}/chapters`, {
        profile: 'book-chapter-create-v1',
        title: 'Retained chapter',
        language: 'en',
        direction: 'ltr',
        parent: first.structure,
        position: 'last',
        expectedCompositionHead: first.revision,
        actingSubject: owner.actor,
      }),
    );
    await owner.grant(`work:read:${chapter.post}`, 'work.read');
    await guest.grant(`work:read:${chapter.post}`, 'work.read');
    // Retain the Access-owned Work alias footprint from before the holder became
    // a Post. No scope migration or new Post alias claim is involved.
    const alias = `old-chapter-${randomUUID()}`;
    const renamed = `older-chapter-${randomUUID()}`;
    await stack.accessPool.query(
      `INSERT INTO access.alias_registry
      (scope,key,skeleton,holder,controller,state,revision) VALUES
      ('work',$1,$1,$3,$4,'current',$5), ('work',$2,$2,$3,$4,'redirect',$6)`,
      [alias, renamed, chapter.post, owner.actor, randomUUID(), randomUUID()],
    );
    const lookup = (key: string, reader = owner) =>
      reader.read(
        `/v1/addresses/resolve?${new URLSearchParams({
          scope: 'work',
          key,
          actingSubject: reader.actor,
        })}`,
      );
    const expected = (book: string, occurrence: string) => ({
      holder: chapter.post,
      state: 'redirect',
      canonical: {
        prefix: `/w/${uuidToSid(short(book))}/read/`,
        key: short(occurrence),
        suffixSource: '',
      },
    });
    for (const key of [
      short(chapter.post),
      uuidToSid(short(chapter.post)),
      `${uuidToSid(short(chapter.post))}-old-title`,
      alias,
      renamed,
    ]) {
      stack.fuseki.queries = 0;
      expect(await json<Address>(await lookup(key))).toMatchObject(
        expected(first.work, chapter.occurrence),
      );
      expect(stack.fuseki.queries).toBeLessThanOrEqual(ALIAS_COST.fusekiRequests.resolve);
    }
    stack.fuseki.queries = 0;
    const batch = await json<{ results: Address[] }>(
      await owner.send('POST', '/v1/addresses/resolutions', {
        lookups: Array.from({ length: ALIAS_COST.batch }, () => ({ scope: 'work', key: alias })),
        actingSubject: owner.actor,
      }),
    );
    expect(batch.results).toHaveLength(ALIAS_COST.batch);
    expect(
      batch.results.every(
        (address) => JSON.stringify(address) === JSON.stringify(batch.results[0]),
      ),
    ).toBe(true);
    expect(stack.fuseki.queries).toBeLessThanOrEqual(ALIAS_COST.fusekiRequests.resolve);
    // Knowing and reading the Post grants neither its private Book nor its address.
    expect((await lookup(alias, guest)).status).toBe(404);
    expect((await stack.call('GET', `/v1/addresses/resolve?scope=work&key=${alias}`)).status).toBe(
      404,
    );
    await stack.accessPool.query(
      `DELETE FROM access.permission_grant WHERE recipient_subject=$1 AND scope_id=$2`,
      [guest.actor, `work:read:${chapter.post}`],
    );
    await guest.grant(`work:read:${first.work}`, 'work.read');
    expect((await lookup(short(chapter.post), guest)).status).toBe(404);

    const reused = await json<{ occurrences: string[]; revision: string }>(
      await owner.send('POST', `/v1/compositions/${short(second.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: second.revision,
        actingSubject: owner.actor,
        operations: [
          {
            op: 'insert',
            parent: second.structure,
            position: 'last',
            role: 'chapter',
            target: chapter.post,
            label: { value: 'Reused chapter', language: 'en' },
          },
        ],
      }),
    );
    const chosen = [first, second].sort((left, right) => left.work.localeCompare(right.work))[0]!;
    const occurrence = chosen === first ? chapter.occurrence : reused.occurrences[0]!;
    expect(await json<Address>(await lookup(alias))).toMatchObject(
      expected(chosen.work, occurrence),
    );
    const head = chosen === first ? chapter.compositionRevision : reused.revision;
    await json(
      await owner.send('POST', `/v1/compositions/${short(chosen.structure)}/changes`, {
        profile: 'book-composition',
        expectedHead: head,
        actingSubject: owner.actor,
        operations: [
          {
            op: 'insert',
            parent: chosen.structure,
            position: 'last',
            role: 'chapter',
            target: chapter.post,
            label: { value: 'Repeated chapter', language: 'en' },
          },
        ],
      }),
    );
    expect(await json<Address>(await lookup(alias))).toMatchObject({
      holder: chapter.post,
      state: 'redirect',
      canonical: {
        prefix: `/w/${uuidToSid(short(chosen.work))}/`,
        key: 'contents',
        suffixSource: '',
      },
    });
    await stack.accessPool.query(
      `UPDATE access.alias_registry SET state='retired' WHERE scope='work' AND holder=$1`,
      [chapter.post],
    );
    expect((await lookup(alias)).status).toBe(410);
    expect((await lookup(renamed)).status).toBe(410);
    expect((await lookup(short(chapter.post))).status).toBe(200);

    // Anonymous resolution follows the same path after actual public text
    // publication; it does not borrow the signed-in owner's grants.
    const text = await stack.contribution(first.work, owner.actor, 'en', 'Book opening');
    const selection = {
      context: { kind: 'main-version-default' as const, id: first.mainVersion },
      work: first.work,
      contribution: text.contribution,
      publicationDecision: text.decision,
      expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const,
      actingSubject: owner.actor,
    };
    await selectMainDefault(
      stack.env,
      stack.admission(
        owner.actor,
        `publication:select:${first.mainVersion}`,
        'publication.select',
        mainSelectionDigest(selection),
      ),
      selection,
    );
    for (const [prefix, action] of [
      ['content:draft', 'content.draft'],
      ['content:publish', 'content.publish'],
      ['content:search-eligibility', 'content.search-eligibility'],
    ] as const) {
      await owner.grant(`${prefix}:${chapter.post}`, action);
    }
    const saved = await json<{
      revisionId: string;
      byteDigest: string;
      sourcePosition: { dataEpoch: string };
    }>(
      await owner.send('POST', '/v1/content-drafts', {
        profile: 'content-text-v1',
        resourceId: chapter.post,
        variantId: chapter.variantId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: 'ltr',
        expectedHead: null,
        body: 'Public chapter.',
        actingSubject: owner.actor,
      }),
      201,
    );
    const published = await json<{ decision: string }>(
      await owner.send('POST', '/v1/content-publications', {
        profile: 'content-publication-v1',
        preparationId: `chapter-address-${randomUUID()}`,
        revisionId: saved.revisionId,
        expectedDigest: saved.byteDigest,
        expectedContentEpoch: saved.sourcePosition.dataEpoch,
        resourceId: chapter.post,
        variantId: chapter.variantId,
        expectedPublicationHead: null,
        actingSubject: owner.actor,
      }),
      201,
    );
    await json(
      await owner.send('POST', '/v1/content-search-eligibility', {
        profile: 'content-search-eligibility-v1',
        resourceId: chapter.post,
        variantId: chapter.variantId,
        publicationDecision: published.decision,
        expectedEligibilityHead: null,
        actingSubject: owner.actor,
        rightsBasis: 'original-contribution',
        disclosure: 'public',
      }),
      201,
    );
    const publicKey = `${uuidToSid(short(first.work))}-${deriveAddressSuffix(first.title)}`;
    expect(
      await json<Address>(
        await stack.call('GET', `/v1/addresses/resolve?scope=work&key=${short(chapter.post)}`),
      ),
    ).toMatchObject({
      holder: chapter.post,
      state: 'redirect',
      canonical: {
        suffixSource: '',
        ...(chosen === first
          ? { prefix: `/w/${publicKey}/`, key: 'contents' }
          : { prefix: `/w/${publicKey}/read/`, key: short(chapter.occurrence) }),
      },
    });
  } finally {
    await stack.stop();
  }
}, 180_000);
