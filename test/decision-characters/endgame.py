#!/usr/bin/env python3
"""Prepare a Plane of Earth save and restore it through the native TTY."""

import argparse
from pathlib import Path
import tempfile

from run import Terminal, prepare_playground


def check_endgame(install):
    with tempfile.TemporaryDirectory(prefix="nh-endgame-") as scratch:
        game = prepare_playground(install, Path(scratch))

        terminal = Terminal(game / "nethack", game, None)
        try:
            terminal.expect(rb"--More--")
            terminal.send(b" \x16")
            terminal.expect(rb"To what level")
            terminal.send(b"?\n")
            while True:
                page = terminal.expect(rb"([a-zA-Z]) - +earth:|\(\d+ of \d+\)")
                if page[1]:
                    terminal.send(page[1])
                    break
                terminal.send(b">")
            terminal.expect(rb"Endgame prerequisite")
            terminal.expect(rb"--More--")
            terminal.send(b" ")
            terminal.expect(rb"Earth \$")
            terminal.expect(rb"For what do you wish", advance=True)
            terminal.send(b"blessed +3 gray dragon scale mail\n")
            terminal.expect(rb"gray dragon scale mail", advance=True)
            terminal.send(b"S")
            for _ in range(16):
                prompt = terminal.expect(rb"(Really save\?)|--More--")
                if prompt[1]:
                    break
                terminal.send(b" S")
            else:
                raise AssertionError("Endgame introduction did not finish")
            terminal.send(b"y")
            terminal.expect(rb"Be seeing you", advance=True)
        finally:
            terminal.close()

        assert list((game / "save").iterdir()), "Plane of Earth save must exist"
        terminal = Terminal(game / "nethack", game, None)
        try:
            terminal.expect(rb"Restoring save file", advance=True)
            result = terminal.expect(rb"(keep the save file)|Earth \$", advance=True)
            if result[1]:
                terminal.send(b"y")
                terminal.expect(rb"Earth \$", advance=True)
            terminal.expect(rb"welcome back", advance=True)
            print("Plane of Earth generated, saved, and restored")
        finally:
            terminal.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("install", type=Path)
    check_endgame(parser.parse_args().install.resolve())
