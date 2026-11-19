# NetHack with decision-characters

This fork of NetHack 5.0.0 runs in your terminal and uses OpenAI Decisions to choose combat, equipment, item use, and movement for 281 existing monster forms. It is based on upstream commit `16ff59115315917b93185d026aeefea06db9b0f4`. [Upstream license](dat/license) · [Developer guide](doc/decision-characters.md)

Edit the shared instructions and each enabled monster’s tactics in the [prompt config](include/decision_prompts.conf). To choose another species, consult the [monster expansion catalog](addressable-monsters.txt).

## Build and play

- **macOS** uses the compiler, make, and ncurses supplied by the Xcode Command Line Tools. Run `xcode-select --install` if you need them.
- **Linux** needs a C compiler, GNU make, ncurses and terminfo development files, gzip, curl, tar, and a SHA-256 utility. On Debian, install `build-essential libncurses-dev gzip curl`.
- **Model decisions** use Node.js 24 and `OPENAI_API_KEY` in your shell environment. On a Mac with Homebrew, install `node@24` and add it to your path with `export PATH="$(brew --prefix node@24)/bin:$PATH"`. Node has no package dependencies to install. Without a key, NetHack uses its native monster behavior and requires only the native toolchain.

From the repository root run:

```sh
./scripts/play
```

The first launch builds NetHack, verifies the Lua source archive against the upstream checksum, and starts the game in the current terminal. The launcher passes normal NetHack arguments through. For example, `./scripts/play -u Elin` starts or restores Elin, and `./scripts/play -s` shows scores. Press `?` for help and uppercase `S` to save.

Run `./scripts/build` after editing the native sources. It installs the executable and game data in `build/terminal/games/lib/nethackdir`. Saves and scores live in `build/terminal-state` by default and survive rebuilds. Set `NETHACKDIR` to choose a different playground.

If you have saves from the former browser interface, each player’s files are under `build/web-state/<session-id>/save` in the checkout where you played. You can use that player’s directory as `NETHACKDIR` and launch with the original character name.

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Starts the local broker, which sends choices to `gpt-6-luna` at `https://api.openai.com/v1/decisions`. |
| `NETHACK_DECISIONS=off` | Play with native monster behavior even if a key is present. |
| `NETHACK_DECISION_TIMEOUT_MS` | Total wait per eligible turn, in milliseconds. Default 500. Set a whole number from 500 to 10000 if your API calls need longer. |
| `NETHACK_DECISION_LOG=1` | Append decision outcomes, latency, fallback reasons, and token usage to `decisions.log` in the playground. |
| `NETHACK_DECISION_LOG=requests` | Include the outgoing Decisions API request body alongside each outcome in `decisions.log`. |
| `NETHACK_ASSETS`, `NETHACK_BIN` | Override the installed game data directory or executable. |

The broker runs for the lifetime of the game. It accepts requests from the game over a private Unix socket. An eligible player action can trigger at most one request and adds at most the configured wait (500 ms by default). If a choice is unavailable, the monster takes its normal turn.

## Try a decision in wizard mode

After updating an existing checkout, rebuild the executable and start with logging enabled.

```sh
./scripts/build
NETHACK_DECISION_LOG=1 ./scripts/play -D
```

Use `#wizgenesis` to create a hostile **hill orc** in a lit room. When the orc is adjacent, press `m` followed by `.` to wait one turn despite the danger. From another terminal in the checkout, follow the log.

```sh
tail -f "${NETHACKDIR:-$PWD/build/terminal-state}/decisions.log"
```

An event with `"requested":true` and `"outcome":"applied"` means the engine accepted the model's choice. Read `action` for the maneuver and `item` for the object when present. A melee attack can miss. A fallback event includes its reason. The generic species named `orc` uses native NetHack behavior. [All supported species and action families](doc/decision-characters.md)

To see what the model receives, start the game with `NETHACK_DECISION_LOG=requests ./scripts/play`. Each outgoing attempt adds a JSON line with `type` set to `request`. Its `body` contains the model, instructions, game state, history, and offered choices. Match its `id` with the outcome in the same session, including when the API times out. Credentials and HTTP headers are omitted. To follow just the request bodies from another terminal with `jq` installed, run

```sh
tail -n 0 -f "${NETHACKDIR:-$PWD/build/terminal-state}/decisions.log" | jq --unbuffered 'select(.type == "request") | .body'
```

## Validate

```sh
node --test test/decision-characters/broker.test.mjs
./scripts/build --test
python3 test/decision-characters/run.py build/test/games/lib/nethackdir
python3 test/decision-characters/run.py build/test/games/lib/nethackdir --mock-api
python3 test/decision-characters/roster.py build/test/games/lib/nethackdir
python3 test/decision-characters/upstream.py build/test/games/lib/nethackdir
python3 test/decision-characters/endgame.py build/test/games/lib/nethackdir
```

The roster test plays two turns for each enabled form with the real broker and simulated API replies. It checks the form, prompt, previous action, turn count, and final position. To test a single form against the live service, run the following with your API key set. Omit `--species PM_RED_DRAGON` to make one live decision per enabled form.

```sh
NETHACK_DECISION_TIMEOUT_MS=5000 python3 test/decision-characters/roster.py build/test/games/lib/nethackdir --live --species PM_RED_DRAGON
```

The native fixtures also exercise polymorph, passive attacks, breath, gaze, spit, melee, item consumption, pickup, equipment, doors, and fallback. The endgame test creates and restores a Plane of Earth save. To exercise live choices, set `OPENAI_API_KEY` and pass `--live` to `run.py`. If the build reports a Lua checksum mismatch, remove the damaged `build/deps/lua-5.4.8.tar.gz` and rebuild to download and verify a fresh copy.
