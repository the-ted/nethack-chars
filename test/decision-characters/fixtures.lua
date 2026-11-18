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
   unlisted = { species = "giant rat" },
   pet = { species = "goblin", mode = "tame" },
   peaceful = { species = "goblin", peaceful = true },
   polymorph = { species = "giant rat", mode = "polymorph" },
   flight = { species = "goblin", mode = "flight" },
   melee = { species = "large kobold", target = {11, 10} },
   blind = { species = "goblin", blinded = 20 },
   crowded = { species = "goblin", mode = "fast", target = {16, 10},
               others = {{16, 4}, {16, 16}} },
   repeat_wait = { species = "goblin", mode = "repeat", target = {16, 10} },
}

local encounter = assert(fixtures[fixture], "Unknown decision fixture")
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
nh.pline(string.format("DC_RESULT %d %d %d %d %d %d",
   result.x - mx, result.y - my, result.turn - turn, result.hp,
   result.actor_hp, result.rng), true)
