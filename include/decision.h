/* NetHack may be freely redistributed. See license for details. */
#ifndef DECISION_H
#define DECISION_H
#if defined(UNIX) && defined(USE_ISAAC64) && (defined(__linux__) || defined(MACOS))
#define DECISION_CHARACTERS
struct mfndposdata;
enum decision_kind {
    DC_MOVE, DC_MELEE, DC_RANGED, DC_DEFENSE, DC_OFFENSE, DC_MISC,
    DC_PICKUP, DC_WIELD, DC_WEAR, DC_WAIT, DC_NATIVE
};
struct decision_action {
    enum decision_kind kind;
    char id[40];
    const char *verb;
    struct obj *obj;
    int use;
    coord pos, beam, trap;
    long flags;
};
#define DC_MAX_ACTIONS 96
struct decision_menu {
    struct decision_action actions[DC_MAX_ACTIONS];
    int count;
    boolean overflow, ranged, restricted, cornered;
};
extern const char *decision_species(struct monst *);
extern void decision_characters_new_action(void);
extern int decision_turn(struct monst *, int, int, int);
extern const char *decision_direction(int, int);
extern boolean decision_perceives(struct monst *, struct monst *);
extern boolean decision_opportunity(struct monst *);
extern void decision_prepare(struct monst *, int, int, struct decision_menu *);
extern int decision_choose(struct monst *, struct decision_menu *, int *);
extern void decision_characters_outcome(int, boolean);
extern void decision_note(struct monst *, const char *, struct obj *);
extern void decision_collect_with_rng(struct monst *, int, int, struct decision_menu *);
extern boolean decision_find_item(struct monst *, enum decision_kind, struct obj *,
                                  const coord *, boolean);
extern const char *decision_terrain_use(int);
extern int decision_move(struct monst *, coord, long);
extern int decision_attack(struct monst *, struct obj *, int, struct obj *);
extern struct obj *decision_armor(struct monst *, long, boolean, struct obj *);
extern boolean decision_pickup(struct monst *, struct obj *, boolean);
#else
#define decision_note(mon, action, obj) ((void) 0)
#endif
#endif
