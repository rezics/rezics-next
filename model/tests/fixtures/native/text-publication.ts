// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const textPublicationFixture = {
  "id": "text-publication-v1",
  "sha256": "831355eccb08af104d4dfc8d972cb4b8e4e4c39b40a3d83aab6a13f67af0dd37",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:PublicationDecision ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:author <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .\n",
      "args": {
        "publication": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/text-publication-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    },
    "missing-draft": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:PublicationDecision ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:author <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .\n",
      "args": {
        "publication": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": false,
      "pathHint": "rv:selectedDraft",
      "focus": [
        {
          "shape": "https://rezics.com/definition/text-publication-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    },
    "private-disclosure": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> a rv:PublicationDecision ; rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:author <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Private .\n",
      "args": {
        "publication": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": false,
      "pathHint": "rv:disclosure",
      "focus": [
        {
          "shape": "https://rezics.com/definition/text-publication-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    },
    "missing-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005> rv:contribution <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:author <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:selectedDraft <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> ; rv:rightsBasis rv:OriginalContribution ; rv:disclosure rv:Public .\n",
      "args": {
        "publication": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/text-publication-v1/decision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000005"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
