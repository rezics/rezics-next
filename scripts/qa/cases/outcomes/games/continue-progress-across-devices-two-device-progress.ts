import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('games/continue-progress-across-devices-two-device-progress', {
  visitor: proved("cannot read or save private device progress anonymously"),
  stranger: proved("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
  member: proved("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
  owner: proved("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
  moderator: proved("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
  operator: proved("uses two OAuth device grants of one Account for replay, stale recovery and undo; foreign subjects cannot change another player"),
});

