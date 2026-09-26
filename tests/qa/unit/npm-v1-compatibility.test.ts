import { expect, test } from 'bun:test';
import { npmSha, npmStable, validateNpmSnapshot } from '../../../services/main/src/modules/package/npm-lock.ts';
import { npmFixture, type NpmNativeCase } from '../fixtures/npm-lock-snapshot.ts';

// G-019 output at base b760a7a, before v2: canonical hashes include IDs, costs and every issue.
const expected: Record<NpmNativeCase, string> = {
  'nested-peers': '5b8b4c4d0b0aafc82e62c23bb8954a30864925216d31f152b76a61975a6c3fee',
  'incompatible-peer': '3469ab4ebfb44c3f70a78f52abd77fad73fba05c610f6ed6ba5ceb5c9925df0a',
  'missing-peer': 'f988b4b91f622af5206e451d6e1e69f869e89f494ea5310eab661962c12a330e',
  'ancestor-shadow': 'b6a416bfde776ec36ef105b1f262e75a9f5b87872ca3198ea14cea541b5f26dc',
  'child-local-peer': '6359d5edfd1ec40ab69099f319df897cd15562672b3dd71831c6bf7c90d9f789',
  'root-peer': '7f7035b4f6e3f4efe6aeaa1dd4c296f93fb8585c2a0e7f9261c1f29e41ef903f',
  'scoped-peer': '54eacc2c9c82bce176bc23c5d9864816ea18cda640eb8bb6717a0e5dac0d5150',
  'same-artifact-hosts': '1bbc0c1472ade9bd5e9df1d44a6a5ec349c433fbb8765017c89d3121f68943f8',
};
test('PKG03/PKG12/PKG13: all eight G-019 v1 outcomes remain exact after v2 admission', () => {
  for (const [kind, digest] of Object.entries(expected)) {
    const result = validateNpmSnapshot(npmFixture(kind as NpmNativeCase));
    expect(npmSha(npmStable(result))).toBe(digest);
    expect(result).not.toHaveProperty('target');
    expect(result).not.toHaveProperty('omittedInstances');
  }
});
