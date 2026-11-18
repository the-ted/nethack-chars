/* Decision-characters integration for the NetHack Unix TTY build. */
/* NetHack may be freely redistributed. See license for details. */
#ifndef DECISION_H
#define DECISION_H

#if defined(UNIX) && (defined(__linux__) || defined(MACOS))
#define DECISION_CHARACTERS
struct mfndposdata;

extern void decision_characters_new_action(void);
extern boolean decision_characters_eligible(struct monst *, coordxy, coordxy);
extern int decision_characters_step(struct monst *, const struct mfndposdata *,
                                     unsigned, int, int *);
extern void decision_characters_outcome(int, boolean);
#endif

#endif
