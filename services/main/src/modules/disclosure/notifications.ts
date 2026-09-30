import type { Pool } from 'pg';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';
import { DisclosureStore, DISCLOSURE_COST, type DisclosureChannel, type DisclosureDecision, type DisclosureTarget } from './read.ts';

type Input = Parameters<NotificationSubjectReader['resolve']>[0];
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f-]{36}$/;
const ref = (value: string) => native.test(value) ? value : uuid.test(value) ? `https://rezics.com/id/${value}` : null;
function targets(input: Input, fields: Readonly<Record<string, string>>): DisclosureTarget[] {
  const resource = ref(input.ref);
  const work = fields.linkTarget ? ref(fields.linkTarget) : null;
  // Review events predate the governance owner name and are stored as Access
  // subjects; their disclosed Work link remains part of the audience batch.
  const subjectOwner = input.owner === 'access'
    && ['review-created-v1', 'review-helpful-v1'].includes(input.disclosureBasis) ? 'review' : input.owner;
  const owner = ['graph', 'content', 'source', 'media', 'review'].find(owner => owner === subjectOwner);
  if (!resource || !owner) return [];
  const revision = input.revision?.replace(/^urn:rezics:content:revision:/, '') ?? null;
  return [{ owner: owner as DisclosureTarget['owner'], resource, component: 'body', revision, work },
    { owner: 'graph', resource, component: 'name', revision: owner === 'graph' ? revision : null },
    ...(owner === 'graph' && revision ? [{ owner: 'content' as const, resource, component: 'body' as const,
      revision, work }] : []),
    ...(work && work !== resource ? [{ owner: 'graph' as const, resource: work, component: 'name' as const }] : [])];
}

/** Inbox, counts, digests and delivery recheck the current subject and its link
 * target. Queued fields and prior endpoint checks grant no disclosure. */
export async function discloseNotifications(pool: Pool, subjects: readonly { input: Input; result: SubjectResolution }[],
  channel: DisclosureChannel, viewer: Viewer = { ...ANONYMOUS_VIEWER, signedIn: true }): Promise<SubjectResolution[]> {
  const descriptors: DisclosureTarget[] = [], ranges: number[][] = [];
  for (const subject of subjects) {
    const selected = subject.result.status === 'available' ? targets(subject.input, subject.result.subject.fields) : [];
    ranges.push(selected.map((_, index) => descriptors.length + index));
    descriptors.push(...selected);
  }
  const reader = new DisclosureStore(pool);
  const decisions: DisclosureDecision[] = [];
  for (let offset = 0; offset < descriptors.length; offset += DISCLOSURE_COST.batch) {
    decisions.push(...await reader.read(descriptors.slice(offset, offset + DISCLOSURE_COST.batch), viewer, channel));
  }
  return subjects.map((subject, index) => subject.result.status !== 'available' ? subject.result
    : ranges[index]!.length && ranges[index]!.every(ordinal => decisions[ordinal] === 'visible')
      ? subject.result : { status: 'undisclosed' });
}
