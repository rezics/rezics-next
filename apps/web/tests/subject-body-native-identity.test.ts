import { expect, test } from 'bun:test';
import { agentPageHead, type AgentPage } from '../src/features/pages/agent-page';
import { subjectBody, subjectPageJsonLd, subjectPageTitle } from '../src/features/pages/subject';
import recording from '../src/kernel/recorded/agent-page.json';

const origin = 'https://rezics.test';
function pageOf(id: unknown = recording.subject, status = 200): AgentPage {
  const page = structuredClone(recording);
  Object.assign(page.reads.r1.body.accounts[0]!, { avatar: null });
  Object.assign(page.reads.r0.body.subject, { id, descriptions: { en: 'Subject description' } });
  Object.assign(page.reads.r0, { status });
  Object.assign(page.reads.r0.body, {
    documents: { selected: 'Subject document' },
    summary: { cover: { ...recording.reads.r1.body.accounts[0]!.avatar, media: 'subject-cover' } },
  });
  return { ...page, account: { id: page.account, handle: page.handle } } as AgentPage;
}
const entityOf = (page: AgentPage) =>
  JSON.parse(agentPageHead(page, 'en', origin).scripts[0]!.children)['@graph'][0].mainEntity;

test('only the admitted successful Subject supplies headings, document identity and account metadata', () => {
  for (const id of [recording.subject, '0192f3a0-6c1e-7b2a-e001-000000000099', null, 42]) {
    for (const status of [200, 404, 503]) {
      const page = pageOf(id, status);
      page.reads.unplanned = { status: 200, body: recording.reads.r0.body };
      const admitted = id === page.subject && status === 200;
      expect(subjectPageTitle(page, 'en')).toBe(admitted ? recording.reads.r0.body.subject.labels.en : '');
      expect(subjectBody(page)?.subject.id).toBe(admitted ? page.subject : undefined);
      expect(subjectBody(page)?.documents).toEqual(admitted ? { selected: 'Subject document' } : undefined);
      expect(subjectPageJsonLd(page, 'en') !== undefined).toBe(admitted);
      const entity = entityOf(page);
      expect(entity.description).toBe(admitted ? 'Subject description' : undefined);
      expect(entity.image?.includes('/media/subject-cover/')).toBe(admitted ? true : undefined);
    }
  }
  const missingId = pageOf();
  Reflect.deleteProperty((missingId.reads.r0!.body as { subject: object }).subject, 'id');
  expect(subjectBody(missingId)).toBeUndefined();
  expect(entityOf(missingId).description).toBeUndefined();
});

test('account metadata needs no related data or Subject projection', () => {
  const page = pageOf();
  Reflect.deleteProperty(page.reads.r0!.body as object, 'related');
  expect(subjectBody(page)).toBeUndefined();
  expect(entityOf(page).description).toBe('Subject description');
  Object.assign(page, { subject: null, reads: {} });
  expect(subjectBody(page)).toBeUndefined();
  expect(entityOf(page)).toMatchObject({ alternateName: recording.handle, url: `${origin}/en/@${recording.handle}` });
  expect(entityOf(page).description).toBeUndefined();
});
