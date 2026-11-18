# Decision-characters for browser-playable NetHack

Build a source fork of NetHack 5.0.0 that runs the complete Unix TTY game on a server. Players use a browser terminal. Ten existing monster species get a new tactical decision during ordinary hostile movement: given the steps the engine permits, which square should this monster choose? That decision can change whether the player gets surrounded, whether a wounded monster closes the distance, or whether an archer keeps a firing lane. NetHack still resolves every action and advances the clock.

## 1. Establish a playable baseline

Use the existing `the-ted/nethack-chars` repository as the distribution fork. Import upstream Git history from the release tag `NetHack-5.0.0_Released` (commit `16ff59115315917b93185d026aeefea06db9b0f4`), retain `origin` for this project, and add `NetHack/NetHack` as `upstream`. Preserve this plan when establishing the release-based branch. Keep upstream notices and `dat/license`, identify the modified version, and ship corresponding source and build instructions with distributed releases. [Pinned upstream source](https://github.com/NetHack/NetHack/tree/16ff59115315917b93185d026aeefea06db9b0f4)

Build the unmodified release first on Linux with a C toolchain, GNU make, ncurses/terminfo development files, and the release’s Lua dependency. Start from the documented TTY recipe below. Use a disposable install prefix during builds because upstream installation recreates the game directory. Package the installed executable **and** its data, Lua scripts, help, and configuration. Keep runtime saves on a separate writable volume.

```sh
(cd sys/unix && sh setup.sh hints/linux-minimal)
make fetch-Lua
make all
make install PREFIX="$PWD/build/stage"
```

Record the working build image, tool versions and verified Lua source in the fork. Before modifying the engine, start a character, make a move, open inventory, save, exit and restore in the native terminal. Use that session as the reference for browser behavior. [Upstream Unix installation guide](https://github.com/NetHack/NetHack/blob/16ff59115315917b93185d026aeefea06db9b0f4/sys/unix/NewInstall.unx)

## 2. Put the full game in the browser

Use xterm.js in the page and a small Node.js service with a WebSocket and a pseudo-terminal (PTY) per active game. The service launches a fixed NetHack executable in TTY mode. Forward terminal input, output and window-size changes, including Escape, Control keys, directional keys, text entry and menu pagination. Deliver an 80×24 or larger playable view. Running the native executable preserves the upstream dungeon, character creation, shops, combat, inventory, endgame and save format.

Give each session an opaque owner token, one input writer, and a private game directory. Disable shell escapes, external pagers and wizard mode in the served build. Mount immutable game assets and persist each session’s writable files under its server-issued ID. On browser disconnect, keep the PTY alive for a grace period and retain terminal state for reattachment. On expiry or graceful shutdown, use NetHack’s supported hangup/save path and wait for completion before reclaiming the process. On return, reattach to the running game or restore the completed save. Verify both paths at menus as well as during play.

## 3. Integrate one real decision into the engine

Start with a goblin at a fork in a corridor. Trace `movemon()` in `src/mon.c` through `dochug()` and `m_move()` in `src/monmove.c`. The integration point is the general movement loop after `mfndpos()`. This matters because most adjacent melee attacks and some special actions already resolve elsewhere. A tactical movement decision can ship without rewriting combat. [Pinned movement code](https://github.com/NetHack/NetHack/blob/16ff59115315917b93185d026aeefea06db9b0f4/src/monmove.c)

- Let the original selection loop run once. Collect candidates as they pass its exclusions, including displacement and recent-track checks, and retain the native winner. Candidate collection must consume zero extra game RNG draws.
- Offer ordinary steps for awake, mobile, hostile, untamed monsters of the listed species that perceive a target and have at least two eligible steps. Preserve forced flight, confusion, stun, conflict and special-role behavior by bypassing the hook in those states. Start with empty traversable squares. Leave occupied-square interactions and special terrain actions to the native path when they would take precedence.
- Describe each step in monster-relative terms: direction, whether it closes distance to the perceived target, known hazards, nearby perceived allies, and whether it maintains a firing lane where applicable. Use the monster’s estimated target position and senses. Exclude unseen player state, undiscovered traps, player-supplied text and the full level map.
- Assign each candidate a short ID. A valid reply selects its index and associated position/flags together, then rejoins normal movement resolution. Keep the original winner for every bypass or failure. Only the active game process commits a move, exactly once. No decision state needs to enter an upstream save file.

## 4. Give ten existing species distinct movement priorities

Key eligibility by the generated species constant (including the current form after polymorph). These profiles influence preferences among offered steps. They grant no extra actions, senses, equipment or movement speed. Use the encounter in the last column to test that each profile has a meaningful choice. [Upstream monster definitions](https://github.com/NetHack/NetHack/blob/16ff59115315917b93185d026aeefea06db9b0f4/include/monsters.h)

| Existing species | Movement preference | Encounter to exercise it |
| --- | --- | --- |
| Goblin | Approach with nearby support when wounded | An ally occupies one side of a fork |
| Hobgoblin | Close directly while healthy | Two paths bring it to different distances from the hero |
| Hill orc | Spread around the target | Another orc already covers the direct approach |
| Mordor orc | Advance alongside another orc | A direct move would separate a pair |
| Uruk-hai | Preserve a firing lane when carrying usable ranged equipment | A lateral step keeps the perceived target lined up |
| Orc-captain | Approach from a square supporting several allies | A central step and an isolated flank are open |
| Kobold | Seek cover when badly hurt | A corner breaks the target’s line of sight |
| Large kobold | Press an isolated target while healthy | One route closes distance immediately |
| Kobold leader | Stay close to allied kobolds when outnumbered | A nearby group offers a rally position |
| Gnome | Favor a defensible narrow approach | A doorway and an open-room approach are available |

For each fixture, supply two actual legal alternatives and record the upstream default. A fake provider must be able to choose the other square and change the monster’s observed position. Live model preferences are evaluation data, so measure them separately from deterministic movement tests.

## 5. Call OpenAI Decisions with a bounded turn budget

Give the game a private local decision channel to a server-side broker. The broker alone reads `OPENAI_API_KEY` and sends authenticated HTTPS requests to `POST https://api.openai.com/v1/decisions`. Launch the game with a minimal environment and serve static browser assets without credentials. The browser sends ordinary game input. It has no endpoint for submitting arbitrary decision prompts.

For each request, use the documented `gpt-6-luna` model, a user message containing `input_json` evidence, and one named `choice` question. Build the choices from the engine’s candidate list. For example, the broker could send this request for a wounded goblin. [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions)

```json
{
  "model": "gpt-6-luna",
  "input": [{"role":"user","content":[{"type":"input_json","data":{
    "species":"goblin","health":"wounded",
    "steps":[{"id":"w","near_ally":true},{"id":"n","near_ally":false}]
  }}]}],
  "questions": [{"type":"choice","name":"step","instructions":"Pick a legal step. A wounded goblin prefers nearby support.",
    "choices":[{"value":"w","description":"Step west"},{"value":"n","description":"Step north"}]}]
}
```

Match `answers[].name` to the question, require `type == "choice"`, and match its `choice` to an offered value. Carry a session-local request ID, level, monster ID, and movement opportunity across IPC. Reject stale or mismatched replies. Handle refusals, invalid data, missing keys, disconnects, quota errors and timeouts by immediately using the native winner. On authentication or rate-limit failures, suspend new requests until configuration changes or the backoff interval expires.

Start with one outstanding request per game, at most one call per player turn and a **500 ms total wait ceiling** across that turn, including IPC. Use native movement once the budget is spent. Rotate eligible monsters across turns to avoid favoring the first member of a pack. Pause calls during long automated travel or repeated commands to avoid cumulative stalls. Add a session call cap and an on/off control. Record species, selected candidate, applied outcome, fallback reason, latency and token usage without credentials. Tune the limits from measured play sessions.

## 6. Milestones and release checks

1. **Native and browser baseline.** Produce a clean reproducible build and a single documented browser launch command. From a fresh checkout, create a character, explore, fight, use an item, change levels, save, restart the service, and restore in the browser. Verify two simultaneous players have isolated inputs and saves.
2. **Goblin vertical slice.** Exercise one real movement opportunity end to end with a scripted provider, then with an authenticated Decisions request. Show that the returned choice reaches the native resolver and produces the corresponding step. Compare feature-off and forced-fallback runs against the baseline with matching RNG and inputs.
3. **All ten species.** Run the ten encounter fixtures, plus controls for an unlisted species, a pet, a peaceful monster, polymorph, forced movement and adjacent combat. Verify unchanged turn cost, no illegal moves, and ordinary attack and damage resolution. In a test-only build, stage encounters for all ten species with live Decisions enabled and capture an applied choice for each.
4. **Failure and responsiveness.** Exercise slow, refused, malformed, unauthorized, rate-limited and late responses. Test a crowded level, fast monsters and repeated commands. Report median and p95 input-to-redraw latency, worst added turn delay, API calls per 100 turns, token usage, and applied decisions per species. Enforce the configured deadline and call cap in automated checks.
5. **Playable release.** Run upstream applicable tests, the scripted browser scenarios, and a manual normal-mode session. Exercise death, scoring and starting another character, plus an endgame smoke test using a prepared test save. Ship build, launch, save-volume, model configuration and troubleshooting instructions alongside the source. Release once fresh-build browser play, persistent saves, all ten live integrations and keyless fallback have passed.
