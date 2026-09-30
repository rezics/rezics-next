# SPDX-License-Identifier: Apache-2.0
# Literal script authored for this fixture from Jane Austen's public-domain novel.
label start:
    "It is a truth universally acknowledged."
    python:
        raise RuntimeError("THIS MUST NEVER EXECUTE")
        "This is Python, not dialogue."
    menu:
        "Visit the Bennets":
            elizabeth "I could easily forgive his pride, if he had not mortified mine."
            jump visit
            "Unreachable after jump."
        "Stay at home" if staying:
            get_speaker() "It is a truth universally acknowledged."
            jump home
label visit:
    "It is a truth universally acknowledged."
label home:
    "It is a truth universally acknowledged."
