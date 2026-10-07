import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const realmReplyPlacementDeclaration = {
  id: 'realm-reply-placement-v1',
  canonical: {
    slot: { types: ['rv:RealmReplySlot'] },
    placement: { types: ['rv:RealmReplyPlacement'] },
  },
  binding: {
    required: [
      'slot', 'placement', 'realm', 'reply', 'root', 'revision', 'review', 'author',
      'actor', 'receipt', 'scope', 'epoch',
    ],
    roles: ['slot', 'placement'],
    demandedBy: ['rv:RealmReplyPlacement'],
  },
} as const satisfies TurtleDeclaration;

export const realmReplyPlacementProfile = parseTurtleProfile(
  realmReplyPlacementDeclaration.id,
  readFileSync(new URL('./realm-reply-placement-v1.ttl', import.meta.url), 'utf8'),
  realmReplyPlacementDeclaration,
);
