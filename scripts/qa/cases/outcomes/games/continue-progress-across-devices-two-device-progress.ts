import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('games/continue-progress-across-devices-two-device-progress', {
  visitor: proved("cannot read or save private device progress anonymously"),
  stranger: pending("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
  member: pending("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
  owner: pending("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
  moderator: pending("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
  operator: pending("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
});

