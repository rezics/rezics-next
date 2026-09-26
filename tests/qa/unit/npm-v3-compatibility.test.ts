import { expect, test } from 'bun:test';
import { NpmResolutionInvalid, npmSha, npmStable } from '../../../services/main/src/modules/package/npm-lock.ts';
import { validateNpmIdentitySnapshot } from '../../../services/main/src/modules/package/npm-identity.ts';
import { npmIdentityCases, npmIdentityFixture } from '../fixtures/npm-identity-snapshot.ts';

// G-023 output at base 37fe902, before v4: every ID, witness, cost and rejected message stays frozen.
const expected: Record<string, string> = {
  "registry-alias": "820ca30196c18d687560e516f28f8499ce7a270147b61dcb06ad4698a11eb811",
  "two-aliases": "60d5c334f6b904109c13532349ff7171cfb8a219e244a6b194e9fef8c5ef4994",
  "scoped-alias": "1a6db1254a75ddda57a280b01171d886e11dd64f152b6b5f12dd51ff7e3df26b",
  "alias-peer": "95563b3439bd37694e346fbd3f3c619a834865b1e718ea0c554f974889482965",
  "alias-peer-host": "93415d07594b1f99f529e56def68c1dcd7cf37775cc0b61bfb3f3bdf3edac33f",
  "alias-host-environments": "1d608f998c66d64e693664c34a8037c6cef4372e02d1729d956111c12e3bb154",
  "alias-identity-mismatch": "b7ea1344a8b52849cddfa6fa27278d3a7d8b1f46ff8bae8072fd4e7d7db5e2b0",
  "workspace-peer": "caf9cc8a10f45c1740831033cc4b781410e1c164e23ea9b6303f3dd3a283425d",
  "workspace-name-path": "e61816c8e34c1147850bb00a44835aa6712f060b601489df956b9a8c5f1f6778",
  "workspace-internal": "99f0f0ef68e61d59c63ca5d7e8c37a9d751cb43da85e8dd6f1fc18914a14e583",
  "workspace-peer-shadow": "bdc7ed6ab5a3049aa10ff9931018618612f670937418e2e5fdbe2b7bb83b8d83",
  "workspace-peer-local": "105399ed18bf449468c00354c10784ef58d4e6d6d5c307d641f8cb285ca2bcc4",
  "workspace-slot-mismatch": "1a85b8c718334b0a8e523a2fef377aea187824433703e9e0eb87f2c6f3859c4a",
  "workspace-target-mismatch": "4616626f454e259a8f959f25e334bc27f5ef178420aea2f93481e7412a219f7e",
  "missing-workspace-target": "e532951b2fd28465fb155e6ee30c6808cbf755dc5d1e8a3904c9a4b72ed32a05",
  "missing-workspace-link": "1231e7c9ad43132a55bc253ed118fe62c7038934f4eac5a286e3d93b91e21b23",
  "missing-link-source": "c0c613db3523c61489a5f8915cbd5427f04f8143b872af53de9365097408facf",
  "malformed-link": "7321869bcd6653175dc080aef7bc6172c07b6aeb5ab025b8903fa7d8553ad8c0",
  "missing-source": "1d646ea071f64ed0fe57576bbc1ec6121efd7fd02173965bd54aa34f1e41df79",
  "missing-integrity": "0b064e34154861c2a80f5c0cf6aeb001475e316f1ef1366d3496174415a01346",
  "malformed-source": "2b75809b0a18d742710b9412b2ee6c312e061eadcf4961664dc26d11c43a03be",
  "malformed-integrity": "7423012e2e4f3dad71354993efdd581a0be919d593952198e351cff384c69d66",
  "unknown-source": "f4e6cf965f2f8182d2d961ea00116f0f985217f565fd033f112aa889ae02d0e0",
  "overrides": "4ce77e3a5549ff919e4c98c2edcc414363ef0c6eea7dccea0dc12a61fe65f829",
  "engines": "5c2572b6a71b988c597ad27152693571835edb8cc1f3664f817f37e9783c83ab"
};
test('PKG04/PKG12/PKG13: all 25 G-023 v3 observations stay exact after v4 admission', () => {
  for (const kind of npmIdentityCases) {
    let result;
    try { result = validateNpmIdentitySnapshot(npmIdentityFixture(kind)); }
    catch (error) {
      if (!(error instanceof NpmResolutionInvalid)) throw error;
      result = { status: 'rejected', message: error.message };
    }
    expect(npmSha(npmStable(result))).toBe(expected[kind]);
    expect(result).not.toHaveProperty('target');
    expect(result).not.toHaveProperty('activeInstances');
  }
});
