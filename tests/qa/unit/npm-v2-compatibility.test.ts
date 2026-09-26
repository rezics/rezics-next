import { expect, test } from 'bun:test';
import { npmSha, npmStable } from '../../../services/main/src/modules/package/npm-lock.ts';
import { validateNpmPlatformSnapshot } from '../../../services/main/src/modules/package/npm-platform.ts';
import { npmPlatformCases, npmPlatformFixture, npmTargets } from '../fixtures/npm-platform-snapshot.ts';

// G-021 output at fc23357, before v3: all fields, IDs, omissions and costs stay frozen.
const expected: Record<string, string> = {
  "platform-branch-linux-x64": "58b2e097b32364535960538470ec4983de5e42735398ad8d449b2ee234291e7b",
  "platform-branch-win32-x64": "6965d5480b257a924e6169d3b30bd52782ea181386fc1c8a836e9962bfac0324",
  "platform-branch-linux-arm64": "9740e985fd135f754a5b9c0b2a3a679dadbfee9c301fbb6cb9d76a4247a7f27a",
  "optional-child-platform-linux-x64": "7f3e125b44aedc5efa95d582ea1eef230b0bb2832332bbfe3c4482a084c90838",
  "optional-child-platform-win32-x64": "406cb9e948b8e821e5a628d199cb2789964a7c864e01396d20916974ca048ffd",
  "optional-child-platform-linux-arm64": "1ba664735db7995fd710fc79cef99ecb7e387df822934ad44766dda7821529d0",
  "shared-platform-required-linux-x64": "97b26dd7a5df576e162976080af2e3dfbae8522c1f14b4361f374fa3ee5ef330",
  "shared-platform-required-win32-x64": "6c9f26bf33519544f771d8eb3df7edc47b11985068d0b8840b6e4e14f28d8be3",
  "shared-platform-required-linux-arm64": "7f5cc9ed433270809021fa972ec12e119ef6b62af9e7041e7707324013962d40",
  "required-missing-linux-x64": "f0937c46cd12ac1bc23fc9b2b6c7ee454c0c190a544f0e225d237ab1a8dc7be2",
  "required-missing-win32-x64": "ce0ba1ee178d32ff1bf3a25a41b71044c4af308d474d60ac617933bff12d456d",
  "required-missing-linux-arm64": "3ea45572eab70108b3dd3012312edc08d3f07bd17923e209ebdbf96d74b0ff3a",
  "optional-missing-linux-x64": "4f7891378f09d352a1df98ea651bf9c25ff836621fd1d3da951620dcffdd5e0e",
  "optional-missing-win32-x64": "1dcada9b221dab544789abfb677c2755e3fae4a7d5e80a09a852a483eb57860e",
  "optional-missing-linux-arm64": "a08e12ebc0ddd8c4c0393bdbd64ea33d021066b616210f8c3f6ac0ba94258428",
  "required-peer-shadow-linux-x64": "469d25bc4639d704c0a798fca89bd3df3e6434748cc5eebb26cc07c455c60145",
  "required-peer-shadow-win32-x64": "580bf3382aa3e84e9d090e81db8f4a470045eca14641d07d2b50867cce13f6c2",
  "required-peer-shadow-linux-arm64": "55e11923b5d487e0f42dddd0e63acff150f2d565a519d4a509cbea194cd52221",
  "optional-peer-shadow-linux-x64": "c7cace8fdf96705891972afb36747f0dcf7a3c24f5bf8cccb43ab653b1652ea3",
  "optional-peer-shadow-win32-x64": "f83c6eafdba272681781227d387b6e7089cd7c658beaf96bee6e787afcfecf0f",
  "optional-peer-shadow-linux-arm64": "0a45c9cf4eedfe2d068fe2c690548070e658772981e34a3163b0cf6230da443f",
  "optional-peer-host-linux-x64": "dcf35eae88583f2fca02deb1b7e7b49f2f1f5ebae43c7d8236083018ab337849",
  "optional-peer-host-win32-x64": "a7c2336f022b3a5fd69883c202600a4a9392e3964218be84ea1c46e49bcf6e14",
  "optional-peer-host-linux-arm64": "acc9ef5c7813adebcd2209128459789c670295c9b4f03063eed57ee1d2e16812",
  "optional-cycle-linux-x64": "7beea78f16de4585804311bb267c775bf48e0bb130a63dd982c43b15c51f2518",
  "optional-cycle-win32-x64": "b6f20db19943e3c89da54ad0a987d0a68b4152b926004c7c78717bd2099597ab",
  "optional-cycle-linux-arm64": "2e6064d4bef8a9b46c44e2505b73a51f4f237556b5582ef2adbfdfe8b2838cc0",
  "shared-optional-linux-x64": "772ef71c7c6f5c041fd7f6d1a92120bb6af3a35abd05d4d7d324fecc0616a639",
  "shared-optional-win32-x64": "17f739232f6f17e982204b54983e029a6e5e8dbff3ba353f124c2984b1686164",
  "shared-optional-linux-arm64": "79197ed740be5d90b2a8ffc0067b020324e85a9e7cf7c901fae41bc518987546",
  "selectors-linux-x64": "0881a3e545cf3c84aec745bd71121244fb21318a0a006c45b4e4bebb28b407cb",
  "selectors-win32-x64": "4ace756a41fcb554539f34489eeb1efbfd34aab73ebd73d86d87b8bdf4a34769",
  "selectors-linux-arm64": "88d738bcac1450b276f4f5e9b9baeb926c550ff4f3d307fb3fc47991ff0e22c1"
};
test('PKG04/PKG12/PKG13: all 33 G-021 v2 outcomes remain exact after v3 admission', () => {
  for (const kind of npmPlatformCases) for (const target of npmTargets) {
    const result = validateNpmPlatformSnapshot(npmPlatformFixture(kind, target));
    expect(npmSha(npmStable(result))).toBe(expected[`${kind}-${target.os}-${target.cpu}`]);
    for (const instance of result.instances) {
      expect(instance).not.toHaveProperty('slotName');
      expect(instance).not.toHaveProperty('linkTarget');
    }
  }
});
