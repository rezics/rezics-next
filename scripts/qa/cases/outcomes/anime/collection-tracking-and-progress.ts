import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('anime/collection-tracking-and-progress', {
  visitor: proved('browses public episodes while private tracking and watched writes require sign-in'),
  stranger: proved('tracks generic library status, watches episodes and keeps Person projections private'),
  member: proved('tracks generic library status, watches episodes and keeps Person projections private'),
  owner: proved('tracks generic library status, watches episodes and keeps Person projections private'),
  moderator: proved('tracks generic library status, watches episodes and keeps Person projections private; joined moderation does not confer Person control'),
  operator: proved('tracks generic library status, watches episodes and keeps Person projections private; platform authority does not confer Person control'),
}, { rights: { basis: 'original-contribution',
  credit: 'Original fixture animation scripts, episode names and catalogue facts by the fixture owner Person; native author credit accompanies the Work.' } });

