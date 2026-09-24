#!/usr/bin/env python3
"""Exercise the fixed Main Version default selection profile with Jena SHACL."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_main_default_selection.py"
IDS = [f"https://rezics.com/id/019cb49e-0ea2-7000-8000-{i:012d}" for i in range(1, 6)]
SELECTION, MAIN, WORK, CONTRIBUTION, DECISION = IDS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    common = (f"rv:context <{MAIN}> ; rv:work <{WORK}> ; rv:mainVersion <{MAIN}> ; "
              f"rv:contribution <{CONTRIBUTION}> ; rv:publicationDecision <{DECISION}> ; "
              f"rv:selectedDraft <{DECISION}> ; ")
    cases = {
        "valid": ("a rv:PublicationSelection ; " + common
                  + "rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed", True, None),
        "missing-decision": ("a rv:PublicationSelection ; "
                             + common.replace(f"rv:publicationDecision <{DECISION}> ; ", "")
                             + "rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed",
                             False, "rv:publicationDecision"),
        "wrong-basis": ("a rv:PublicationSelection ; " + common
                        + "rv:selectionBasis rv:Unknown ; rv:selectionMode rv:Fixed",
                        False, "rv:selectionBasis"),
        "missing-type": (common
                         + "rv:selectionBasis rv:MainMaintainer ; rv:selectionMode rv:Fixed",
                         False, "rdf:type"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="main-selection-", dir=ROOT / ".temp") as temp:
        for name, (properties, expected, path) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text("@prefix rv: <https://rezics.com/vocab/> .\n"
                            + f"<{SELECTION}> {properties} .\n")
            completed = subprocess.run([
                sys.executable, str(HELPER), "--data", str(data),
                "--selection", SELECTION, "--jena-home", str(args.jena_home),
                "--java-home", str(args.java_home), "--temp-root", temp,
            ], cwd=ROOT, capture_output=True, text=True)
            assert completed.returncode == (0 if expected else 1), (name, completed.stdout, completed.stderr)
            result = json.loads(completed.stdout)
            assert result["conforms"] is expected, (name, result)
            if path:
                assert "sh:resultPath" in result["report"] and path in result["report"], (name, result)
            outcomes[name] = {"conforms": result["conforms"], "exit_code": completed.returncode}
    print(json.dumps({"cases": ["MODEL15-main-default-selection-profile",
                                "MODEL17-explicit-selection-focus"],
                      "profile_sha256": result["profile_sha256"],
                      "jena_shacl": result["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
