# Original implementation plan for terminal NetHack

This plan records the first movement-only implementation. The game now supports turn-level action selection, perception, and per-monster history for 281 enabled forms. [Current design and extension guide](doc/decision-characters.md)

Build a source fork of NetHack 5.0.0 that runs directly in the player’s terminal on macOS or Linux. Ten existing monster species get a new tactical decision during ordinary hostile movement: given the steps the engine permits, which square should this monster choose? That decision can change whether the player gets surrounded, whether a wounded monster closes the distance, or whether an archer keeps a firing lane. NetHack still resolves every action and advances the clock.

## 1. Establish a playable baseline

Use the existing `the-ted/nethack-chars` repository as the distribution fork. Import upstream Git history from the release tag `NetHack-5.0.0_Released` (commit `16ff59115315917b93185d026aeefea06db9b0f4`), retain `origin` for this project, and add `NetHack/NetHack` as `upstream`. Preserve this plan when establishing the release-based branch. Keep upstream notices and `dat/license`, identify the modified version, and ship corresponding source and build instructions with distributed releases. [Pinned upstream source](https://github.com/NetHack/NetHack/tree/16ff59115315917b93185d026aeefea06db9b0f4)

Build the unmodified release first with a C toolchain, GNU make, ncurses, and the release’s Lua dependency. Use the documented Unix TTY build, then start a character, take a turn, open inventory, save, exit, and restore. Keep the installed executable and assets separate from writable save and score files so rebuilds preserve progress. [Upstream Unix installation guide](https://github.com/NetHack/NetHack/blob/16ff59115315917b93185d026aeefea06db9b0f4/sys/unix/NewInstall.unx)

## 2. Launch the native game

Use `./scripts/play` to build as needed and launch NetHack in the foreground with the player’s terminal and standard NetHack arguments. Keep the gameplay directory separate from the build output. When a key is available, start a Node broker as a background process, wait for its private socket, and clean it up when the game exits. Run NetHack with the key removed from its environment so game input, save files, and shell commands do not handle it.

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

Give the game a private local decision channel to the broker. The broker reads `OPENAI_API_KEY` and sends authenticated HTTPS requests to `POST https://api.openai.com/v1/decisions`.

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

1. **Native baseline.** Produce a clean reproducible build and a documented terminal launch command. Create a character, explore, fight, use an item, change levels, save, exit, and restore in a new terminal session.
2. **Goblin vertical slice.** Exercise one real movement opportunity end to end with a scripted provider, then with an authenticated Decisions request. Show that the returned choice reaches the native resolver and produces the corresponding step. Compare feature-off and forced-fallback runs against the baseline with matching RNG and inputs.
3. **All ten species.** Run the ten encounter fixtures, plus controls for an unlisted species, a pet, a peaceful monster, polymorph, forced movement and adjacent combat. Verify unchanged turn cost, no illegal moves, and ordinary attack and damage resolution. In a test-only build, stage encounters for all ten species with live Decisions enabled and capture an applied choice for each.
4. **Failure and responsiveness.** Exercise slow, refused, malformed, unauthorized, rate-limited and late responses. Test a crowded level, fast monsters and repeated commands. Report median and p95 input-to-redraw latency, worst added turn delay, API calls per 100 turns, token usage, and applied decisions per species. Enforce the configured deadline and call cap in automated checks.
5. **Playable release.** Run the upstream Lua tests, the native encounter fixtures, and a normal-mode terminal session. Exercise scoring and an endgame save. Ship build, launch, save, and model configuration instructions alongside the source.
