// Ported from the recorded Python candidate suite; no runtime Python dependency.
import type { NativeProfileFixture } from '../../native-fixture-types.ts';
export const realmStandingRatingObservationFixture = {
  "id": "realm-standing-rating-observation-v1",
  "sha256": "a0206416dfc9d591e187dc22400ac802810a01245adb20e4ff48bdd4360960da",
  "cases": {
    "valid-create": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 7 .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "7"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "valid-correction": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 8 ; rv:predecessor <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037> a rv:RatingObservationRevision .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "8",
        "predecessor": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "valid-withdrawal": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Withdrawn ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:predecessor <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037> a rv:RatingObservationRevision .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "withdrawn",
        "predecessor": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037"
      },
      "expected": true,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "missing-observation-type": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 7 .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "7"
      },
      "expected": false,
      "pathHint": "rdf:type",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "wrong-realm-context": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000038> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 7 .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "7"
      },
      "expected": false,
      "pathHint": "rv:ratingContext",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "wrong-work-main": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000038> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 7 .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "7"
      },
      "expected": false,
      "pathHint": "rv:mainVersion",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "wrong-slot": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 7 .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "7"
      },
      "expected": false,
      "pathHint": "rv:ratingSlot",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "wrong-value": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 11 .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "7"
      },
      "expected": false,
      "pathHint": "rv:ratingValue",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "withdrawn-with-value": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Withdrawn ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 7 ; rv:predecessor <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037> a rv:RatingObservationRevision .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "withdrawn",
        "predecessor": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037"
      },
      "expected": false,
      "pathHint": null,
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "missing-predecessor": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 8 .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037> a rv:RatingObservationRevision .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "8",
        "predecessor": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037"
      },
      "expected": false,
      "pathHint": "rv:predecessor",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    },
    "wrong-evaluation-time": {
      "turtle": "@prefix rv: <https://rezics.com/vocab/> .\n@prefix schema: <https://schema.org/> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> a rv:RatingContext ; rv:contextState rv:Active ; rv:realm <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031> ; rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; rv:ratingCadence <https://rezics.com/definition/rating-standing-v1> ; rv:ratingPopulationPolicy <https://rezics.com/definition/rating-account-principal-population-v1> ; rv:ratingAggregationPolicy <https://rezics.com/definition/rating-latest-per-rater-mean-v1> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> a schema:CreativeWork ; rv:mainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> a rv:MainVersion ; rv:work <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> a rv:RatingObservation ; rv:ratingContext <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032> ; rv:targetMainVersion <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034> ; rv:ratingSlot <urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa> ; rv:observationHead <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> .\n<https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036> a rv:RatingObservationRevision ; rv:observation <https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035> ; rv:ratingAvailability rv:Available ; rv:evaluatedAt \"2026-09-24\" ; rv:submittedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:originalSubmissionAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:revisedAt \"2026-09-24T03:00:00Z\"^^xsd:dateTime ; rv:ratingValue 7 .\n",
      "args": {
        "realm": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031",
        "context": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032",
        "work": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033",
        "main": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034",
        "slot": "urn:rezics:rating-slot:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observation": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035",
        "revision": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036",
        "availability": "available",
        "value": "7"
      },
      "expected": false,
      "pathHint": "rv:evaluatedAt",
      "focus": [
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/realm-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/context-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/work-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/main-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/observation-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
        },
        {
          "shape": "https://rezics.com/definition/realm-standing-rating-observation-v1/revision-shape",
          "focus": "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
        }
      ]
    }
  }
} as const satisfies NativeProfileFixture;
