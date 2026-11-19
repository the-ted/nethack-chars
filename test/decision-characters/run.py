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
ACTIONS = ("breath", "off_axis", "gaze", "spit", "passive", "melee", "items", "archer", "wand", "pickup", "door", "armor", "wield", "utility", "cure", "native_history", "memory", "last_dart", "bow", "escape")
CONTROLS = ("unlisted", "unlisted_shifter", "pet", "peaceful", "flight", "blind")
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
    def __init__(self, executable, directory, broker=None, seeded=True, timeout_ms=None):
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 100, 0, 0))
            env = {
                "PATH": os.defpath, "TERM": "xterm", "LANG": "C.UTF-8",
                "HOME": str(directory),
                "NETHACKOPTIONS": "!tutorial,!news,!tips,!autopickup,gender:male,align:neutral",
            }
            if timeout_ms is not None:
                env["NETHACK_DECISION_TIMEOUT_MS"] = timeout_ms
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

    def expect(self, pattern, timeout=12, advance=False, idle_key=None):
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
            if remaining <= 0:
                break
            wait = min(remaining, 0.75) if idle_key else remaining
            if not select.select([self.master], [], [], wait)[0]:
                if idle_key:
                    self.send(idle_key)
                    continue
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
                    request = json.loads(stream.readline(32768))
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
        except (ValueError, OSError, KeyError, StopIteration) as error:
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
    return next(a["id"] for a in request["actions"] if a["id"] in DIRECTIONS)


def prepare_playground(source, root):
    destination = root / "game"
    shutil.copytree(source, destination)
    config = destination / "sysconf"
    contents = re.sub(r"(?m)^\s*WIZARDS\s*=.*$", "", config.read_text())
    config.write_text(contents + "\nWIZARDS=*\n")
    return destination


def run_game(install, fixture, broker=None, timeout_check=None, setup="", timeout_ms=None):
    with tempfile.TemporaryDirectory(prefix="dc-game-") as temp:
        directory = prepare_playground(install, Path(temp))
        (directory / "fixture.lua").write_text(
            f"fixture = {json.dumps(fixture)}\n{setup}\n" + (HERE / "fixtures.lua").read_text()
        )
        terminal = Terminal(directory / "nethack", directory, broker, timeout_ms=timeout_ms)
        try:
            terminal.load_lua("fixture.lua")
            # Combat may discard a canned wait and pause Lua for a TTY command.
            combat = fixture in ("roster", "breath", "gaze", "spit", "passive", "melee", "items", "archer", "wand", "last_dart", "bow")
            match = terminal.expect(RESULT, advance=True, idle_key=b"." if combat else None)
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
                print(f"{fixture}: native behavior")
                continue

            expected_species = SPECIES.get(fixture, "goblin")
            assert len(broker.requests) == 1, (fixture, broker.requests, result)
            request = broker.requests[0]
            assert request["species"].lower() == expected_species, request
            steps = [a for a in request["actions"] if a["id"] in DIRECTIONS]
            assert len(steps) >= 2 and request["version"] == 2, request
            assert {"wait", "native"} <= {a["id"] for a in request["actions"]}, request
            assert request["hp"] <= request["max_hp"] and request["history"] == [], request
            field = PREFERENCE_FIELD.get(fixture)
            if field:
                assert len({step[field] for step in steps}) >= 2, (fixture, request)
            selected = alternate(request)
            assert broker.replies == [(selected, b"applied")], (fixture, broker.replies)
            assert result[:2] == DIRECTIONS[selected], (fixture, result, request)
            print(f"{fixture}: selected {selected} at {result[:2]}")

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
            with FakeBroker(path, lambda request: "late") as broker:
                result = run_game(install, "goblin", path, timeout_ms="1500")
            direction = alternate(broker.requests[0])
            assert broker.replies == [(direction, b"applied")] and result[:2] == DIRECTIONS[direction]
            print("extended timeout: late choice applied within the configured budget")


