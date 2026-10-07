import { expect, test } from 'bun:test';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { createHash } from 'node:crypto';
import { profileSource } from '../compiler/shacl.ts';
import { workKindProfile } from '../definitions/work-kind-v1.ts';
import { workKindV2Profile } from '../definitions/work-kind-v2.ts';
import { workKindV3Profile } from '../definitions/work-kind-v3.ts';
import { workTypeProfile } from '../definitions/work-type-v1.ts';
import { workTypeV2Profile } from '../definitions/work-type-v2.ts';
import { workTypeV3Profile } from '../definitions/work-type-v3.ts';

test('G653: v3 opens descriptive IRIs while retaining the Work base and revision structure', () => {
  for (const [id, profile] of [
    ['work-kind-v3', workKindV3Profile],
    ['work-type-v3', workTypeV3Profile],
  ] as const) {
    const shape = profileSource(profile);
    expect(shape).not.toContain('sh:in');
    expect(shape).not.toContain('sh:closed');
    expect(shape).toContain('sh:hasValue schema:CreativeWork');
    expect(shape).toContain('sh:maxCount 4');
    expect(shape).toContain('sh:nodeKind sh:IRI');
    expect(profile.shapes[0].properties[1]).toEqual(workKindV2Profile.shapes[0].properties[1]);
    expect(profile.id).toBe(id);
    expect(createHash('sha256').update(shape).digest('hex')).toBe(profileRegistry[id].sha256);
  }
  expect(workTypeV3Profile.shapes[1].properties).toEqual(workTypeV2Profile.shapes[1].properties);
  for (const profile of [workKindProfile, workKindV2Profile, workTypeProfile, workTypeV2Profile])
    expect(profileSource(profile)).toContain('sh:in');
});
