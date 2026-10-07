import { expect, test } from 'bun:test';
import { profileSource } from '../compiler/shacl.ts';
import { workKindProfile } from '../definitions/work-kind-v1.ts';
import { workKindV2Profile } from '../definitions/work-kind-v2.ts';
import { workTypeProfile } from '../definitions/work-type-v1.ts';
import { workTypeV2Profile } from '../definitions/work-type-v2.ts';

test('persisted v1 Work type shapes reject VideoGame; v2 creation and edit shapes admit it', () => {
  for (const [oldProfile, newProfile] of [
    [workKindProfile, workKindV2Profile], [workTypeProfile, workTypeV2Profile],
  ] as const) {
    const oldShape = profileSource(oldProfile);
    const newShape = profileSource(newProfile);
    expect(oldShape).toContain('sh:in');
    expect(oldShape).not.toContain('schema:VideoGame');
    expect(newShape).toContain('sh:in');
    expect(newShape).toContain('schema:VideoGame');
  }
});
