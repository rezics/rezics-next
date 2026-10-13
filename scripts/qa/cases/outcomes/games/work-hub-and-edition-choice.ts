import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('games/work-hub-and-edition-choice', {
  visitor: proved("reads the original public game hub and exact releases; saved choice requires an Account"),
  stranger: proved("pins an exact release revision on own Person without editorial or foreign preference authority"),
  member: proved("pins an exact release revision on own Person without editorial or foreign preference authority"),
  owner: proved("pins an exact release revision on own Person without editorial or foreign preference authority"),
  moderator: proved("pins an exact release revision on own Person without editorial or foreign preference authority"),
  operator: proved("pins an exact release revision on own Person without editorial or foreign preference authority"),
}, {
  rights: { basis: 'original-contribution', credit: 'Original synthetic game descriptions by the fixture owner Person, retained as native author credit; no external artwork or inferred rights.' },
});

