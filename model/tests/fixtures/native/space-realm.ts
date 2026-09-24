// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const spaceRealmFixture = {
  "id": "space-realm-v1",
  "sha256": "bae6d586c9dee595adee14a30d05afe20188c73bcf1c33906c823f87ec08b86f",
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
