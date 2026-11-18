-- Test-only death encounter on the next floor.
des.level_init({ style = "solidfill", fg = " " })
des.level_flags("mazelevel", "noflip", "nomongen", "nodeathdrops", "premapped")
des.map([[
---------
|.......|
|.......|
|.......|
---------
]])
des.region(selection.area(1,1,7,3), "lit")
des.stair("up", 4, 2)
des.stair("down", 7, 3)
des.monster({ id = "minotaur", x = 3, y = 2, peaceful = 0 })
des.monster({ id = "minotaur", x = 5, y = 2, peaceful = 0 })
