-- Test-only floor for browser keyboard, combat, item use, and stairs.
des.level_init({ style = "solidfill", fg = " " })
des.level_flags("mazelevel", "noflip", "nomongen", "nodeathdrops", "premapped")
des.map([[
------------
|..........|
|..........|
------------
]])
des.region(selection.area(1,1,10,2), "lit")
des.levregion({ type = "branch", region = { 1, 1, 1, 1 } })
des.stair("down", 6, 1)
des.monster({ id = "lichen", x = 2, y = 1, peaceful = 0 })
des.object({ id = "oil lamp", x = 3, y = 1, name = "Browser Test", buc = "uncursed", spe = 100 })
