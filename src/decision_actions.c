/* Native action providers for decision-characters. See doc/decision-characters.md.
 * NetHack may be freely redistributed. See license for details. */
#include "hack.h"
#include "decision.h"
#include "mfndpos.h"

#ifdef DECISION_CHARACTERS
static const char *const kinds[] = {
    "move", "melee", "ranged", "defense", "offense", "misc",
    "pickup", "wield", "wear", "wait", "native"
};

const char *
decision_direction(int dx, int dy)
{
    static const char *const dirs[3][3] = {
        { "nw", "n", "ne" }, { "w", "", "e" }, { "sw", "s", "se" }
    };
    return dirs[dy + 1][dx + 1];
}

/* A menu lives only for the current synchronous monster turn. Keep engine
   pointers private. Only the offered opaque IDs go across the socket. */
static struct decision_action *
offer(struct decision_menu *menu, enum decision_kind kind, const char *verb,
      struct obj *obj)
{
    struct decision_action *a;
    if (menu->count == DC_MAX_ACTIONS) {
        menu->overflow = TRUE;
        return NULL;
    }
    a = &menu->actions[menu->count++];
    a->kind = kind;
    a->verb = verb;
    a->obj = obj;
    if (obj)
        snprintf(a->id, sizeof a->id, "%s_%u", kinds[kind], obj->o_id);
    else
        snprintf(a->id, sizeof a->id, "%s", kinds[kind]);
    return a;
}

static void
offer_moves(struct monst *mon, struct decision_menu *menu)
{
    struct mfndposdata mfp;
    int i;
    menu->cornered = !mfndpos(mon, &mfp, mon_allowflags(mon));
    for (i = 0; i < mfp.cnt; ++i) {
        coord p = mfp.poss[i];
        long flags = mfp.info[i];
        const char *verb = "move";
        struct decision_action *a;

        if (flags & ALLOW_U) /* handled by the combat provider */
            continue;
        if ((flags & (ALLOW_M | ALLOW_MDISP))
            && !decision_perceives(mon, m_at(p.x, p.y)))
            continue;
        if (flags & ALLOW_M)
            verb = "attack monster";
        else if (flags & ALLOW_MDISP)
            verb = "displace monster";
        else if (closed_door(p.x, p.y))
            verb = "pass door";
        else if (IS_OBSTRUCTED(levl[p.x][p.y].typ))
            verb = "traverse obstacle";
        a = offer(menu, DC_MOVE, verb, NULL);
        if (!a)
            return;
        strcpy(a->id, decision_direction(p.x - mon->mx, p.y - mon->my));
        a->pos = p;
        a->flags = flags;
    }
}

static void
offer_use(struct monst *mon, struct decision_menu *menu,
          enum decision_kind kind, struct obj *only, const coord *location)
{
    struct decision_action *a;
    struct obj *obj;
    int use;
    const char *verb;

    if (!decision_find_item(mon, kind, only, location, menu->cornered))
        return;
    if (kind == DC_DEFENSE) {
        obj = gm.m.defensive;
        use = gm.m.has_defense;
        verb = obj ? "use defensively" : decision_terrain_use(use);
    } else if (kind == DC_MISC) {
        obj = gm.m.misc;
        use = gm.m.has_misc;
        verb = obj ? "use for utility" : "enter polymorph trap";
    } else {
        obj = gm.m.offensive;
        use = gm.m.has_offense;
        verb = "use against target";
    }
    if (only != obj)
        return;
    a = offer(menu, kind, verb, obj);
    if (a) {
        if (location) {
            a->pos = *location;
            snprintf(a->id, sizeof a->id, "%s_%d_%d", kinds[kind], location->x, location->y);
        }
        a->use = use;
        a->beam.x = gt.tbx;
        a->beam.y = gt.tby;
        a->trap.x = gt.trapx;
        a->trap.y = gt.trapy;
    }
}

static void
offer_wield(struct monst *mon, struct decision_menu *menu,
            struct obj *weapon, int use)
{
    struct decision_action *a;
    int i;

