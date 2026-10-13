import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/rules',
  {
    visitor: proved(
      'reads localized public and bounded landing rules without administrative disclosure',
    ),
    stranger: proved(
      'reads permitted rules but cannot edit settings or bypass members-only submissions',
    ),
    member: proved(
      'reads private localized rules and submits their own published text without settings authority',
    ),
    owner: proved(
      'publishes localized rules atomically with replay, CAS, exact delegation and closed submissions',
    ),
    moderator: proved(
      'reads private rules and submits as a member; moderation alone cannot publish rules',
    ),
    operator: proved(
      'platform authority neither reveals private rules nor edits policy or bypasses participation',
    ),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original synthetic rules, revisions and English/Chinese translations by each fixture founder Person; a delegated moderator republishes that authored text. Original submitted stories are credited to their publishing fixture Persons through own-work and original-contribution commands.',
    },
  },
);
