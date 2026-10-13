import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('visual-novels/work-hub-and-edition-choice', {
  visitor: proved('reads the published hub and credited exact choices; private preference needs sign-in'),
  stranger: proved('reads public choices but cannot read or change another reader preference'),
  member: proved('pins exact release and realization revisions, replays and recovers stale choices'),
  owner: proved('owns the Work and their choice without controlling another reader preference'),
  moderator: proved('uses their own choice; joined moderation grants no foreign reader control'),
  operator: proved('uses public hub and their own choice without a foreign reader mandate'),
}, { rights: { basis: 'original-contribution', credit: 'Original Lantern Orchard visual novel text and authorship by the fixture owner Person.' } });
