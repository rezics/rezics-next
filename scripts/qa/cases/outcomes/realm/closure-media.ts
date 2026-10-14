import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/closure-media', {
  visitor: proved('hides closed media metadata, exact and bare bytes and validators while independent public uses remain available'),
  stranger: proved('rechecks closure for bearer and acting-subject delivery without borrowing another actor'),
  member: proved('rechecks closure despite membership before metadata, bytes and conditional delivery'),
  owner: proved('distinguishes Realm ownership from Asset ownership and preserves independent uses'),
  moderator: proved('rechecks closure for a joined moderator without ordinary-media inspection privileges'),
  operator: proved('requires explicit inspection authority rather than an affected-subject read grant'),
}, {
  rights: {
    basis: 'original-contribution',
    credit: 'The publishing fixture must credit its author Person for the original generated image and independent control; Asset uploader and Realm owner are distinct authorities.',
  },
});
