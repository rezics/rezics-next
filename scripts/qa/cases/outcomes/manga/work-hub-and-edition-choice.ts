import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('manga/work-hub-and-edition-choice', {
  visitor: proved('reads recorded and missing dates and named releases; private choice requires sign-in'),
  stranger: proved('retains an independent exact release and cannot read or change another reader’s choice'),
  member: proved('settles concurrent saves, replays the winner and retains the exact release pin'),
  owner: proved('maintains own release records and retains a private exact release choice'),
  moderator: proved('chooses as self; Realm moderation grants no foreign preference or Work editing authority'),
  operator: proved('platform authority grants no foreign preference; a separate Work mandate permits edition maintenance'),
}, { rights: {
  basis: 'original-contribution',
  credit: 'Original fictional manga text and native author credit belong to the fixture owner Person.',
} });
