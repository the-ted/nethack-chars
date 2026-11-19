-- fixture is supplied by run.py in the disposable wizard playground.
local fixtures = {
   goblin = { species = "goblin", mode = "wounded", allies = {{9, 8}} },
   hobgoblin = { species = "hobgoblin" },
   hill_orc = { species = "hill orc", allies = {{14, 8}} },
   mordor_orc = { species = "Mordor orc", allies = {{9, 12}} },
   uruk_hai = { species = "Uruk-hai", target = {14, 9}, ranged = true },
   orc_captain = { species = "orc-captain", allies = {{12, 8}, {10, 8}} },
   kobold = { species = "kobold", mode = "wounded", walls = {{11, 9}, {12, 9}} },
   large_kobold = { species = "large kobold" },
   kobold_leader = { species = "kobold lord", allies = {{10, 8}, {9, 9}}, ally = "kobold" },
   gnome = { species = "gnome", corridor = {10, 9} },
   unlisted_shifter = { species = "sandestin", mode = "polymorph" },
   enabled_shifter = { species = "doppelganger", mode = "polymorph" },
   unlisted = { species = "kobold shaman" },
   pet = { species = "goblin", mode = "tame" },
   peaceful = { species = "goblin", peaceful = true },
   polymorph = { species = "kobold shaman", mode = "polymorph" },
   flight = { species = "goblin", mode = "flight" },
   breath = { species = "iron golem", items = {"dart", "orcish dagger"} },
   off_axis = { species = "red dragon", target = {14, 11}, turns = 2 },
   gaze = { species = "pyrolisk", target = {14, 11}, turns = 2 },
   spit = { species = "black naga", turns = 2 },
   passive = { species = "floating eye", target = {11, 10}, turns = 2 },
   melee = { species = "large kobold", target = {11, 10} },
   cure = { species = "hill orc", blinded = 20, turns = 2, items = {"unicorn horn"} },
   utility = { species = "hill orc", turns = 2, items = {"potion of speed"} },
   wield = { species = "hill orc", turns = 2, items = {"axe", "orcish dagger"} },
   memory = { species = "hill orc", turns = 10 },
   native_history = { species = "hill orc", turns = 2 },
   items = { species = "hill orc", mode = "wounded", turns = 2,
             items = {"potion of healing", "potion of extra healing", "potion of speed"} },
   escape = { species = "hill orc", mode = "escape", trap = true },
   bow = { species = "Uruk-hai", ranged = true, turns = 3 },
   last_dart = { species = "orc-captain", turns = 2, single = true, items = {"dart", "orcish dagger"} },
   archer = { species = "hill orc", turns = 2, items = {"dart", "orcish dagger"} },
   wand = { species = "hill orc", turns = 2, items = {"wand of striking"} },
   pickup = { species = "hill orc", turns = 2, floor = "dagger", allies = {{9, 8}, {30, 8}} },
   door = { species = "hill orc", door = true },
   armor = { species = "hill orc", mode = "armor", floor = "leather gloves" },
   blind = { species = "goblin", blinded = 20 },
   crowded = { species = "goblin", mode = "fast", target = {16, 10},
               others = {{16, 4}, {16, 16}} },
   repeat_wait = { species = "goblin", mode = "repeat", target = {16, 10} },
}

local encounter = assert(roster_encounter or fixtures[fixture], "Unknown decision fixture")
local mx, my = 10, 10
local tx, ty = table.unpack(encounter.target or {14, 10})

nh.debug_flags({mongen = false, hunger = false, overwrite_stairs = true})
u.clear_inventory()
des.reset_level()
des.level_flags("noflip", "nomongen")
nh.debug_flags({mongen = true})
des.level_init({style = "solidfill", fg = ".", lit = true})
local sx, sy = nh.abscoord(0, 0)
des.teleport_region({region = {tx, ty, tx, ty}, region_islev = true, dir = "both"})
for _, wall in ipairs(encounter.walls or {}) do
   des.terrain(wall[1] - sx, wall[2] - sy, " ")
end
if encounter.corridor then
   des.terrain(encounter.corridor[1] - sx, encounter.corridor[2] - sy, "#")
end
for _, ally in ipairs(encounter.allies or {}) do
   des.monster({id = encounter.ally or "goblin", x = ally[1] - sx, y = ally[2] - sy,
                peaceful = false, paralyzed = 25, group = false,
                keep_default_invent = false, countbirth = false})
end

if encounter.pool then
   for x = mx - 1, mx + 1 do
      for y = my - 1, my + 1 do des.terrain(x - sx, y - sy, "}") end
   end
end
local actor = {
   id = encounter.species, x = mx - sx, y = my - sy, asleep = false, group = false,
   peaceful = encounter.peaceful or false, countbirth = false,
   adjacentok = true, keep_default_invent = false, blinded = encounter.blinded,
}
if encounter.ranged then
   actor.inventory = function()
      des.object("orcish bow")
      des.object({id = "orcish arrow", quantity = 12})
   end
end
if encounter.items then
   actor.inventory = function()
      for _, name in ipairs(encounter.items) do
         des.object({id = name, buc = "uncursed", spe = 3, quantity = name == "dart" and not encounter.single and 8 or 1})
      end
   end
end
if encounter.floor then
   des.object({id = encounter.floor, x = mx - sx, y = my - sy, buc = "uncursed"})
end
if encounter.trap then
   des.trap({type = "teleport", x = mx - sx, y = my - 1 - sy, teledest = {20 - sx, 10 - sy}})
end
if encounter.door then
   des.door("closed", mx - sx, my - 1 - sy)
end
des.monster(actor)
for _, other in ipairs(encounter.others or {}) do
   des.monster({id = encounter.species, x = other[1] - sx, y = other[2] - sy,
                asleep = false, peaceful = false, countbirth = false, group = false,
                keep_default_invent = false})
end
des.finalize_level()
for _, stair in ipairs(nh.stairways()) do
   des.terrain(stair.x, stair.y, ".")
end
assert(u.ux == tx and u.uy == ty, "Decision fixture failed to place hero")

local peers = {}
for _, other in ipairs(encounter.others or {}) do
   local peer_id = nh.decision_fixture(other[1], other[2], "fast")
   peers[#peers + 1] = peer_id
end
local id, turn = nh.decision_fixture(mx, my, encounter.mode or "normal")
if fixture == "crowded" then
   nh.pushkey(".")
   nh.doturn()
   -- Guarantee a second round where every actor has two moves available.
   nh.decision_fixture(id, "recharge")
   for _, peer_id in ipairs(peers) do
      nh.decision_fixture(peer_id, "recharge")
   end
   nh.pushkey(".")
   nh.doturn()
elseif encounter.turns then
   for i = 1, encounter.turns do
      nh.decision_fixture(id, "one move")
      nh.pushkey(".")
      nh.doturn()
   end
elseif fixture == "repeat_wait" then
   -- Resolve the remaining repeats, then their final turn before command input.
   nh.doturn()
   nh.doturn()
   nh.pushkey(".")
   nh.doturn()
else
   nh.pushkey(".")
   nh.doturn()
end
local result = nh.decision_fixture(id)
if fixture == "breath" then assert(result.darts == 8, "breath spent a carried missile") end
if fixture == "armor" then assert(result.gloves, "selected armor was not worn") end
if fixture == "door" then assert(result.open_door, "selected door did not open") end
nh.pline(string.format("DC_RESULT %d %d %d %d %d %d",
   result.x - mx, result.y - my, result.turn - turn, result.hp,
   result.actor_hp, result.rng), true)
