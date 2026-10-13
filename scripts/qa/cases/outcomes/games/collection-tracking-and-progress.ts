import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('games/collection-tracking-and-progress', {
  visitor: proved("reads empty personal defaults and cannot save private game state anonymously"),
  stranger: pending("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
  member: pending("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
  owner: pending("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
  moderator: pending("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
  operator: pending("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
});

