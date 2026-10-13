import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/exchange-recipes', {
  visitor: proved('reads the published recipe while export and import retain their authenticated boundary'),
  stranger: proved('exports a public revision and imports into their own draft without peer editing or source possession'),
  member: proved('retains duplicate lines, exact quantities and ordered instructions through authenticated exchange'),
  owner: proved('replays retained file import without merging lines or treating imported structure as original publication'),
  moderator: proved('exports readable structure without importing into a peer recipe or possessing their source observation'),
  operator: proved('exports readable structure without inheriting peer edits or private source observations from platform status'),
}, { rights: {
  basis: 'Original source publication: original-contribution; exchanged file intake: unknown; imported Structure cannot be published as original-contribution.',
  credit: 'Public source Work credits its original author Person. The file transfers structure only; source/author and rights transfer remain an open product decision.',
} });
