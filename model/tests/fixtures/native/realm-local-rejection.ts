// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const realmLocalRejectionFixture = {
  "id": "realm-local-rejection-v1",
  "sha256": "8db4a0124cf3b2ac61a28595fb05677e8dff8977c4b0a126740f583de6589e02",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:RealmPublicationRejection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:slot <urn:rezics:realm-selection:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:reasonCode rv:NotApproved ; rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> ; rv:outcome rv:Rejected ; rv:decisionBasis rv:RealmManagerReview .\n",
      "args": {
        "rejection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-local-rejection-v1/rejection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "missing-slot": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:RealmPublicationRejection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:reasonCode rv:NotApproved ; rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> ; rv:outcome rv:Rejected ; rv:decisionBasis rv:RealmManagerReview .\n",
      "args": {
        "rejection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rv:slot",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-local-rejection-v1/rejection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "wrong-basis": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:RealmPublicationRejection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:slot <urn:rezics:realm-selection:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:reasonCode rv:NotApproved ; rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> ; rv:outcome rv:Rejected ; rv:decisionBasis rv:MainMaintainer .\n",
      "args": {
        "rejection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rv:decisionBasis",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-local-rejection-v1/rejection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "missing-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:slot <urn:rezics:realm-selection:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:reasonCode rv:NotApproved ; rv:selectionPolicy <https://rezics.com/definition/realm-manager-fixed-main-fallback-v1> ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> ; rv:outcome rv:Rejected ; rv:decisionBasis rv:RealmManagerReview .\n",
      "args": {
        "rejection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-local-rejection-v1/rejection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
