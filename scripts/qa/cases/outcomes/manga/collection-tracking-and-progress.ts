import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('manga/collection-tracking-and-progress', {
  visitor: proved('discovers public chapters with empty private state and signed-out tracking refusals'),
  stranger: proved('tracks own status and chapters across volumes; foreign actingSubject preserves the affected reader’s state and timestamps'),
  member: proved('tracks own status and chapters across volumes; membership cannot project progress into a foreign library'),
  owner: proved('tracks own manga status and progress; Work ownership cannot change another reader’s library'),
  moderator: proved('tracks as self; joined Realm moderation cannot alter another reader’s library or timestamps'),
  operator: proved('tracks as self; platform and separate Work mandates cannot alter another reader’s library or timestamps'),
}, { rights: {
  basis: 'original-contribution',
  credit: 'Original fictional manga text and chapter labels by the fixture owner Person, with native author credit.',
} });
