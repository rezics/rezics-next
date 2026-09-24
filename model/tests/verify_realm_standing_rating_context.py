#!/usr/bin/env python3
"""Check explicit Realm standing-rating context focuses with pinned Jena SHACL."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_realm_standing_rating_context.py"
REALM = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000021"
CONTEXT = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000022"
OTHER = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000023"
QUESTION = "Overall quality"
POLICY = "https://rezics.com/definition/"


def candidate():
    return ("@prefix rv: <https://rezics.com/vocab/> .\n"
            f"<{REALM}> a rv:Realm ; rv:realmState rv:Active ; "
            f"rv:ratingContext <{CONTEXT}> .\n"
            f"<{CONTEXT}> a rv:RatingContext ; rv:contextState rv:Active ; "
            f"rv:realm <{REALM}> ; rv:question \"{QUESTION}\"@en ; "
            "rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; "
            "rv:ratingScaleMax 10 ; "
            f"rv:ratingCadence <{POLICY}rating-standing-v1> ; "
            f"rv:ratingPopulationPolicy <{POLICY}rating-account-principal-population-v1> ; "
            f"rv:ratingAggregationPolicy <{POLICY}rating-latest-per-rater-mean-v1> .\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    valid = candidate()
    cases = {
        "valid": (valid, True, None),
        "missing-context-type": (valid.replace(
            f"<{CONTEXT}> a rv:RatingContext ; ", f"<{CONTEXT}> "),
                                 False, "rdf:type"),
        "wrong-realm-link": (valid.replace(f"rv:ratingContext <{CONTEXT}> .",
                                           f"rv:ratingContext <{OTHER}> ."),
                             False, "rv:ratingContext"),
        "wrong-question": (valid.replace(f'rv:question "{QUESTION}"@en',
                                         'rv:question "Different question"@en'),
                           False, "rv:question"),
        "wrong-target-grain": (valid.replace("rv:targetGrain rv:MainVersion",
                                              "rv:targetGrain rv:Work"),
                               False, "rv:targetGrain"),
        "wrong-scale": (valid.replace("rv:ratingScaleMax 10", "rv:ratingScaleMax 5"),
                        False, "rv:ratingScaleMax"),
        "wrong-cadence": (valid.replace(f"rv:ratingCadence <{POLICY}rating-standing-v1>",
                                        f"rv:ratingCadence <{POLICY}rating-daily-v1>"),
                          False, "rv:ratingCadence"),
        "wrong-population": (valid.replace(
            f"rv:ratingPopulationPolicy <{POLICY}rating-account-principal-population-v1>",
            f"rv:ratingPopulationPolicy <{POLICY}rating-persona-population-v1>"),
                             False, "rv:ratingPopulationPolicy"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="rating-context-", dir=ROOT / ".temp") as temp:
        for name, (source, expected, path_hint) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text(source)
            completed = subprocess.run([
                sys.executable, str(HELPER), "--data", str(data),
                "--realm", REALM, "--context", CONTEXT, "--question", QUESTION,
                "--jena-home", str(args.jena_home), "--java-home", str(args.java_home),
                "--temp-root", temp,
            ], cwd=ROOT, capture_output=True, text=True)
            assert completed.returncode == (0 if expected else 1), (
                name, completed.stdout, completed.stderr)
            report = json.loads(completed.stdout)
            assert report["conforms"] is expected, (name, report)
            if path_hint:
                assert "sh:resultPath" in report["report"] and path_hint in report["report"], (
                    name, report)
            outcomes[name] = {"conforms": report["conforms"],
                              "exit_code": completed.returncode}
    print(json.dumps({"cases": ["MODEL15-realm-standing-rating-context",
                                "MODEL17-explicit-realm-context-focus"],
                      "profile_sha256": report["profile_sha256"],
                      "jena_shacl": report["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
