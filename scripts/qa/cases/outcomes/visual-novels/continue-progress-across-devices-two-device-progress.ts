import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('visual-novels/continue-progress-across-devices-two-device-progress', {
  visitor: proved('needs sign-in for private cross-device progress'),
  stranger: pending('cannot advance or undo another reader standing or last-read ordering'),
  member: proved('independent OAuth device sees winning marks, recovers stale writes, replays and propagates undo'),
  owner: pending('own devices share progress; owning the Work cannot reset another reader tracking'),
  moderator: pending('joined moderation cannot override another reader standing or library continuity'),
  operator: pending('platform authority cannot override another reader standing or library continuity'),
});
