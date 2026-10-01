import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';

interface Member {
  actor: string;
  grant(scope: string, action: string): Promise<void>;
  send(method: string, path: string, body?: unknown, key?: string): Promise<Response>;
  read(path: string): Promise<Response>;
}

/**
 * The one question everyone's ratings answer in a QA stack, however many seeds ask for it: the Work page
 * names the first global question it finds, so two seeds that each created their own would split the ratings
 * between two questions. A seed asks for it here and gets the existing one when another seed made it first.
 */
export async function globalRatingContext(member: Member, work: string, question: string): Promise<string> {
  const existing = await member.read(`/v1/resources/${work.slice(-36)}/rating-contexts`);
  if (existing.ok) {
    const items = (await existing.json() as { items: { context: string; question: string }[] }).items;
    const found = items.find(item => item.question === question);
    if (found) return found.context;
  }
  await member.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
  const created = await member.send('POST', '/v1/global-rating-contexts',
    { profile: 'global-rating-standing-context-v1', question, actingSubject: member.actor });
  const text = await created.text();
  if (created.status !== 201) throw new Error(`Seed step failed with ${created.status}: ${text}`);
  return (JSON.parse(text) as { context: string }).context;
}
