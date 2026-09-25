"""Extract the checksum-verified official Go archive for the local MVS oracle."""

import pathlib
import sys
import tarfile


archive = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive, "r:gz") as source:
    root = destination.resolve()
    for member in source.getmembers():
        target = (destination / member.name).resolve()
        if target != root and root not in target.parents:
            raise ValueError(f"archive path escapes destination: {member.name}")
    source.extractall(destination)
