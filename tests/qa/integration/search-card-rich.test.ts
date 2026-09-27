import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { mainSelectionDigest, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';

test('public phrase page hydrates current Work card fields after the bounded search relation', async () => {
  const stack = await startMediaStack('search-card-rich');
  try {
    const member = await stack.member('writer');
    const created = await stack.privateWork(member.actor, 'A named search card');
    const phrase = `richcard${randomUUID().replaceAll('-', '')}`;
    const source = await stack.contribution(created.work, member.actor, 'en', `${phrase} body`);
    const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: source.contribution, publicationDecision: source.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
    const selection = await selectMainDefault(stack.env,
      stack.admission(member.actor, `publication:select:${created.mainVersion}`,
        'publication.select', mainSelectionDigest(input)), input);
    expect(selection.outcome).toBe('succeeded');
    const response = await stack.call('POST', '/v1/queries/page', { body: {
      profile: 'public-main-phrase-page-v1', phrase, language: 'en', pageSize: 20 } });
    expect(response.status).toBe(200);
    const page = await response.json() as { total: number; results: Array<{ work: string;
      title: { value: string }; cover: { kind: string }; primaryCredits: unknown[];
      rating: null; tagline: null; completionStatus: null }> };
    expect(page.total).toBe(1);
    expect(page.results).toMatchObject([{ work: created.work, title: { value: 'A named search card' },
      cover: { kind: 'fallback' }, primaryCredits: [], rating: null,
      tagline: null, completionStatus: null }]);
  } finally { await stack.stop(); }
});
