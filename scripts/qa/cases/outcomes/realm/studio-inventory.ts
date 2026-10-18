import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/studio-inventory', {
  visitor: pending('AMGT01 requires authentication without disclosing an authored inventory or nested counts'),
  stranger: pending('AMGT01 searches only the controlled Agent inventory and cannot borrow the author cursor'),
  member: pending('AMGT01 preserves own title search and filters without a Realm membership bypass'),
  owner: pending('AMGT01 searches and stably sorts the entire authored inventory with bound continuations and honest nested chapter counts'),
  moderator: pending('AMGT01 preserves own inventory filters without moderation granting another author access'),
  operator: pending('AMGT01 preserves own inventory filters without platform status granting another author access'),
}, {
  rights: { basis: 'original-contribution',
    credit: 'Synthetic original titles, chapter text and discussion text by the retained fixture Persons; no imported source claims.' },
});
