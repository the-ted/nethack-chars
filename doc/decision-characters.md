# Developing decision-characters

A hostile hill orc beside the hero can attack, retreat through an open square, use a suitable carried item, or hold position. NetHack builds those choices for this particular actor. The broker asks OpenAI Decisions one multiple-choice question. The game resolves the selected action synchronously, before another monster can move. [Build, play, and wizard-mode instructions](../README.decision-characters.md)

## Supported species

The 281 enabled forms include the original orcs and kobolds, adult and juvenile dragons, aquatic monsters, NPC adventurers, and revealed mimics. For a natural shapechanger, both its original and current form must be configured. An ordinary polymorphed monster uses its current form. The Wizard of Yendor and the actual quest leader retain their native decisions across transformations. The catalog gives the status of every compiled form, including the 89 conditional and 13 native-only entries. [Prompt config](../include/decision_prompts.conf) · [Full roster](../addressable-monsters.txt)

## Edit the model instructions

Edit `include/decision_prompts.conf`. The broker joins the `DECISION_OVERALL` rows in file order with spaces, then appends the third field of the matching `DECISION_SPECIES` row. That string becomes the Decisions question’s `instructions`. The observations, history, and legal choices are built from the current turn. Relaunch the game after editing prompt wording. [Broker request](../decision-characters/broker.mjs)

Use one declaration per line. Quote instruction text with double quotes. Escape a literal double quote as `\"` and a backslash as `\\`. Blank lines and single-line `/* comments */` are accepted. The first two fields on a species row are its unique engine constant and wire name. Use lowercase ASCII letters, digits, spaces, and hyphens for the wire name. Rebuild with `./scripts/build` when adding a species or changing either identifier.

## What the monster can choose

| Situation | Choices and native resolution |
| --- | --- |
| Movement | Each neighboring entry returned by `mfndpos`, with its direction and interaction flags. This includes traversable doors, obstacles, and permitted attacks on or displacement of an occupant. `resolve_step` checks regions and applies traps, doors, pickup, and terrain effects. |
| Combat | Attack the perceived hero in melee, attempt an innate ranged attack such as breath, spit or gaze, throw a particular missile, shoot compatible ammunition with a readied launcher, or use a readied polearm in reach. NetHack resolves hit rolls, damage, multiple attacks, and retaliation. |
| Wielding and wearing | Wield a usable hand weapon or launcher. Wear an eligible piece of armor or amulet. NetHack checks anatomy, occupied slots, welded weapons, cursed armor, and dressing time. |
| Carried items | Choose the concrete item and use it offensively, defensively, or for utility when its native selector allows that use. Examples include healing, zapping, throwing a potion, reading a scroll, applying a horn, disarming with a bullwhip, and looting a carried container. |
| Floor and escape | Pick up a particular reachable stack. Use eligible stairs, ladders, or a known escape or polymorph trap. Use of stairs or a trap can remove the monster from the current level. |
| Other tactics | Hold position for one activation, or let NetHack choose its usual turn, including native combinations such as moving and shooting. |

The encounter hook runs after pre-turn effects and target perception, within six squares of the perceived hero. A blind, fleeing, stunned, confused, or trapped monster can select eligible item or escape actions, or continue its native turn. With no alternative it runs natively. Pets, peaceful monsters, special roles, forced inactivity, conflict, and repeated player commands retain their existing behavior. Native pre-turn equipment changes, passive abilities, and consequences of a selected action continue to run at their normal points. Each new species needs a review of its special abilities and their place in that sequence. [Turn entry and movement resolution](../src/monmove.c) · [Action providers](../src/decision_actions.c)

## What the model sees and remembers

Each request includes the turn and level, exact current and maximum HP, position, status effects, and the perceived hero position. North decreases `y`. A blind actor receives a null target and empty visual observations. The scene lists up to 16 carried stacks with quantities, equipment state, and charges where applicable, up to 16 nearby visible creatures with positions and estimated relationships, and the visible top item on up to 16 floor squares. Distant objects with randomized appearances use their appearance. A step describes its destination, distance to target, known hazard, nearby support, cover, and firing lane.

The game keeps the last eight recorded actions per monster ID in chronological order. Entries include the action, turn, level, actor position and HP at the event, and item type where applicable. For example, after the monster drinks a healing potion, the next prompt shows the prior use, its updated HP, and its remaining inventory. The records include native actions taken between model calls. A blocked reply or a timeout does not create a fictitious model action. History uses a session-local cache of 128 actors, evicts the least recently recorded actor, and starts fresh when a game process restarts. Existing saves and bones retain their format. [Observation and history implementation](../src/decision.c)

