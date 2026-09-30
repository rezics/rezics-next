import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderProfile } from '../compiler/ir.ts';
import { workKindProfile } from '../definitions/work-kind-v1.ts';
import { workKindV2Profile } from '../definitions/work-kind-v2.ts';
import { workKindV3Profile } from '../definitions/work-kind-v3.ts';
import { workTypeProfile } from '../definitions/work-type-v1.ts';
import { workTypeV2Profile } from '../definitions/work-type-v2.ts';
import { workTypeV3Profile } from '../definitions/work-type-v3.ts';

test('G653: v3 opens descriptive IRIs while retaining the Work base and revision structure', () => {
  for (const profile of [workKindV3Profile, workTypeV3Profile]) {
    const shape = renderProfile(profile);
    expect(shape).not.toContain('sh:in');
    expect(shape).not.toContain('sh:closed');
    expect(shape).toContain('sh:hasValue schema:CreativeWork');
    expect(shape).toContain('sh:maxCount 4');
    expect(shape).toContain('sh:nodeKind sh:IRI');
    expect(profile.shapes[0].properties[1]).toEqual(workKindV2Profile.shapes[0].properties[1]);
    const lock = JSON.parse(
      readFileSync(new URL(`../accepted/profiles/${profile.id}.json`, import.meta.url), 'utf8'),
    );
    expect(lock.sha256).toBe(createHash('sha256').update(shape).digest('hex'));
  }
  expect(workTypeV3Profile.shapes[1].properties).toEqual(workTypeV2Profile.shapes[1].properties);
  for (const profile of [workKindProfile, workKindV2Profile, workTypeProfile, workTypeV2Profile])
    expect(renderProfile(profile)).toContain('sh:in');
});