def run_action_fixture(install, fixture):
    def pick(r):
        if fixture in ("off_axis", "passive"):
            return "wait"
        if fixture in ("breath", "gaze", "spit"):
            return "ranged" if len(broker.requests) == 1 else "wait"
        if fixture == "escape":
            return next(a["id"] for a in r["actions"] if a["action"] == "enter teleport trap")
        if fixture == "bow":
            kind = ["wield", "ranged", "wait"][len(broker.requests) - 1]
            return next(a["id"] for a in r["actions"] if a["id"].split("_")[0] == kind)
        if fixture == "memory":
            return "wait"
        if fixture == "melee":
            return "melee"
        if fixture == "door":
            return next(a["id"] for a in r["actions"] if a["action"] == "pass door")
        if len(broker.requests) > 1:
            return "wait"
        if fixture == "native_history":
            return "native"
        kind, item = {
            "items": ("defense", "healing"), "archer": ("ranged", "dart"), "last_dart": ("ranged", "dart"),
            "wand": ("offense", "striking"), "pickup": ("pickup", "dagger"),
            "armor": ("wear", "leather gloves"), "wield": ("wield", "orcish dagger"),
            "cure": ("defense", "unicorn horn"), "utility": ("misc", "speed"),
        }[fixture]
        return next(a["id"] for a in r["actions"] if a["id"].startswith(kind + "_")
                    and a.get("item", {}).get("type") == item)

    with tempfile.TemporaryDirectory(prefix="dc-actions-") as temp:
        path = Path(temp) / "d.sock"
        with FakeBroker(path, pick) as broker:
            result = run_game(install, fixture, path)
        first = broker.requests[0]
        assert all(ack == b"applied" for _, ack in broker.replies), broker.replies
        if fixture == "melee":
            assert result[2] == 1 and result[:2] == (0, 0) and result[3] < 80, result
        elif fixture == "breath":
            assert result[2] == 1 and len(broker.requests) == 1 and first["ranged"], result
            assert any(a.get("firing_lane") for a in first["actions"])
            assert any(a["id"].startswith("ranged_") for a in first["actions"])
        elif fixture == "door":
            assert result[:2] == (0, -1), result
        elif fixture == "bow":
            assert len(broker.requests) == 3 and result[2] == 3, result
            assert not any(a["id"].startswith("ranged_") for a in first["actions"])
            arrows = lambda r: next(v["quantity"] for v in r["inventory"] if v["item"]["type"] == "orcish arrow")
            assert arrows(broker.requests[2]) < arrows(first)
            assert [e["action"] for e in broker.requests[2]["history"]] == ["wield", "shoot or throw"]
        elif fixture == "escape":
            assert result[:2] == (10, 0), result
        elif fixture == "memory":
            assert len(broker.requests) == 10 and result[2] == 10, result
            for i, r in enumerate(broker.requests):
                expected = broker.requests[max(0, i-8):i]
                assert [e["turn"] for e in r["history"]] == [e["turn"] for e in expected]
                assert all(e["action"] == "wait" for e in r["history"])
        elif fixture == "armor":
            assert result[:2] == (0, 0) and len(broker.replies) == 1, result
        else:
            assert len(broker.requests) == 2, (fixture, result, broker.requests)
            second = broker.requests[1]
            assert first["monster"] == second["monster"] and first["history"] == [], first
            last = second["history"][-1]
            assert last["turn"] == first["turn"] and last["level"] == first["level"], last
            def quantity(r, name):
                return sum(v["quantity"] for v in r["inventory"] if v["item"]["type"] == name)
            if fixture in ("gaze", "spit", "off_axis"):
                assert first["ranged"] and any(a.get("firing_lane") for a in first["actions"]), first
                if fixture == "off_axis":
                    assert not any(a["id"] == "ranged" for a in first["actions"]), first
                else:
                    assert last["action"] == "attempt " + fixture, second
            elif fixture == "passive":
                assert "melee" not in {a["id"] for a in first["actions"]}, first
                assert not first["ranged"] and last["action"] == "wait", second
            elif fixture == "items":
                options = {(a["id"].split("_")[0], a.get("item", {}).get("type"))
                           for a in first["actions"]}
                assert {("defense", "healing"), ("defense", "extra healing"), ("misc", "speed")} <= options
                assert second["hp"] > first["hp"] and last["action"] == "defensive", second
                assert quantity(second, "healing") == 0 and quantity(second, "extra healing") == 1
            elif fixture in ("archer", "last_dart"):
                if fixture == "last_dart":
                    assert quantity(second, "dart") == 0 and quantity(second, "orcish dagger") == 1
                    assert len(second["history"]) == 1, second["history"]
                assert last["action"] == "shoot or throw" and quantity(second, "dart") < quantity(first, "dart")
            elif fixture == "cure":
                assert first["status"]["blind"] and first["target"] is None, first
                assert not first["characters"] and not first["floor"], first
                assert last["action"] == "defensive" and not second["status"]["blind"], second
            elif fixture == "native_history":
                assert last["action"] == "move" and (last["x"], last["y"]) == (second["x"], second["y"])
            elif fixture == "wield":
                assert last["action"] == "wield" and last["item"]["type"] == "orcish dagger", last
                assert any(v["equipped"] and v["item"]["type"] == "orcish dagger" for v in second["inventory"])
            elif fixture == "utility":
                assert last["action"] == "misc" and quantity(second, "speed") == 0, second
            elif fixture == "wand":
                assert first["inventory"][0]["charges"] == second["inventory"][0]["charges"] + 1
                assert last["action"] == "offensive" and last["item"]["type"] == "striking", last
            elif fixture == "pickup":
                assert last["action"] == "pick up" and quantity(second, "dagger") == 1, second
                assert any(v["x"] == first["x"] and v["y"] == first["y"] for v in first["floor"])
                assert first["characters"][0]["species"] == "goblin"
                assert first["characters"][0]["x"] == 9 and first["characters"][0]["y"] == 8
                assert len(first["characters"]) == 1, first
        print(f"{fixture}: applied {broker.replies[0][0]}")

