import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'zone/attached-realm-discussion',
  {
    visitor: proved(
      'reads public canonical discussion without creating it and cannot read private discussion',
    ),
    stranger: proved(
      'attachment grants no membership; public discussion and private concealment retain their policy',
    ),
    member: proved(
      'reads private discussion as a member and preserves independently authored concurrent contributions',
    ),
    owner: proved(
      'publishes credited contributions to one canonical discussion and attachment withdrawal preserves them',
    ),
    moderator: proved('joined moderation does not bypass policy and retains private member access'),
    operator: proved(
      'platform exposure admits only its own Person author and does not confer private membership',
    ),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original fixture Zone text and discussion contributions credit the submitting Person; mounted Work metadata is original fixture catalogue data.',
    },
  },
);