    if (!weapon || weapon == &hands_obj
        || (mon->weapon_check == NO_WEAPON_WANTED && mwelded(MON_WEP(mon)))
        || (MON_WEP(mon) && MON_WEP(mon)->otyp == weapon->otyp))
        return;
    /* Several ammunition stacks can use the same launcher. */
    for (i = 0; i < menu->count; ++i)
        if (menu->actions[i].kind == DC_WIELD && menu->actions[i].obj == weapon)
            return;
    a = offer(menu, DC_WIELD, "wield weapon", weapon);
    if (a) {
        a->use = use;
        snprintf(a->id, sizeof a->id, "wield_%u_%d", weapon->o_id, use);
    }
}

static void
offer_terrain(struct monst *mon, struct decision_menu *menu)
{
    int x, y;
    for (x = max(1, mon->mx - 1); x <= min(COLNO - 1, mon->mx + 1); ++x)
        for (y = max(0, mon->my - 1); y <= min(ROWNO - 1, mon->my + 1); ++y) {
            struct trap *t = t_at(x, y);
            coord p = { x, y };
            if (!(x == mon->mx && y == mon->my && stairway_at(x, y))
                && !(mon->mcansee && t && mon_knows_traps(mon, t->ttyp)))
                continue;
            offer_use(mon, menu, DC_DEFENSE, NULL, &p);
            offer_use(mon, menu, DC_MISC, NULL, &p);
        }
}

static void
offer_equipment(struct monst *mon, struct decision_menu *menu, struct obj *obj,
                boolean can_shoot)
{
    static const long slots[] = { W_AMUL, W_ARMU, W_ARMC, W_ARMH,
                                  W_ARMS, W_ARMG, W_ARMF, W_ARM };
    int i;
    if (attacktype(mon->data, AT_WEAP)) {
        if (select_rwep_from(mon, obj)) {
            menu->ranged = TRUE;
            offer_wield(mon, menu, gp.propellor, NEED_RANGED_WEAPON);
            if (can_shoot && !Is_rogue_level(&u.uz)
                && (gp.propellor == &hands_obj || gp.propellor == MON_WEP(mon))
                && (is_pole(obj)
                    ? dist2(mon->mx, mon->my, mon->mux, mon->muy) <= MON_POLE_DIST
                    : lined_up(mon)))
                offer(menu, DC_RANGED, "ranged attack on perceived hero", obj);
        }
        if (select_hwep_from(mon, obj))
            offer_wield(mon, menu, obj, NEED_HTH_WEAPON);
    }
    if (obj->oclass == ARMOR_CLASS || obj->oclass == AMULET_CLASS)
        for (i = 0; i < SIZE(slots); ++i)
            if (decision_armor(mon, slots[i], TRUE, obj)) {
                struct decision_action *a = offer(menu, DC_WEAR, "wear equipment", obj);
                if (a)
                    a->flags = slots[i];
                break;
            }
}

/* Breath and spit need a firing lane. Gaze works off-axis too. Keep the
   capability in the scene even when a move is needed to line up first. */
static void
offer_innate_attack(struct monst *mon, struct decision_menu *menu,
                    boolean can_shoot)
{
    int i;
    if (mon->mcan)
        return;
    for (i = 0; i < NATTK; ++i) {
        int type = mon->data->mattk[i].aatyp;
        if (!DISTANCE_ATTK_TYPE(type) || mon_avoiding_this_attack(mon, i))
            continue;
        menu->ranged = TRUE;
        if (!can_shoot)
            continue;
        if (type == AT_BREA && (mon->mspec_used || m_seenres(mon, M_SEEN_REFL)))
            continue;
        if ((type == AT_BREA || type == AT_SPIT) && !lined_up(mon))
            continue;
        offer(menu, DC_RANGED, "species ranged attack on perceived hero", NULL);
        return;
    }
}

void
decision_prepare(struct monst *mon, int nearby, int attack,
                 struct decision_menu *menu)
{
    struct obj *obj, *saved_launcher = gp.propellor;
    struct musable saved_items = gm.m;
    coord target = { mon->mux, mon->muy }, beam = { gt.tbx, gt.tby },
          trap = { gt.trapx, gt.trapy };