def run_turn_budget(install):
    with tempfile.TemporaryDirectory(prefix="dc-budget-") as temp:
        path = Path(temp) / "decision.sock"
        with FakeBroker(path, lambda request: "wait") as broker:
            result = run_game(install, "crowded", path)
        path.unlink()
        requests = broker.requests
        assert result[2] == 2 and len(requests) == 2, (result, requests)
        assert requests[0]["monster"] != requests[1]["monster"], requests
        assert all(e["action"] != "wait" for e in requests[1]["history"]), requests
        assert all(replies[1] == b"applied" for replies in broker.replies), broker.replies
        print("crowded: three fast monsters, one request per action, different actors")

        baseline = run_game(install, "repeat_wait")
        with FakeBroker(path, alternate) as broker:
            result = run_game(install, "repeat_wait", path)
        assert result[2] == 3 and result == baseline, (result, baseline)
        assert not broker.requests, broker.requests
        print("repeat_wait: three counted actions with native movement and zero requests")


def run_broker_encounter(install, fixture, path, provider, setup=""):
    env = os.environ.copy()
    env.setdefault("NODE_USE_ENV_PROXY", "1")
    with subprocess.Popen(
        ["node", str(HERE / "live.mjs"), str(path), provider, fixture],
        env=env,
        stdout=subprocess.PIPE,
        text=True,
    ) as broker:
        try:
            assert broker.stdout.readline().strip() == "READY"
            result = run_game(install, fixture, path, setup=setup, timeout_ms=env.get("NETHACK_DECISION_TIMEOUT_MS"))
            if not select.select([broker.stdout], [], [], 4)[0]:
                raise AssertionError(f"{fixture}: broker did not report an outcome")
            broker.terminate()
            output, _ = broker.communicate(timeout=5)
            events = [json.loads(line) for line in output.splitlines()]
            if provider == "mock" and fixture == "items":
                assert [(e["selected"], e["outcome"]) for e in events[1:]] == [("wait", "applied")], events
                assert events[0]["item"]["type"] == "healing" and result[4] > 6, (result, events)
            return result, events
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
                result, events = run_broker_encounter(install, fixture, path, provider)
                event = events[0]
                if event.get("outcome") == "applied":
                    if result[2] == 1 and event["selected"] in DIRECTIONS:
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


def check_catalog(executable):
    root = Path(__file__).resolve().parents[2]
    enums = subprocess.check_output([executable, "--dumpenums"], text=True)
    compiled = set(re.findall(r"^\s*(PM_[A-Z0-9_]+)\s*=", enums, re.MULTILINE))
    config = (root / "include/decision_prompts.conf").read_text()
    names = dict(re.findall(r'^\s*DECISION_SPECIES\(\s*(PM_[A-Z0-9_]+)\s*,\s*"([^"]+)"',
                            config, re.MULTILINE))
    forms = []
    rows = {}
    for line in (root / "addressable-monsters.txt").read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        status, pm, name, evidence, reason = line.split("\t")
        assert pm not in rows, f"Duplicate catalog row for {pm}"
        assert status in ("enabled", "candidate", "conditional", "native-only"), (pm, status)
        assert name and evidence and reason, f"Incomplete catalog row for {pm}"
        rows[pm] = status
        if status == "enabled" and pm in names:
            forms.append((pm, name, names[pm]))
    assert compiled and compiled == set(rows), f"Catalog/engine mismatch: {compiled ^ set(rows)}"
    listed = {pm for pm, status in rows.items() if status == "enabled"}
    assert set(names) == listed, f"Catalog/config mismatch: {set(names) ^ listed}"
    print(f"catalog: {len(rows)} compiled forms, {len(forms)} configured")
    return forms


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("install", type=Path, help="test build playground containing nethack")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true", help="request real Decisions API choices")
    mode.add_argument("--mock-api", action="store_true",
                      help="use the real broker with simulated API replies")
    mode.add_argument("--turn-budget", action="store_true", help="run crowded and repeat fixtures")
    parser.add_argument("--fixture", choices=(*SPECIES, *CONTROLS, *ACTIONS, "polymorph", "enabled_shifter"))
    args = parser.parse_args()
    fixtures = [args.fixture] if args.fixture else [*SPECIES, *CONTROLS, "polymorph", "enabled_shifter"]
    install = args.install.resolve()
    if not (install / "nethack").is_file():
        parser.error(f"No nethack executable in {install}")
    if not args.fixture:
        check_catalog(install / "nethack")
    if args.live or args.mock_api:
        if args.mock_api and not args.fixture:
            fixtures += ["melee", "items"]
        run_broker(install, fixtures, args.mock_api)
    elif args.turn_budget:
        run_turn_budget(install)
    else:
        run_scripted(install, [f for f in fixtures if f not in ACTIONS])
        for fixture in ACTIONS:
            if args.fixture and args.fixture != fixture:
                continue
            run_action_fixture(install, fixture)
        if not args.fixture:
            run_turn_budget(install)


if __name__ == "__main__":
    main()
