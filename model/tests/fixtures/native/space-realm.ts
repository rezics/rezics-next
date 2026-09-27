// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
const originalFixture = {
  "id": "space-realm-v1",
  "sha256": "74a39bad65c0fd259f557146bed386843c5919fac3491b7503032d1ce9e370c2",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:Space ; rv:owner <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:realmCapability <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:Realm ; rv:space <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; rv:realmState rv:Active ; rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ; rv:membershipPolicy <https://rezics.com/definition/realm-closed-v1> ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> .\n",
      "args": {
        "space": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/space-realm-v1/space-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/space-realm-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        }
      ]
    },
    "missing-owner": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:Space ; rv:realmCapability <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:Realm ; rv:space <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; rv:realmState rv:Active ; rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ; rv:membershipPolicy <https://rezics.com/definition/realm-closed-v1> ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> .\n",
      "args": {
        "space": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
      },
      "expected": false,
      "pathHint": "rv:owner",
      "focus": [
        {
          "shape": "https://rezics.com/definition/space-realm-v1/space-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/space-realm-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        }
      ]
    },
    "missing-realm-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:Space ; rv:owner <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:realmCapability <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> rv:space <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; rv:realmState rv:Active ; rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ; rv:membershipPolicy <https://rezics.com/definition/realm-closed-v1> ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> .\n",
      "args": {
        "space": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/space-realm-v1/space-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/space-realm-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        }
      ]
    },
    "wrong-policy": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:Space ; rv:owner <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:realmCapability <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> a rv:Realm ; rv:space <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; rv:realmState rv:Active ; rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ; rv:membershipPolicy <https://rezics.com/definition/realm-closed-v1> ; rv:reviewPolicy <https://rezics.com/definition/unknown-review-v1> .\n",
      "args": {
        "space": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001",
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
      },
      "expected": false,
      "pathHint": "rv:reviewPolicy",
      "focus": [
        {
          "shape": "https://rezics.com/definition/space-realm-v1/space-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        },
        {
          "shape": "https://rezics.com/definition/space-realm-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;

const policyCases: NativeProfileFixture['cases'] = {};
const realm = `<${originalFixture.cases.valid.args.realm}>`;
const space = `<${originalFixture.cases.valid.args.space}>`;
for (const visibility of ['public', 'restricted', 'private']) {
  for (const [mode, policy] of [
    ['mandatory', 'manager-reviewed'], ['trusted-members', 'members-direct'], ['open', 'open'],
  ]) {
    policyCases[`${visibility}-${mode}`] = {
      ...originalFixture.cases.valid,
      turtle: originalFixture.cases.valid.turtle.replace('realm-manager-reviewed-v1', `realm-${policy}-v1`)
        + `${space} rv:disclosure rv:${visibility === 'private' ? 'Private' : 'Public'} .\n`
        + `${realm} rv:visibility "${visibility}" ; rv:reviewMode "${mode}" ; rv:realmPolicyHead <urn:rezics:realm-policy:fixture> .\n`,
    };
  }
}
for (const [name, triple, pathHint] of [
  ['unknown-visibility', `${realm} rv:visibility "secret" .`, 'rv:visibility'],
  ['unknown-review-mode', `${realm} rv:reviewMode "off" .`, 'rv:reviewMode'],
  ['unknown-disclosure', `${space} rv:disclosure rv:Unknown .`, 'rv:disclosure'],
]) {
  policyCases[name!] = { ...originalFixture.cases.valid,
    turtle: originalFixture.cases.valid.turtle + triple + '\n', expected: false, pathHint: pathHint! };
}
export const spaceRealmFixture = { ...originalFixture,
  cases: { ...originalFixture.cases, ...policyCases },
} satisfies NativeProfileFixture;
