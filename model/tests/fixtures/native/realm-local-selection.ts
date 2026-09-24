// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const realmLocalSelectionFixture = {
  "id": "realm-local-selection-v1",
  "sha256": "a2c6dfa4bebe46b3be17501986bfbcac606ffce144b1deb7b17a9621eed56bca",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:PublicationSelection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:slot <urn:rezics:realm-selection:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:publicationDecision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:selectionBasis rv:RealmManagerReview ; rv:selectionMode rv:Fixed ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> .\n",
      "args": {
        "selection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-local-selection-v1/selection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "missing-slot": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:PublicationSelection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:publicationDecision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:selectionBasis rv:RealmManagerReview ; rv:selectionMode rv:Fixed ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> .\n",
      "args": {
        "selection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rv:slot",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-local-selection-v1/selection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "wrong-basis": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:PublicationSelection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:slot <urn:rezics:realm-selection:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:publicationDecision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> .\n",
      "args": {
        "selection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rv:selectionBasis",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-local-selection-v1/selection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "missing-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:slot <urn:rezics:realm-selection:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:publicationDecision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000006> ; rv:selectionBasis rv:RealmManagerReview ; rv:selectionMode rv:Fixed ; rv:reviewPolicy <https://rezics.com/definition/realm-manager-reviewed-v1> .\n",
      "args": {
        "selection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-local-selection-v1/selection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
