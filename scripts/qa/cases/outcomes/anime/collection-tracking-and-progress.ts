import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('anime/collection-tracking-and-progress', {
  visitor: proved('browses public episodes while private tracking and watched writes require sign-in'),
  stranger: pending('tracks generic library status, watches episodes and keeps Person projections private'),
  member: pending('tracks generic library status, watches episodes and keeps Person projections private'),
  owner: pending('tracks generic library status, watches episodes and keeps Person projections private'),
  moderator: pending('tracks generic library status, watches episodes and keeps Person projections private; joined moderation does not confer Person control'),
  operator: pending('tracks generic library status, watches episodes and keeps Person projections private; platform authority does not confer Person control'),
}, { rights: { basis: 'original-contribution',
  credit: 'Original fixture animation scripts, episode names and catalogue facts by the fixture owner Person; native author credit accompanies the Work.' } });

