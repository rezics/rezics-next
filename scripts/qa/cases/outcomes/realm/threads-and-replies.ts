import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/threads-and-replies',
  {
    visitor: proved('traverses public siblings and deep branches; private reads and publication stay denied'),
    stranger: proved('publishes an original credited public reply; private participation and review stay denied'),
    member: proved('reads private discussion and publishes as self with stable retries and stale-write refusal'),
    owner: proved('reads private discussion and publishes as self under the creation mandate'),
    moderator: proved('joined moderation authority reads private discussion without granting review or another author'),
    operator: proved('platform authority preserves private disclosure and cannot publish or review as another author'),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Synthetic original discussions by each represented fixture Person; reply identity retains that author even when the public author card is withheld.',
    },
  },
);
