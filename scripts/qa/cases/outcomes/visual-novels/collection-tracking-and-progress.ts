import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('visual-novels/collection-tracking-and-progress', {
  visitor: proved('reads neutral collection state but cannot save status or private standing'),
  stranger: proved('cannot change a foreign reader state or last-read ordering through progress'),
  member: proved('tracks generic collection statuses and all partless VN standings with replay and undo'),
  owner: proved('controls own tracking; Work ownership gives no foreign reader control'),
  moderator: proved('joined moderation cannot change a foreign reader library through progress'),
  operator: proved('platform authority cannot change a foreign reader library through progress'),
});
