import { expect, test } from 'bun:test';
import { readPublicHubCards } from '../src/modules/hub/public-card.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';

const work = 'https://rezics.com/id/00000000-0000-0000-0000-000000000001';
const variant = 'urn:rezics:variant:00000000-0000-0000-0000-000000000002';
const revision = '00000000-0000-0000-0000-000000000003';
const digest = 'a'.repeat(64);

function session(options: { published?: boolean; digest?: string; subtype?: string;
  kind?: 'prompt' | 'skill-package' } = {}) {
  return { query: async () => options.published === false ? [] : [{
    work: { value: work }, variant: { value: variant },
    publication: { value: 'urn:publication' }, eligibility: { value: 'urn:eligibility' },
    revision: { value: `urn:rezics:content:revision:${revision}` }, digest: { value: digest },
  }], deps: {
    content: { readExactBatch: async () => [{ status: 'available', reference: {
      resourceId: work, variantId: variant, byteDigest: options.digest ?? digest,
      model: options.kind === 'skill-package' ? 'rezics-skill-package-v1' : 'rezics-prompt-v1' },
    body: options.kind === 'skill-package'
      ? { description: 'Summarize a reading session.', instructions: 'Group notes by theme.' }
      : { content: 'Ask about {{notes}}', applicability: { models: ['model-a'] } } }] },
    hub: { promptResource: async () => options.subtype ?? work,
      skillResource: async () => options.subtype ?? work },
  } } as unknown as WorkReadSession;
}

test('Hub Zone cards copy only the exact currently published prompt text', async () => {
  const cards = await readPublicHubCards(session(), [work]);
  expect(cards.get(work)).toEqual({ profile: 'hub-work-card-v1', kind: 'prompt',
    declaredModels: ['model-a'], testedModels: [], preview: 'Ask about {{notes}}',
    copyText: 'Ask about {{notes}}' });
  expect(await readPublicHubCards(session({ published: false }), [work])).toEqual(new Map());
});

test('Skill card previews its description and keeps the published instructions copyable', async () => {
  expect((await readPublicHubCards(session({ kind: 'skill-package' }), [work])).get(work))
    .toEqual({ profile: 'hub-work-card-v1', kind: 'skill-package', declaredModels: [],
      testedModels: [], preview: 'Summarize a reading session.', copyText: 'Group notes by theme.' });
});

test('Hub cards fail closed on changed bytes or a missing subtype', async () => {
  await expect(readPublicHubCards(session({ digest: 'b'.repeat(64) }), [work]))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(readPublicHubCards(session({ subtype: 'https://rezics.com/id/other' }), [work]))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});
