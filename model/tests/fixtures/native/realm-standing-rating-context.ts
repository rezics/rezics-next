// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const realmStandingRatingContextFixture = {
  "id": "realm-standing-rating-context-v1",
  "sha256": "be1cfde2f3f0c6207e684829b7a5a9c66383f52a640908051cd245ebf0454cd9",
  "cases": {
    "valid": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> ; rv:question \"Overall quality\"@en ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022",
        "question": "Overall quality"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
        }
      ]
    },
    "missing-context-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> ; rv:question \"Overall quality\"@en ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022",
        "question": "Overall quality"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
        }
      ]
    },
    "wrong-realm-link": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000023> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> ; rv:question \"Overall quality\"@en ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022",
        "question": "Overall quality"
      },
      "expected": false,
      "pathHint": "rv:ratingContext",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
        }
      ]
    },
    "wrong-question": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> ; rv:question \"Different question\"@en ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022",
        "question": "Overall quality"
      },
      "expected": false,
      "pathHint": "rv:question",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
        }
      ]
    },
    "wrong-target-grain": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> ; rv:question \"Overall quality\"@en ; rv:targetGrain rv:Work ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022",
        "question": "Overall quality"
      },
      "expected": false,
      "pathHint": "rv:targetGrain",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
        }
      ]
    },
    "wrong-scale": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> ; rv:question \"Overall quality\"@en ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 5 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022",
        "question": "Overall quality"
      },
      "expected": false,
      "pathHint": "rv:ratingScaleMax",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
        }
      ]
    },
    "wrong-cadence": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> ; rv:question \"Overall quality\"@en ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-daily-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022",
        "question": "Overall quality"
      },
      "expected": false,
      "pathHint": "rv:ratingCadence",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
        }
      ]
    },
    "wrong-population": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021> ; rv:question \"Overall quality\"@en ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-persona-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022",
        "question": "Overall quality"
      },
      "expected": false,
      "pathHint": "rv:ratingPopulationPolicy",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-context-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
