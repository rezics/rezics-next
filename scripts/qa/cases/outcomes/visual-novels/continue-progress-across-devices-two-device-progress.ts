import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('visual-novels/continue-progress-across-devices-two-device-progress', {
  visitor: proved('needs sign-in for private cross-device progress'),
  stranger: proved('cannot advance or undo another reader standing or last-read ordering'),
  member: proved('independent OAuth device sees winning marks, recovers stale writes, replays and propagates undo'),
  owner: proved('own devices share progress; owning the Work cannot reset another reader tracking'),
  moderator: proved('joined moderation cannot override another reader standing or library continuity'),
  operator: proved('platform authority cannot override another reader standing or library continuity'),
});
