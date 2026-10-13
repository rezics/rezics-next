import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes(
  'realm/create-a-realm',
  {
    visitor: proved('resolves a public handle but cannot found or disclose a private Realm'),
    stranger: proved('founds as the represented author with an atomic handle and private settings'),
    member: proved('founds a separate Realm without inheriting authority in the existing Realm'),
    owner: proved(
      'founds again within quota, recovers receipts and reserves one handle under concurrency',
    ),
    moderator: proved(
      'founds independently; membership and moderation do not confer founder authority',
    ),
    operator: proved(
      'founds as the represented author; platform status grants no affected-Realm authority',
    ),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit:
        'Original synthetic Realm names by each founding fixture Person; no third-party text or media.',
    },
  },
);
