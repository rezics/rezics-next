import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('anime/work-hub-and-edition-choice', {
  visitor: proved('reads recorded and missing publication dates and exact releases; private choices require sign-in'),
  stranger: proved('chooses an exact release independently and cannot use another Person'),
  member: proved('settles concurrent release choices and replays the winning save for its own Person'),
  owner: proved('reads the published hub and keeps release choices personal despite Work ownership'),
  moderator: proved('joined moderation authority does not replace Person control for exact release choices'),
  operator: proved('platform authority without the affected Person grant cannot access private release choices'),
}, { rights: { basis: 'original-contribution',
  credit: 'Original fixture animation scripts and catalogue facts by the fixture owner Person; native author credit accompanies each Work.' } });

