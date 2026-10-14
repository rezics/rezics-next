import { proved, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/closure-notifications', {
  visitor: proved('requires authentication for recipient inbox, count and delivery state'),
  stranger: proved('suppresses closed content in its own deliveries while unrelated notices remain eligible'),
  member: proved('rechecks closure despite membership and retains unrelated eligible notices'),
  owner: proved('rechecks closure despite Realm ownership and retains authorized process notices'),
  moderator: proved('rechecks closure for a joined moderator and retains authorized process notices'),
  operator: proved('keeps deliveries recipient-specific and requires explicit process authority'),
}, {
  rights: {
    basis: 'original-contribution',
    credit: 'The publishing fixture must credit the author Person for original reply text and the independently published control; recipient authority supplies no rights.',
  },
});
