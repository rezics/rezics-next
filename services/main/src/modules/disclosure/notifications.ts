import type { Pool } from 'pg';
import type { NotificationSubjectReader, SubjectResolution } from '../notification/dispatcher.ts';
import { ANONYMOUS_VIEWER, type Viewer } from '../suitability/policy.ts';
import { disclosurePoolReader, discloseInventory, DISCLOSURE_COST, type DisclosureChannel, type DisclosureDecision, type DisclosureTarget } from './read.ts';

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
  if (!resource || !owner) return work ? [{ owner: 'graph', resource: work,
    component: 'name', context: input.realm ?? undefined }] : [];
  const revision = input.revision?.replace(/^urn:rezics:content:revision:/, '') ?? null;
  const context = input.realm ?? undefined;
  return [{ owner: owner as DisclosureTarget['owner'], resource, component: 'body', revision, work, context },
    { owner: 'graph', resource, component: 'name', revision: owner === 'graph' ? revision : null, context },
    ...(owner === 'graph' && revision ? [{ owner: 'content' as const, resource, component: 'body' as const,
      revision, work, context }] : []),
    ...(work && work !== resource ? [{ owner: 'graph' as const, resource: work, component: 'name' as const, context }] : [])];
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
  const reader = disclosurePoolReader(pool);
  if (!reader) return subjects.map(subject => subject.result);
  const decisions: DisclosureDecision[] = [];
  if (reader.environment) decisions.push(...await discloseInventory(reader.environment, descriptors, viewer, channel));
  else for (let offset = 0; offset < descriptors.length; offset += DISCLOSURE_COST.batch) {
    decisions.push(...await reader.read(descriptors.slice(offset, offset + DISCLOSURE_COST.batch), viewer, channel));
  }
  return subjects.map((subject, index) => subject.result.status !== 'available' ? subject.result
    : ranges[index]!.every(ordinal => decisions[ordinal] === 'visible')
      ? subject.result
      : subject.input.owner === 'access'
        && ['realm-invitation-v1', 'moderation-outcome-v1', 'submission-decision-v1', 'realm-role-change-v1']
          .includes(subject.input.disclosureBasis)
        // Process notices remain deliverable even when their optional Work link is hidden.
        ? { ...subject.result, subject: { ...subject.result.subject,
          fields: Object.fromEntries(Object.entries(subject.result.subject.fields)
            .filter(([key]) => !['linkTarget', 'linkRevision', 'linkTitle', 'title', 'avatar', 'avatarUrl'].includes(key))) } }
        : { status: 'undisclosed' });
}
