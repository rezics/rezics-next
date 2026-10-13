import { pending, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('realm/closure-media', {
  visitor: pending('hides closed media metadata, exact and bare bytes and validators while independent public uses remain available'),
  stranger: pending('rechecks closure for bearer and acting-subject delivery without borrowing another actor'),
  member: pending('rechecks closure despite membership before metadata, bytes and conditional delivery'),
  owner: pending('distinguishes Realm ownership from Asset ownership and preserves independent uses'),
  moderator: pending('rechecks closure for a joined moderator without ordinary-media inspection privileges'),
  operator: pending('requires explicit inspection authority rather than an affected-subject read grant'),
}, {
  rights: {
    basis: 'original-contribution',
    credit: 'The publishing fixture must credit its author Person for the original generated image and independent control; Asset uploader and Realm owner are distinct authorities.',
  },
});
