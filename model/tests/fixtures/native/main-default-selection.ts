// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const mainDefaultSelectionFixture = {
  "id": "main-default-selection-v1",
  "sha256": "92f91c7e990901a457bd688dd47f576178ffa1daa90f35a4d2d1c53f751de52a",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:PublicationSelection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:publicationDecision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed .\n",
      "args": {
        "selection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/main-default-selection-v1/selection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "missing-decision": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:PublicationSelection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed .\n",
      "args": {
        "selection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rv:publicationDecision",
      "focus": [
        {
          "shape": "https://rezics.com/definition/main-default-selection-v1/selection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "wrong-basis": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:PublicationSelection ; rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:publicationDecision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:selectionBasis rv:Unknown ; rv:selectionMode rv:Fixed .\n",
      "args": {
        "selection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rv:selectionBasis",
      "focus": [
        {
          "shape": "https://rezics.com/definition/main-default-selection-v1/selection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "missing-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> rv:context <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:publicationDecision <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> ; rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed .\n",
      "args": {
        "selection": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/main-default-selection-v1/selection-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
