#!/usr/bin/env python3
"""Drive an installed test build through NetHack's real TTY turn loop."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time

HERE = Path(__file__).resolve().parent
SPECIES = {
    "goblin": "goblin",
    "hobgoblin": "hobgoblin",
    "hill_orc": "hill orc",
    "mordor_orc": "mordor orc",
    "uruk_hai": "uruk-hai",
    "orc_captain": "orc-captain",
    "kobold": "kobold",
    "large_kobold": "large kobold",
    "kobold_leader": "kobold leader",
    "gnome": "gnome",
}
CONTROLS = ("unlisted", "pet", "peaceful", "flight", "melee", "blind")
PREFERENCE_FIELD = {
    "goblin": "nearby_allies",
    "hobgoblin": "target_distance",
    "hill_orc": "flank",
    "mordor_orc": "nearby_allies",
    "uruk_hai": "firing_lane",
    "orc_captain": "nearby_allies",
    "kobold": "cover",
    "large_kobold": "closes",
    "kobold_leader": "nearby_allies",
    "gnome": "narrow",
}
DIRECTIONS = {
    "n": (0, -1), "ne": (1, -1), "e": (1, 0), "se": (1, 1),
    "s": (0, 1), "sw": (-1, 1), "w": (-1, 0), "nw": (-1, -1),
}
RESULT = rb"DC_RESULT (-?\d+) (-?\d+) (\d+) (\d+) (\d+) (\d+)"


class Terminal:
    def __init__(self, executable, directory, broker=None, seeded=True):
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 100, 0, 0))
            env = {
                "PATH": os.defpath, "TERM": "xterm", "LANG": "C.UTF-8",
                "HOME": str(directory),
                "NETHACKOPTIONS": "!tutorial,!news,!tips,!autopickup,gender:male,align:neutral",
            }
            if seeded:
                env["NETHACK_DECISION_FIXTURE"] = "1"
            if broker:
                env["NETHACK_DECISION_SOCKET"] = str(broker)
            args = [
                str(executable), f"-d{directory}", "-D", "-u", "Fixture",
                "-p", "barbarian", "-r", "human",
            ]
            os.execve(executable, args, env)
        self.pending = b""

    def expect(self, pattern, timeout=12, advance=False):
        if advance:
            pattern += rb"|(?P<more>--More--)|(?P<error>Lua error:[^\x1b\r\n]*)"
        deadline = time.monotonic() + timeout
        while True:
            match = re.search(pattern, self.pending)
            if match:
                self.pending = self.pending[match.end():]
                if match.lastgroup == "error":
                    raise AssertionError(match.group().decode("utf-8", errors="replace"))
                if match.lastgroup == "more":
                    self.send(b" ")
                    continue
                return match
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.master], [], [], remaining)[0]:
                break
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                break
            if not chunk:
                break
            self.pending = (self.pending + chunk)[-32768:]
        raise AssertionError(f"Expected {pattern!r}. Recent TTY output: {self.pending[-3500:]!r}")

    def send(self, data):
        os.write(self.master, data)

    def load_lua(self, name):
        self.expect(rb"Be seeing you|Welcome to NetHack|--More--")
        self.send(b" #wizloadlua\n")
        self.expect(rb"Load which lua file\?", advance=True)
        self.send(name.encode("ascii") + b"\n")

    def close(self):
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.close(self.master)
        os.waitpid(self.pid, 0)


class FakeBroker:
    def __init__(self, path, select_choice):
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(str(path))
        self.listener.listen()
        self.listener.settimeout(0.05)
        self.select_choice = select_choice
        self.requests = []
        self.replies = []
        self.errors = []
        self.started = None
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def serve(self):
        try:
            while not self.stopping.is_set():
                try:
                    conn, _ = self.listener.accept()
                except TimeoutError:
                    continue
                with conn, conn.makefile("rb") as stream:
                    conn.settimeout(2)
                    self.started = time.monotonic()
                    request = json.loads(stream.readline(4096))
                    self.requests.append(request)
                    choice = self.select_choice(request)
                    if choice == "disconnect":
                        continue
                    if choice == "timeout":
                        self.stopping.wait(0.75)
                        continue
                    is_late = choice == "late"
                    if is_late:
                        time.sleep(0.65)
                        choice = alternate(request)
                    request_id = request["id"]
                    if choice == "stale":
                        request_id = str(int(request_id) + 1)
                        choice = alternate(request)
                    if choice == "malformed":
                        response = b"not a decision reply\n"
                    else:
                        response = (
                            f"{request_id} {request['turn']} {request['level']} "
                            f"{request['monster']} {choice}\n"
                        ).encode("ascii")
                    try:
                        conn.sendall(response)
                        acknowledgement = stream.readline(64).strip()
                    except (BrokenPipeError, ConnectionResetError):
                        if not is_late:
                            raise
                        acknowledgement = b""
                    self.replies.append((choice, acknowledgement))
        except (ValueError, OSError, KeyError) as error:
            self.errors.append(error)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stopping.set()
        self.thread.join(timeout=3)
        self.listener.close()
        if self.errors:
            raise AssertionError("Fixture broker error") from self.errors[0]


def alternate(request):
    return next(step["id"] for step in request["steps"] if step["id"] != request["native"])


def prepare_playground(source, root):
    destination = root / "game"
    shutil.copytree(source, destination)
    config = destination / "sysconf"
    contents = re.sub(r"(?m)^\s*WIZARDS\s*=.*$", "", config.read_text())
    config.write_text(contents + "\nWIZARDS=*\n")
    return destination


def run_game(install, fixture, broker=None, timeout_check=None):
    with tempfile.TemporaryDirectory(prefix="dc-game-") as temp:
        directory = prepare_playground(install, Path(temp))
        (directory / "fixture.lua").write_text(
            f"fixture = {json.dumps(fixture)}\n" + (HERE / "fixtures.lua").read_text()
        )
        terminal = Terminal(directory / "nethack", directory, broker)
        try:
            terminal.load_lua("fixture.lua")
            if fixture == "melee":
                # Being hit clears the canned wait and makes doturn read
                # the next command from the terminal.
                terminal.send(b".")
            match = terminal.expect(RESULT, advance=True)
            result = tuple(int(field) for field in match.groups()[:6])
            if timeout_check is not None:
                elapsed = time.monotonic() - timeout_check.started
                assert elapsed < 0.7, f"Timeout fallback took {elapsed:.3f} s"
                print(f"timeout fallback reached the TTY in {elapsed * 1000:.0f} ms")
            return result
        finally:
            terminal.close()


def run_scripted(install, fixtures):
    with tempfile.TemporaryDirectory(prefix="dc-ipc-") as temp:
        path = Path(temp) / "decision.sock"
        for fixture in fixtures:
            baseline = run_game(install, fixture)
            with FakeBroker(path, alternate) as broker:
                result = run_game(install, fixture, path)
            path.unlink()
            assert result[2] == 1, (fixture, "expected a single turn", result)
            if fixture in CONTROLS:
                assert not broker.requests, (fixture, "unexpected broker request")
                assert result == baseline, (fixture, result, baseline)
                if fixture == "melee":
                    assert result[:2] == (0, 0) and result[3] < 80, result
                print(f"{fixture}: native behavior")
                continue

            expected_species = SPECIES.get(fixture, "goblin")
            assert len(broker.requests) == 1, (fixture, broker.requests, result)
            request = broker.requests[0]
            assert request["species"].lower() == expected_species, request
            assert len(request["steps"]) >= 2, request
            field = PREFERENCE_FIELD.get(fixture)
            if field:
                assert len({step[field] for step in request["steps"]}) >= 2, (fixture, request)
            assert baseline[:2] == DIRECTIONS[request["native"]], (fixture, baseline, request)
            selected = alternate(request)
            assert broker.replies == [(selected, b"applied")], (fixture, broker.replies)
            assert result[:2] == DIRECTIONS[selected], (fixture, result, request)
            print(f"{fixture}: {request['native']} -> {selected} at {result[:2]}")

        if "goblin" in fixtures:
            baseline = run_game(install, "goblin")
            for failure in ("-", "malformed", "stale", "disconnect", "timeout", "late"):
                with FakeBroker(path, lambda request: failure) as broker:
                    result = run_game(
                        install, "goblin", path,
                        timeout_check=broker if failure in ("timeout", "late") else None,
                    )
                path.unlink()
                assert len(broker.requests) == 1, (failure, broker.requests)
                assert result == baseline, (failure, result, baseline)
                if failure == "late":
                    assert broker.replies == [(alternate(broker.requests[0]), b"")], broker.replies
                print(f"{failure}: native move, turn, HP, and RNG match")


def run_turn_budget(install):
    with tempfile.TemporaryDirectory(prefix="dc-budget-") as temp:
        path = Path(temp) / "decision.sock"
        with FakeBroker(path, lambda request: request["native"]) as broker:
            result = run_game(install, "crowded", path)
        path.unlink()
        requests = broker.requests
        assert result[2] == 2 and len(requests) == 2, (result, requests)
        assert requests[0]["monster"] != requests[1]["monster"], requests
        assert all(replies[1] == b"applied" for replies in broker.replies), broker.replies
        print("crowded: three fast monsters, one request per action, different actors")

        baseline = run_game(install, "repeat_wait")
        with FakeBroker(path, alternate) as broker:
            result = run_game(install, "repeat_wait", path)
        assert result[2] == 3 and result == baseline, (result, baseline)
        assert not broker.requests, broker.requests
        print("repeat_wait: three counted actions with native movement and zero requests")


def run_broker_encounter(install, fixture, path, provider):
    env = os.environ.copy()
    env.setdefault("NODE_USE_ENV_PROXY", "1")
    with subprocess.Popen(
        ["node", str(HERE / "live.mjs"), str(path), provider],
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    ) as broker:
        try:
            assert broker.stdout.readline().strip() == "READY"
            result = run_game(install, fixture, path)
            if not select.select([broker.stdout], [], [], 4)[0]:
                raise AssertionError(f"{fixture}: broker did not report an outcome")
            return result, json.loads(broker.stdout.readline())
        finally:
            broker.terminate()
            broker.wait(timeout=5)


def run_broker(install, fixtures, mock_api):
    if not mock_api and not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is required for --live")
    provider = "mock" if mock_api else "live"
    with tempfile.TemporaryDirectory(prefix="dc-live-") as temp:
        path = Path(temp) / "decision.sock"
        failures = []
        for fixture in fixtures:
            if fixture in CONTROLS:
                continue
            for _ in range(1 if mock_api else 4):
                result, event = run_broker_encounter(install, fixture, path, provider)
                if event.get("outcome") == "applied":
                    assert result[:2] == DIRECTIONS[event["selected"]], (fixture, result, event)
                    print(
                        f"{fixture}: applied {provider} API choice {event['selected']} "
                        f"in {event['latencyMs']} ms, {event['inputTokens']} input tokens"
                    )
                    break
                reason = event["reason"]
                print(f"{fixture}: {provider} API {reason} after {event['latencyMs']} ms")
                if reason != "timeout":
                    break
            if event.get("outcome") != "applied":
                failures.append(f"{fixture} ({event['reason']})")
        if failures:
            raise SystemExit("No applied choice for " + ", ".join(failures))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("install", type=Path, help="test build playground containing nethack")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true", help="request real Decisions API choices")
    mode.add_argument("--mock-api", action="store_true",
                      help="use the real broker with simulated API replies")
    mode.add_argument("--turn-budget", action="store_true", help="run crowded and repeat fixtures")
    parser.add_argument("--fixture", choices=(*SPECIES, *CONTROLS, "polymorph"))
    args = parser.parse_args()
    fixtures = [args.fixture] if args.fixture else [*SPECIES, *CONTROLS, "polymorph"]
    install = args.install.resolve()
    if not (install / "nethack").is_file():
        parser.error(f"No nethack executable in {install}")
    if args.live or args.mock_api:
        run_broker(install, fixtures, args.mock_api)
    elif args.turn_budget:
        run_turn_budget(install)
    else:
        run_scripted(install, fixtures)
        if not args.fixture:
            run_turn_budget(install)


if __name__ == "__main__":
    main()
