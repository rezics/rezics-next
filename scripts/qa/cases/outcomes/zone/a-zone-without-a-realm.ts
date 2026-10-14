import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/a-zone-without-a-realm', {
  visitor: proved('reads exact public cuts while drafts and unauthenticated edits remain private'),
  stranger: proved('reads the public bundle but cannot preview, save or publish with their own Agent'),
  member: proved('membership elsewhere supplies no authority over the independent Zone'),
  owner: proved('creates, previews, republishes and reopens saved Realm-less cuts with original saving Agent credit'),
  moderator: proved('joined Realm moderation supplies no independent Zone editing authority'),
  operator: proved('broad authority cannot edit this Zone; an exact mandate publishes and reopens saved cuts with saving Agent credit'),
}, {
  rights: {
    basis: 'original-contribution',
    credit: 'Original fixture Blocks Content credited to its saving Agent; later publication preserves that exact provenance.',
  },
});
