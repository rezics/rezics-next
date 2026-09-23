#!/usr/bin/env python3
"""Exercise the fixed draft Contribution profile with pinned Jena SHACL."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "model/tools/validate_text_contribution.py"
CONTRIBUTION = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000001"
WORK = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000002"
AUTHOR = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000003"
REVISION = "https://rezics.com/id/019cb49e-0ea2-7000-8000-000000000004"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jena-home", type=Path, required=True)
    parser.add_argument("--java-home", type=Path, required=True)
    args = parser.parse_args()
    cases = {
        "valid": ("a rv:TextContribution ; rv:work <" + WORK + "> ; rv:author <" + AUTHOR
                  + "> ; rv:language \"en\" ; rv:draftHead <" + REVISION + ">", True, None),
        "missing-author": ("a rv:TextContribution ; rv:work <" + WORK
                           + "> ; rv:language \"en\" ; rv:draftHead <" + REVISION + ">", False, "rv:author"),
        "missing-type": ("rv:work <" + WORK + "> ; rv:author <" + AUTHOR
                         + "> ; rv:language \"en\" ; rv:draftHead <" + REVISION + ">", False, "rdf:type"),
    }
    outcomes = {}
    (ROOT / ".temp").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="text-contribution-", dir=ROOT / ".temp") as temp:
        for name, (properties, expected, path) in cases.items():
            data = Path(temp) / f"{name}.ttl"
            data.write_text("@prefix rv: <https://rezics.com/vocab/> .\n"
                            + f"<{CONTRIBUTION}> {properties} .\n")
            completed = subprocess.run([
                sys.executable, str(HELPER), "--data", str(data),
                "--contribution", CONTRIBUTION, "--jena-home", str(args.jena_home),
                "--java-home", str(args.java_home), "--temp-root", temp,
            ], cwd=ROOT, capture_output=True, text=True)
            assert completed.returncode == (0 if expected else 1), (name, completed.stdout, completed.stderr)
            result = json.loads(completed.stdout)
            assert result["conforms"] is expected, (name, result)
            if path:
                assert "sh:resultPath" in result["report"] and path in result["report"], (name, result)
            outcomes[name] = {"conforms": result["conforms"], "exit_code": completed.returncode}
    print(json.dumps({"cases": ["MODEL15-fixed-text-contribution-profile",
                                "MODEL17-explicit-contribution-focus"],
                      "profile_sha256": result["profile_sha256"],
                      "jena_shacl": result["jena_shacl"], "outcomes": outcomes,
                      "result": "pass"}, indent=2))


if __name__ == "__main__":
    main()
