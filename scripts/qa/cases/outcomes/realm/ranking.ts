import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/ranking',
  {
    visitor: pending('traverses complete public Best and Top beyond the legacy cohort; private ranking stays hidden'),
    stranger: pending('traverses public Best and Top with viewer-bound continuations; private ranking stays hidden'),
    member: pending('traverses only the current admission history in private Best and Top'),
    owner: pending('traverses all private Best and Top history under a live creation mandate'),
    moderator: pending('joined scoped moderator traverses authorized private Best and Top history'),
    operator: pending('platform authority traverses ordinary public ranking without private participation'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Original synthetic ranked discussion text authored by the represented fixture owner Person; ranking does not transfer credit.',
    },
  },
);
