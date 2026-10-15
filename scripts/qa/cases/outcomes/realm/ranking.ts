import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/ranking',
  {
    visitor: proved('traverses complete public Best and Top beyond the legacy cohort; private ranking stays hidden'),
    stranger: proved('traverses public Best and Top with viewer-bound continuations; private ranking stays hidden'),
    member: proved('traverses only the current admission history in private Best and Top'),
    owner: proved('traverses all private Best and Top history under a live creation mandate'),
    moderator: proved('joined scoped moderator traverses authorized private Best and Top history'),
    operator: proved('platform authority traverses ordinary public ranking without private participation'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Original synthetic ranked discussion text authored by the represented fixture owner Person; ranking does not transfer credit.',
    },
  },
);
