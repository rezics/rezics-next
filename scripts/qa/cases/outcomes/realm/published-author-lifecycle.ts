import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/published-author-lifecycle', {
  visitor: pending('AMGT01 reads exact public authored revisions and receives authentication refusals for correction and withdrawal'),
  stranger: pending('AMGT01 cannot correct or withdraw another author contribution, qualification or placement'),
  member: pending('AMGT01 membership preserves exact public reads without another author edit or withdrawal authority'),
  owner: pending('AMGT01 corrects published chapter Post and reply identities and withdraws exact owned targets with replay and stale safety'),
  moderator: pending('AMGT01 moderation grants no author correction or owned-publication withdrawal authority'),
  operator: pending('AMGT01 platform status grants no author correction or owned-publication withdrawal authority'),
}, {
  rights: { basis: 'original-contribution',
    credit: 'Original chapter, Post and reply text retains its creating Person; independent publication and placement decisions retain their own authority.' },
});
