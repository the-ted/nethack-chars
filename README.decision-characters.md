# NetHack with decision-characters

This fork of NetHack 5.0.0 runs in your terminal and uses OpenAI Decisions to choose legal moves for ten existing monster species. It is based on upstream commit `16ff59115315917b93185d026aeefea06db9b0f4`. [Upstream license](dat/license) · [Implementation plan](PLAN.md)

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
| `NETHACK_DECISIONS=off` | Play with native monster movement even if a key is present. |
| `NETHACK_DECISION_LOG=1` | Append decision outcomes, latency, fallback reasons, and token usage to `decisions.log` in the playground. |
| `NETHACK_ASSETS`, `NETHACK_BIN` | Override the installed game data directory or executable. |

The broker runs for the lifetime of the game. It accepts requests from the game over a private Unix socket. An eligible player action can trigger at most one request and adds at most 500 ms of engine wait. If a choice is unavailable, the monster uses its normal move.

## Validate

```sh
node --test test/decision-characters/broker.test.mjs
./scripts/build --test
python3 test/decision-characters/run.py build/test/games/lib/nethackdir
python3 test/decision-characters/run.py build/test/games/lib/nethackdir --mock-api
python3 test/decision-characters/upstream.py build/test/games/lib/nethackdir
python3 test/decision-characters/endgame.py build/test/games/lib/nethackdir
```

The native fixtures check all ten species, polymorph, movement legality, and fallback. The endgame test creates and restores a Plane of Earth save. To exercise live choices, set `OPENAI_API_KEY` and pass `--live` to `run.py`. If the build reports a Lua checksum mismatch, remove the damaged `build/deps/lua-5.4.8.tar.gz` and rebuild to download and verify a fresh copy.
