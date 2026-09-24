#!/usr/bin/env python3
"""Exercise the fixed Realm-local rejection profile with Jena SHACL."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_realm_local_rejection.py"
IDS = [f"https://rezics.com/id/019cb49e-0ea2-7000-8000-{i:012d}" for i in range(1, 5)]
REJECTION, REALM, WORK, MAIN = IDS
SLOT = "urn:rezics:realm-selection:" + "a" * 64
REVIEW = "https://rezics.com/definition/realm-manager-reviewed-v1"
POLICY = "https://rezics.com/definition/realm-manager-fixed-main-fallback-v1"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    common = (f"rv:context <{REALM}> ; rv:slot <{SLOT}> ; rv:work <{WORK}> ; "
              f"rv:mainVersion <{MAIN}> ; rv:reasonCode rv:NotApproved ; "
              f"rv:selectionPolicy <{POLICY}> ; rv:reviewPolicy <{REVIEW}> ; "
              "rv:outcome rv:Rejected ; ")
    cases = {
        "valid": ("a rv:RealmPublicationRejection ; " + common
                  + "rv:decisionBasis rv:RealmManagerReview", True, None),
        "missing-slot": ("a rv:RealmPublicationRejection ; "
                         + common.replace(f"rv:slot <{SLOT}> ; ", "")
                         + "rv:decisionBasis rv:RealmManagerReview", False, "rv:slot"),
        "wrong-basis": ("a rv:RealmPublicationRejection ; " + common
                        + "rv:decisionBasis rv:MainMaintainer", False, "rv:decisionBasis"),
        "missing-type": (common + "rv:decisionBasis rv:RealmManagerReview",
                         False, "rdf:type"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="realm-rejection-", dir=ROOT / ".temp") as temp:
        for name, (properties, expected, path) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text("@prefix rv: <https://rezics.com/vocab/> .\n"
                            + f"<{REJECTION}> {properties} .\n")
            completed = subprocess.run([
                sys.executable, str(HELPER), "--data", str(data),
                "--rejection", REJECTION, "--jena-home", str(args.jena_home),
                "--java-home", str(args.java_home), "--temp-root", temp,
            ], cwd=ROOT, capture_output=True, text=True)
            assert completed.returncode == (0 if expected else 1), (name, completed.stdout, completed.stderr)
            result = json.loads(completed.stdout)
            assert result["conforms"] is expected, (name, result)
            if path:
                assert "sh:resultPath" in result["report"] and path in result["report"], (name, result)
            outcomes[name] = {"conforms": result["conforms"], "exit_code": completed.returncode}
    print(json.dumps({"cases": ["MODEL15-realm-local-rejection-profile",
                                "MODEL17-explicit-Realm-rejection-focus"],
                      "profile_sha256": result["profile_sha256"],
                      "jena_shacl": result["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
