import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/closure-notifications', {
  visitor: proved('requires authentication for recipient inbox, count and delivery state'),
  stranger: pending('suppresses closed content in its own deliveries while unrelated notices remain eligible'),
  member: pending('rechecks closure despite membership and retains unrelated eligible notices'),
  owner: pending('rechecks closure despite Realm ownership and retains authorized process notices'),
  moderator: pending('rechecks closure for a joined moderator and retains authorized process notices'),
  operator: pending('keeps deliveries recipient-specific and requires explicit process authority'),
}, {
  rights: {
    basis: 'original-contribution',
    credit: 'The publishing fixture must credit the author Person for original reply text and the independently published control; recipient authority supplies no rights.',
  },
});