## Follow one turn in the source

1. `dochug` calls `decision_turn` once the monster has perceived its target. Candidate preparation uses NetHack’s movement, combat, equipment, and item rules. Each entry holds the object or target, relevant native scratch values, and an opaque ID. Capability checks run with the core RNG restored after the preview. [Action providers and dispatcher](../src/decision_actions.c) · [Item rules](../src/muse.c)
2. The engine sends a version 2 JSON line over the private Unix socket. The broker validates a bounded projection and builds one question named `action`. The scene and history go into `input_json`. The offered IDs, objects, positions, and tactical descriptions go into the choices. [Protocol validation](../decision-characters/protocol.mjs) · [Decisions request](../decision-characters/broker.mjs)
3. The reply echoes request ID, turn, level, monster ID, and action ID. The engine requires an exact match with a candidate it still holds. It dispatches that candidate to the native resolver and acknowledges the attempt. The log includes the selected ID, descriptive action, item when present, and outcome. `applied` describes the choice reaching the engine. Hits, misses, item side effects, and movement vetoes are decided in the game.
4. The scheduler rotates among eligible opportunities and allows one request per player action. The default wait is 500 ms, including 70 ms reserved for the socket exchange. A whole-number `NETHACK_DECISION_TIMEOUT_MS` from 500 through 10000 sets the total budget for both processes. An invalid or stale response, exhausted session budget, or timeout returns control to the normal turn path. Menus and frames are bounded at 96 choices and 32 KiB. An oversized menu falls back as a whole.

## Add a species

1. Start with its entry in the [expansion catalog](../addressable-monsters.txt). Find its existing `PM_*` constant and attack array. Trace any special action in `dochug`, `m_move`, or the attack resolver. Generic weapon, armor, and item support is already shared. A special ability with its own activation or targeting rules needs its own provider or integration point. [Monster definitions](../include/monsters.h)
2. Add one `DECISION_SPECIES(PM_CONSTANT, "wire name", "tactics")` row. Use a stable lowercase wire name. Describe when to use actions available to that species. Mark its catalog row `enabled` when you enable it. [Prompt config](../include/decision_prompts.conf)
3. Run the roster test for the new ID. The runner reads enabled entries from the config and catalog. Set up water or reveal the natural form in the fixture when needed. Add a focused Lua encounter for a new action or exceptional behavior. Give the actor a reason to choose between two meaningful options. Assert the offered menu, one turn of elapsed time, and an observable effect such as a changed position or consumed charge. [Roster test](../test/decision-characters/roster.py) · [Encounters](../test/decision-characters/fixtures.lua) · [TTY runner](../test/decision-characters/run.py)

The wire names `werewolf` and `human werewolf` select separate prompts. The same convention applies to wererats and werejackals. Related forms with the same attack sequence can share tactical wording. Baby dragons, for example, approach to bite, while adults have breath-weapon instructions specific to their color.

## Add an action or observation

For a new item handled by an existing native selector and executor, add a fixture for that item first. The provider searches individual candidate objects while keeping the full inventory available for prerequisites such as launchers and armor. For a new action family, add its kind and candidate data, write its eligibility check, and dispatch it to the existing resolver. Preserve the native turn path on failure. Keep preview free of game mutations, restore native scratch state, and record the action at execution so history also covers native turns. [Candidate representation](../include/decision.h) · [Providers](../src/decision_actions.c)

For a new observation, add a bounded field to the engine’s evidence writer, explicitly project it in the broker validator, and assert its presence in the outgoing API body. Use the actor’s senses, the perceived target, and game-defined names. Keep player names, user-named items, and unrestricted game text out of the request. [Evidence writer](../src/decision.c) · [Protocol tests](../test/decision-characters/broker.test.mjs)

## Run a reproducible encounter

From the repository root, these commands build the fixture-enabled game, run a wounded orc with multiple usable potions, and exercise the real broker without network access.

```sh
./scripts/build --test
game=build/test/games/lib/nethackdir
python3 test/decision-characters/run.py "$game" --fixture items
python3 test/decision-characters/run.py "$game" --mock-api
node --test test/decision-characters/broker.test.mjs
```

With no fixture specified, the runner verifies the catalog against the executable’s `--dumpenums` and the enabled prompt rows. The scripted run also includes the action-effect, visibility, history, turn-budget, and fallback checks. With `OPENAI_API_KEY` set, use `--live --fixture melee` for an authenticated adjacent-combat encounter. Scripted fixtures assert deterministic game effects. Live runs report the returned choice, latency, and token usage. [Full validation commands](../README.decision-characters.md#validate)
