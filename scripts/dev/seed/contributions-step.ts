import { onEarlierWork, replayEarlierWork } from './contributions-work.ts';
import { seedKey, works, type DemoWork } from './plan.ts';
import { seedReply } from './replies.ts';
import type { ContributionReceipt, PublicationReceipt, SeedState } from './state.ts';
import { workIntents } from './works-step.ts';

export async function seedContributions(state: SeedState, plan: readonly DemoWork[] = works) {
  const { api, created, publicForRealm, sessions } = state;
  const owner = sessions[0]!;
  for (const excerpt of plan.filter(work => work.excerpt)) {
    const writer = excerpt.author === 'moonlight' ? owner
      : sessions.find(session => session.id === excerpt.author) ?? owner;
    const author = excerpt.author === 'moonlight'
      ? state.penAgents.get('moonlight')! : writer.actingSubject;
    const written = await state.optional(`Text contribution ${excerpt.id}`, () => onEarlierWork(created.get(excerpt.id)!,
      () => replayEarlierWork(api, workIntents(excerpt, author, !!excerpt.author), writer.token, seedKey('work', excerpt.id)),
      work => api.post<ContributionReceipt>('/v1/contributions', { profile: 'text-contribution-v1', work: work.work,
        language: excerpt.language, body: excerpt.excerpt!, actingSubject: author },
      writer.token, seedKey('contribution', excerpt.id))));
    if (!written) continue;
    const { work: target, result: contribution } = written;
    created.set(excerpt.id, target);
    const published = await state.optional('Contribution publication', () => api.post<PublicationReceipt>(
      '/v1/contribution-publications', { profile: 'text-publication-v1',
        contribution: contribution.contribution, expectedDraftHead: contribution.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
        actingSubject: author }, writer.token, seedKey('publication', excerpt.id)));
    const selected = published && await state.optional('Main selection', () => api.post('/v1/publication-selections', {
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: target.mainVersion },
      work: target.work, contribution: contribution.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer', actingSubject: author },
    writer.token, seedKey('selection', excerpt.id)));
    if (published) state.publishedCount++;
    if (selected) state.selectedCount++;
    if (selected && published) publicForRealm.set(excerpt.id,
      { contribution: contribution.contribution, decision: published.publicationDecision });
    if (!published) continue;
    const replyTarget = { id: `comment:${excerpt.id}`, work: target.work,
      revision: contribution.draftRevision, language: 'en' };
    const comment = await state.optional('Member comment', () => seedReply(api, sessions[1] ?? owner,
      replyTarget, `I saved this passage from ${excerpt.title} to discuss with the reading group.`));
    if (!comment) continue;
    state.commentCount++;
    const reply = await state.optional('Member reply', () => seedReply(api, sessions[2] ?? owner,
      { ...replyTarget, id: `response:${excerpt.id}` },
      'Which detail in this passage stood out to you?', comment));
    if (reply) state.replyCount++;
  }
}
