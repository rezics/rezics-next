import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('visual-novels/collection-tracking-and-progress', {
  visitor: proved('reads neutral collection state but cannot save status or private standing'),
  stranger: pending('cannot change a foreign reader state or last-read ordering through progress'),
  member: proved('tracks generic collection statuses and all partless VN standings with replay and undo'),
  owner: pending('controls own tracking; Work ownership gives no foreign reader control'),
  moderator: pending('joined moderation cannot change a foreign reader library through progress'),
  operator: pending('platform authority cannot change a foreign reader library through progress'),
});
