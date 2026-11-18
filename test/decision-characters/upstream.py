#!/usr/bin/env python3
"""Run the release's nine wizard Lua test scripts on a disposable playground."""

import argparse
import json
from pathlib import Path
import tempfile

from run import Terminal, prepare_playground

HERE = Path(__file__).resolve().parent


def supply_level_loader(install, source):
    # NetHack 5.0.0's wizard sandbox lacks require. Give the upstream suite
    # access only to the installed Lua chunks, without opening filesystem I/O.
    modules = ["local levels = {}"]
    for level in sorted(install.glob("*.lua")):
        name = json.dumps(level.stem)
        modules.append(f"levels[{name}] = function()\n{level.read_text()}\nend")
    modules.append("local function require(name) return assert(levels[name])() end")
    return "\n".join(modules) + "\n" + source


def run_upstream(install, case):
    with tempfile.TemporaryDirectory(prefix="dc-upstream-") as temp:
        directory = prepare_playground(install, Path(temp))
        source = case.read_text()
        if case.name == "testwish.lua":
            # This release's last line calls the old unqualified Lua alias.
            source = "local pline = nh.pline\n" + source
        elif case.name == "test_lev.lua":
            source = supply_level_loader(directory, source)
        (directory / "suite.lua").write_text(source + '\nnh.pline("DC_UPSTREAM_OK", true)\n')
        terminal = Terminal(directory / "nethack", directory)
        try:
            terminal.load_lua("suite.lua")
            terminal.expect(rb"DC_UPSTREAM_OK", timeout=30, advance=True)
        finally:
            terminal.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("install", type=Path)
    parser.add_argument("--suite", help="run a single upstream filename")
    args = parser.parse_args()
    cases = sorted(HERE.parent.glob("test*.lua"))
    if args.suite:
        cases = [case for case in cases if case.name == args.suite]
    if not cases:
        parser.error("No matching upstream tests")
    failures = []
    for case in cases:
        try:
            run_upstream(args.install.resolve(), case)
            print(f"{case.name}: passed", flush=True)
        except AssertionError as exc:
            failures.append(case.name)
            print(f"{case.name}: {exc}", flush=True)
    if failures:
        raise SystemExit("Failed upstream tests: " + ", ".join(failures))


if __name__ == "__main__":
    main()
