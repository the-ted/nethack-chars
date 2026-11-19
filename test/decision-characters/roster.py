#!/usr/bin/env python3
"""Exercise every configured form through the wizard TTY and the production broker."""

import argparse
import json
import os
from pathlib import Path
import tempfile

from run import DIRECTIONS, check_catalog, run_broker_encounter

AQUATIC = {"PM_JELLYFISH", "PM_SHARK", "PM_GIANT_EEL", "PM_ELECTRIC_EEL", "PM_KRAKEN"}
NATURAL_FORM = {
    "PM_SMALL_MIMIC", "PM_LARGE_MIMIC", "PM_GIANT_MIMIC",
    "PM_CHAMELEON", "PM_DOPPELGANGER", "PM_VAMPIRE", "PM_VAMPIRE_LEADER",
    "PM_HUMAN_WERERAT", "PM_HUMAN_WEREJACKAL", "PM_HUMAN_WEREWOLF",
}


def encounter(install, path, pm, name, wire, live):
    mode = "natural form" if pm in NATURAL_FORM else "normal"
    pool = "true" if pm in AQUATIC else "false"
    # Stand off the disintegration line during live testing to keep the hero alive.
    y = 11 if live and pm == "PM_BLACK_DRAGON" else 10
    turns = 1 if live else 2
    setup = (f"roster_encounter = {{species={json.dumps(name)}, mode={json.dumps(mode)}, "
             f"pool={pool}, target={{14,{y}}}, turns={turns}}}")
    result, events = run_broker_encounter(install, "roster", path, "live" if live else "mock", setup)
    assert len(events) == turns and result[2] == turns, (result, events)
    for event in events:
        assert event["species"] == wire and event["requested"], event
        if event["outcome"] != "applied":
            raise RuntimeError(event["reason"] or event["outcome"])
    chosen = events[-1]["selected"]
    if not live:
        assert events[0]["selected"] == "wait" and chosen in DIRECTIONS, events
    if chosen in DIRECTIONS:
        assert result[:2] == DIRECTIONS[chosen], (chosen, result)
    return chosen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("install", type=Path, help="fixture-enabled NetHack playground")
    parser.add_argument("--live", action="store_true", help="one real API decision per form")
    parser.add_argument("--species", action="append", metavar="PM_ID", help="limit to selected forms")
    args = parser.parse_args()
    install = args.install.resolve()
    forms = check_catalog(install / "nethack")
    if args.live and not os.getenv("OPENAI_API_KEY"):
        parser.error("--live requires OPENAI_API_KEY")
    if args.species:
        missing = set(args.species) - {row[0] for row in forms}
        if missing:
            parser.error("Unconfigured species: " + ", ".join(sorted(missing)))
        forms = [row for row in forms if row[0] in args.species]
    failures = []
    with tempfile.TemporaryDirectory(prefix="dc-roster-") as directory:
        path = Path(directory) / "s"
        for pm, name, wire in forms:
            try:
                chosen = encounter(install, path, pm, name, wire, args.live)
                print(f"{pm} applied {chosen}", flush=True)
            except (AssertionError, RuntimeError) as error:
                print(f"{pm} failed: {error!s}", flush=True)
                failures.append(pm)
                if str(error) in ("authentication", "rate_limited"):
                    break
    if failures:
        raise SystemExit("Failed encounters: " + ", ".join(failures))
    print(f"Verified {len(forms)} forms using {'live' if args.live else 'simulated'} API replies.")


if __name__ == "__main__":
    main()
