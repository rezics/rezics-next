import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/publish-after-editor-revocation-revoked-editors', {
  visitor: proved('sees only the prior bundle after editor revocation and cannot preview or publish the rejected saved draft'),
  stranger: proved('knowledge of exact saved revisions and publication keys does not authorize preview, save or publication'),
  member: pending('a revoked controller remains a Realm member but cannot preview or publish; restoration recovers bytes and the saved editor'),
  owner: pending('revoked owner control retains recoverable saved bytes; post-pin competing switch setup needs a public API observation'),
  moderator: pending('a revoked controller retains joined Realm moderation but loses preview and publication until restoration reopens the saved editor'),
  operator: pending('requires live resource and named Agent control; independent authority preserves saved bytes and original credit'),
}, {
  rights: {
    basis: 'original-contribution',
    credit: 'Original fixture Blocks Content keeps the saving Agent as author through rejected publication, restoration and later publication.',
  },
});
