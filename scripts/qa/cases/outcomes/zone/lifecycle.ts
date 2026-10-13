import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('zone/lifecycle', {
  visitor: proved('loses delivery during retirement and receives the exact retained bundle after recovery; cannot transition it'),
  stranger: proved('cannot configure or transition another Zone and sees only its retained public bundle'),
  member: proved('Realm membership cannot alter the independent Zone lifecycle or expose retained drafts'),
  owner: pending('private configuration and stale publication retain the bundle and saved editor preview through retirement and recovery'),
  moderator: proved('joined Realm moderation cannot configure, retire or recover the independent Zone'),
  operator: pending('an exact resource mandate obeys the same lifecycle and stale-cut rules and preserves saving Agent credit'),
}, {
  rights: {
    basis: 'original-contribution',
    credit: 'Original fixture Blocks Content keeps its saving Agent attribution and exact admitted provenance through lifecycle changes.',
  },
});
