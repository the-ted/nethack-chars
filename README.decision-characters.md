# NetHack with decision-characters

This fork adds model-guided tactics to NetHack 5.0.0 and serves the native TTY game in a browser. It is based on upstream commit `16ff59115315917b93185d026aeefea06db9b0f4`. The fork source includes the original game, its data and the corresponding build scripts. See [the upstream license](dat/license) and [the implementation plan](PLAN.md).

## Build and play

Use Linux with GCC, GNU make, ncurses/terminfo development files, gzip, curl, tar, sha256sum, Python 3 and Node.js 24 with npm. The cloud build used Debian 13.6, GCC 14.2.0, GNU make 4.4.1, ncurses 6.5, Lua 5.4.8 and Node 24.22.1. On Debian, `build-essential libncurses-dev gzip curl python3` cover the native dependencies.

From the repository root, run:

```sh
./scripts/play-browser
```

Open **http://127.0.0.1:8080**. The first launch builds NetHack and installs the locked browser dependencies. Arrow keys and normal NetHack commands work in the terminal. Press `?` for in-game help, `i` for inventory and uppercase `S` to save. The same browser profile keeps access to its saved games through the session cookie. A browser reload can reattach to a running game, and an orderly server shutdown asks each running game to save before exit.

Run `./scripts/build-browser` explicitly after edits to the C sources. It verifies the Lua archive against the release checksum, builds with the upstream Unix makefiles and stages the executable and assets in `build/stage/games/lib/nethackdir`. Stop the server first because the staging build replaces that asset directory. Score files, save files and other writable game data live separately in `build/web-state` by default. To persist them across deployments, set `NETHACK_WEB_STATE` to a durable directory with mode `0700`. Use a single server process per state directory.

| Setting | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Server-side credential for `POST https://api.openai.com/v1/decisions`. When it is available, the broker requests choices from `gpt-6-luna`. |
| `NETHACK_DECISIONS=off` | Start new games with decisions disabled. Players can toggle the feature in the browser when the broker is available. |
| `NETHACK_DECISION_LOG=1` | Emit decision timing, token usage, fallback reason and the engine's applied or blocked outcome. |
| `PORT`, `NETHACK_WEB_HOST` | Listen address, defaulting to `127.0.0.1:8080`. |
| `NETHACK_WEB_ORIGIN` | Exact browser origin when serving behind an HTTPS reverse proxy. Forward WebSocket upgrades for `/game`. |
| `NETHACK_ASSETS`, `NETHACK_BIN` | Override the staged game directory or executable. Use a Linux TTY build with the feature and normal-play sysconf. |

The engine offers legal steps for goblins, hobgoblins, hill orcs, Mordor orcs, Uruk-hai, orc-captains, kobolds, large kobolds, kobold leaders and gnomes. Only eligible ordinary movement can use a model choice. There is at most one request per player action, with a 500 ms engine deadline. The game uses native movement when no key is configured or a decision is unavailable.

## Validate

```sh
npm --prefix browser ci
npm --prefix browser test
./scripts/build-browser --test
python3 test/decision-characters/run.py build/test/games/lib/nethackdir
python3 test/decision-characters/run.py build/test/games/lib/nethackdir --mock-api
python3 test/decision-characters/upstream.py build/test/games/lib/nethackdir
python3 test/decision-characters/endgame.py build/test/games/lib/nethackdir
```

The native tests launch separate wizard-enabled copies of the installed game. They observe actual moves, turn count, damage and RNG while substituting valid or failed decision replies. The endgame test creates and restores a save on the Plane of Earth. Test builds and fixtures are for local validation.

Run the browser smoke with Chromium and its Playwright driver. Set `CHROMIUM_BIN` if Chromium is installed somewhere other than `/usr/bin/chromium`.

```sh
NETHACK_ASSETS="$PWD/build/stage/games/lib/nethackdir" \
NETHACK_BIN="$PWD/build/stage/games/lib/nethackdir/nethack" \
  node browser/test/e2e.mjs
```

To verify live applied choices after provisioning API access and project credits, run:

```sh
python3 test/decision-characters/run.py build/test/games/lib/nethackdir --live
```

If startup reports that the asset directory is missing, run the build script. If npm needs to compile `node-pty`, install the native toolchain and Python listed above. If live decisions time out or return HTTP 429, check API access and project credits, then rerun the live test. The browser game can be played while API access is unavailable.

## Verification in the cloud workspace

- Chromium exercised character creation, arrow movement, inventory, combat, item use, stairs, death, scoring and starting a new character. Two browser contexts kept independent saves. The test reattached to an open menu and restored both an explicit save and a shutdown save across a server restart.
- Across 24 keyless browser moves, keypress-to-redraw latency was 31.5 ms at the median and 35.8 ms at p95. The deliberately hung IPC fixture returned to the TTY in roughly 501 ms with the native move. Three fast monsters made multiple moves while the engine limited decisions to one per player action and rotated between monsters. Three counted waits made zero requests.
- The live fixture run applied one choice for each of the ten species and one after polymorph. The 11 applied choices had a median broker latency of 346 ms, p95 of 405 ms and 6,528 reported input tokens in total. Four earlier attempts timed out, with the slowest broker fallback at 439 ms. That run issued 15 requests across 15 deliberately eligible fixture turns, equivalent to 100 requests per 100 such turns. Counts in normal play depend on encounters and repeated commands.
