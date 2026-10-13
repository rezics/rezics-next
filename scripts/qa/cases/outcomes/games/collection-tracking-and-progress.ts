import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('games/collection-tracking-and-progress', {
  visitor: proved("reads empty personal defaults and cannot save private game state anonymously"),
  stranger: proved("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
  member: proved("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
  owner: proved("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
  moderator: proved("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
  operator: proved("keeps library intent separate from whole-game and required/extra progress without changing another player's state"),
});