    menu->restricted = !mon->mcansee || mon->mconf || mon->mstun
                       || mon->mflee || mon->mtrapped;
    if (!menu->restricted)
        offer_moves(mon, menu);
    else
        attack = FALSE;
    /* mfndpos can locate a displaced hero. Only commit the observations of
       the normal turn path. Combat/evidence use the prior perceived target. */
    mon->mux = target.x;
    mon->muy = target.y;
    if (attack && nearby)
        offer(menu, DC_MELEE, "attack perceived hero in melee", NULL);
    offer_innate_attack(mon, menu, attack && !nearby);
    offer_terrain(mon, menu);
    for (obj = mon->minvent; obj && !menu->overflow; obj = obj->nobj) {
        offer_use(mon, menu, DC_DEFENSE, obj, NULL);
        offer_use(mon, menu, DC_MISC, obj, NULL);
        if (attack)
            offer_use(mon, menu, DC_OFFENSE, obj, NULL);
        if (menu->restricted)
            continue;
        offer_equipment(mon, menu, obj, attack && !nearby);
    }
    for (obj = svl.level.objects[mon->mx][mon->my]; obj && !menu->restricted && !menu->overflow;
         obj = obj->nexthere)
        if (decision_pickup(mon, obj, TRUE))
            offer(menu, DC_PICKUP, "pick up from floor", obj);
    if (!menu->restricted)
        offer(menu, DC_WAIT, "hold position for this turn", NULL);
    offer(menu, DC_NATIVE, "follow usual NetHack tactics", NULL);
    gt.tbx = beam.x;
    gt.tby = beam.y;
    gt.trapx = trap.x;
    gt.trapy = trap.y;
    gm.m = saved_items;
    gp.propellor = saved_launcher;
}

/* Return the dochug result, or -1 to run the native turn from this point. */
int
decision_turn(struct monst *mon, int inrange, int nearby, int scared)
{
    struct decision_menu menu = { 0 };
    struct decision_action *a;
    int selected, fd = -1, result = 0;
    boolean applied = TRUE;

    if (!decision_opportunity(mon))
        return -1;
    decision_collect_with_rng(mon, nearby, inrange && !scared
        && !noattacks(mon->data) && !u.uinvulnerable
        && (!Underwater || is_swimmer(mon->data)), &menu);
    if (menu.count < 2 || menu.overflow || (selected = decision_choose(mon, &menu, &fd)) < 0)
        return -1;
    a = &menu.actions[selected];
    switch (a->kind) {
    case DC_MOVE: {
        int status = decision_move(mon, a->pos, a->flags);
        result = status == MMOVE_DIED || mon_offmap(mon);
        applied = result || (mon->mx == a->pos.x && mon->my == a->pos.y)
                  || (a->flags & (ALLOW_M | ALLOW_MDISP));
        if (!result && status == MMOVE_MOVED && grounded(mon->data))
            disturb_buried_zombies(mon->mx, mon->my);
        break;
    }
    case DC_OFFENSE:
        gt.tbx = a->beam.x;
        gt.tby = a->beam.y;
        result = decision_attack(mon, a->obj, a->use, NULL);
        break;
    case DC_MELEE:
    case DC_RANGED:
        result = decision_attack(mon, NULL, 0, a->obj);
        break;
    case DC_DEFENSE:
    case DC_MISC:
        gt.trapx = a->trap.x;
        gt.trapy = a->trap.y;
        gt.tbx = a->beam.x;
        gt.tby = a->beam.y;
        if (a->kind == DC_DEFENSE) {
            gm.m.defensive = a->obj;
            gm.m.has_defense = a->use;
            result = use_defensive(mon) != 0;
        } else {
            gm.m.misc = a->obj;
            gm.m.has_misc = a->use;
            result = use_misc(mon) != 0;
        }
        break;
    case DC_PICKUP:
        applied = decision_pickup(mon, a->obj, FALSE);
        break;
    case DC_WIELD:
        mon->weapon_check = a->use;
        applied = wield_mon_weapon(mon, a->obj, TRUE) != 0;
        break;
    case DC_WEAR:
        applied = decision_armor(mon, a->flags, FALSE, a->obj) != NULL;
        break;
    case DC_WAIT:
        decision_note(mon, "wait", NULL);
        break;
    case DC_NATIVE:
        result = -1;
        break;
    }
    decision_characters_outcome(fd, applied);
    return result;
}
#endif
