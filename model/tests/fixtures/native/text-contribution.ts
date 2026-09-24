// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const textContributionFixture = {
  "id": "text-contribution-v1",
  "sha256": "4a42b1851eaa3cace3e06c5a142329e7c3c380e756123c3b131dc2584c9d2d8b",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:TextContribution ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:author <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:language \"en\" ; rv:draftHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n",
      "args": {
        "contribution": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/text-contribution-v1/contribution-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "missing-author": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> a rv:TextContribution ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:language \"en\" ; rv:draftHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n",
      "args": {
        "contribution": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rv:author",
      "focus": [
        {
          "shape": "https://rezics.com/definition/text-contribution-v1/contribution-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    },
    "missing-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001> rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002> ; rv:author <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003> ; rv:language \"en\" ; rv:draftHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004> .\n",
      "args": {
        "contribution": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/text-contribution-v1/contribution-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
