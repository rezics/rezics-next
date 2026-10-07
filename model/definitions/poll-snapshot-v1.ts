import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const pollSnapshotDeclaration = {
  id: 'poll-snapshot-v1',
  canonical: {
    poll: { types: ['rv:Poll'] },
    question: { types: ['rv:PollQuestionRevision'] },
    option: { types: ['rv:PollOption'] },
    snapshot: { types: ['rv:ElectorateSnapshot'] },
    entitlement: { types: ['rv:SourceEntitlement'] },
    opening: { types: ['rv:PollOpening'] },
  },
} as const satisfies TurtleDeclaration;

export const pollSnapshotProfile = parseTurtleProfile(
  pollSnapshotDeclaration.id,
  readFileSync(new URL('./poll-snapshot-v1.ttl', import.meta.url), 'utf8'),
  pollSnapshotDeclaration,
);
