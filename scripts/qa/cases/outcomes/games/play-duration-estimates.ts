import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('games/play-duration-estimates', {
  visitor: pending('compares four public release/platform/playstyle cohorts without seeing private sessions or contributing anonymously'),
  stranger: pending('reads qualified estimates while another player’s private duration and export stay inaccessible'),
  member: pending('Realm membership adds no access to private sessions or their duration contributions'),
  owner: pending('corrects one duration cohort, preserves missingness and exports the admitted procedure and unit'),
  moderator: pending('Realm moderation adds no access to another player’s private duration or export'),
  operator: pending('platform authority alone adds no private duration access on ordinary public operations'),
});
