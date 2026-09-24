#!/usr/bin/env python3
"""Check first standing opinion, correction and withdrawal shape candidates."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_realm_standing_rating_observation.py"
REALM = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000031"
CONTEXT = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000032"
WORK = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000033"
MAIN = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000034"
OBSERVATION = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000035"
REVISION = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000036"
PREDECESSOR = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000037"
OTHER = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000038"
SLOT = "urn:rezics:rating-slot:" + "a" * 64
POLICY = "https://rezics.com/definition/"
AT = '"2026-09-24T03:00:00Z"^^xsd:dateTime'


def candidate(availability="Available", value=7, predecessor=None):
    rating_value = f" ; rv:ratingValue {value}" if value is not None else ""
    prior = f" ; rv:predecessor <{predecessor}>" if predecessor else ""
    prior_type = f"<{predecessor}> a rv:RatingObservationRevision .\n" if predecessor else ""
    return ("@prefix rv: <https://rezics.com/vocab/> .\n"
            "@prefix schema: <https://schema.org/> .\n"
            "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n"
            f"<{REALM}> a rv:Realm ; rv:realmState rv:Active ; "
            f"rv:ratingContext <{CONTEXT}> .\n"
            f"<{CONTEXT}> a rv:RatingContext ; rv:contextState rv:Active ; "
            f"rv:realm <{REALM}> ; rv:targetGrain rv:MainVersion ; "
            "rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ; "
            f"rv:ratingCadence <{POLICY}rating-standing-v1> ; "
            f"rv:ratingPopulationPolicy <{POLICY}rating-account-principal-population-v1> ; "
            f"rv:ratingAggregationPolicy <{POLICY}rating-latest-per-rater-mean-v1> .\n"
            f"<{WORK}> a schema:CreativeWork ; rv:mainVersion <{MAIN}> .\n"
            f"<{MAIN}> a rv:MainVersion ; rv:work <{WORK}> .\n"
            f"<{OBSERVATION}> a rv:RatingObservation ; rv:ratingContext <{CONTEXT}> ; "
            f"rv:targetMainVersion <{MAIN}> ; rv:ratingSlot <{SLOT}> ; "
            f"rv:observationHead <{REVISION}> .\n"
            f"<{REVISION}> a rv:RatingObservationRevision ; rv:observation <{OBSERVATION}> ; "
            f"rv:ratingAvailability rv:{availability} ; rv:evaluatedAt {AT} ; "
            f"rv:submittedAt {AT} ; rv:originalSubmissionAt {AT} ; rv:revisedAt {AT}"
            f"{rating_value}{prior} .\n{prior_type}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    valid = candidate()
    corrected = candidate(value=8, predecessor=PREDECESSOR)
    withdrawn = candidate(availability="Withdrawn", value=None, predecessor=PREDECESSOR)
    cases = {
        "valid-create": (valid, "available", 7, None, True, None),
        "valid-correction": (corrected, "available", 8, PREDECESSOR, True, None),
        "valid-withdrawal": (withdrawn, "withdrawn", None, PREDECESSOR, True, None),
        "missing-observation-type": (valid.replace(
            f"<{OBSERVATION}> a rv:RatingObservation ; ", f"<{OBSERVATION}> "),
            "available", 7, None, False, "rdf:type"),
        "wrong-realm-context": (valid.replace(f"rv:ratingContext <{CONTEXT}> .",
                                              f"rv:ratingContext <{OTHER}> ."),
            "available", 7, None, False, "rv:ratingContext"),
        "wrong-work-main": (valid.replace(f"rv:mainVersion <{MAIN}> .",
                                         f"rv:mainVersion <{OTHER}> ."),
            "available", 7, None, False, "rv:mainVersion"),
        "wrong-slot": (valid.replace(f"rv:ratingSlot <{SLOT}>",
                                     f"rv:ratingSlot <urn:rezics:rating-slot:{'b' * 64}>"),
            "available", 7, None, False, "rv:ratingSlot"),
        "wrong-value": (valid.replace("rv:ratingValue 7", "rv:ratingValue 11"),
            "available", 7, None, False, "rv:ratingValue"),
        "withdrawn-with-value": (withdrawn.replace("rv:predecessor",
            "rv:ratingValue 7 ; rv:predecessor"),
            "withdrawn", None, PREDECESSOR, False, None),
        "missing-predecessor": (corrected.replace(f" ; rv:predecessor <{PREDECESSOR}>", ""),
            "available", 8, PREDECESSOR, False, "rv:predecessor"),
        "wrong-evaluation-time": (valid.replace("rv:evaluatedAt " + AT,
                                               'rv:evaluatedAt "2026-09-24"'),
            "available", 7, None, False, "rv:evaluatedAt"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="rating-observation-", dir=ROOT / ".temp") as temp:
        for name, (source, availability, value, predecessor, expected, path_hint) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text(source)
            command = [sys.executable, str(HELPER), "--data", str(data),
                       "--realm", REALM, "--context", CONTEXT, "--work", WORK,
                       "--main", MAIN, "--slot", SLOT, "--observation", OBSERVATION,
                       "--revision", REVISION, "--availability", availability,
                       "--jena-home", str(args.jena_home), "--java-home", str(args.java_home),
                       "--temp-root", temp]
            if value is not None:
                command.extend(["--value", str(value)])
            if predecessor:
                command.extend(["--predecessor", predecessor])
            completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
            assert completed.returncode == (0 if expected else 1), (
                name, completed.stdout, completed.stderr)
            report = json.loads(completed.stdout)
            assert report["conforms"] is expected, (name, report)
            if path_hint:
                assert "sh:resultPath" in report["report"] and path_hint in report["report"], (
                    name, report)
            outcomes[name] = {"conforms": report["conforms"],
                              "exit_code": completed.returncode}
    print(json.dumps({"cases": ["MODEL15-realm-standing-rating-observation",
                                "MODEL17-explicit-observation-revision-focus"],
                      "profile_sha256": report["profile_sha256"],
                      "jena_shacl": report["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
