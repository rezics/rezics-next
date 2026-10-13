import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('anime/continue-progress-across-devices-two-device-progress', {
  visitor: proved('browses public episodes while private tracking and watched writes require sign-in'),
  stranger: proved('shares watched state across two genuine OAuth grants, rejects stale writes and keeps Person projections private'),
  member: proved('shares watched state across two genuine OAuth grants, rejects stale writes and keeps Person projections private'),
  owner: proved('shares watched state across two genuine OAuth grants, rejects stale writes and keeps Person projections private'),
  moderator: proved('shares watched state across two genuine OAuth grants, rejects stale writes and keeps Person projections private; joined moderation does not confer Person control'),
  operator: proved('shares watched state across two genuine OAuth grants, rejects stale writes and keeps Person projections private; platform authority does not confer Person control'),
}, { rights: { basis: 'original-contribution',
  credit: 'Original fixture animation scripts, episode names and catalogue facts by the fixture owner Person; native author credit accompanies the Work.' } });

