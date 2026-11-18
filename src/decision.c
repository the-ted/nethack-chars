/* Decision-characters integration for the NetHack Unix TTY build. */
/* NetHack may be freely redistributed. See license for details. */
#include "hack.h"
#include "decision.h"
#include "mfndpos.h"

#ifdef DECISION_CHARACTERS
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define DECISION_TIMEOUT_MS 500
#define DECISION_PROTOCOL_SIZE 4096
#define DECISION_SENSE_RANGE 6
#ifdef MSG_NOSIGNAL
#define DECISION_SEND_FLAGS MSG_NOSIGNAL
#else
#define DECISION_SEND_FLAGS 0 /* SO_NOSIGPIPE is set on the socket below. */
#endif

/* These remain local to the process, independent of save files and game RNG. */
static unsigned opportunities, next_opportunity;
static boolean attempted;
static unsigned long request_id;

struct decision_step {
    const char *id;
    int target_distance, nearby_allies;
    boolean closes, known_hazard, cover, firing_lane, narrow, flank;
};

static const char *
decision_species(const struct monst *mon)
{
    switch (monsndx(mon->data)) {
    case PM_GOBLIN:        return "goblin";
    case PM_HOBGOBLIN:     return "hobgoblin";
    case PM_HILL_ORC:      return "hill orc";
    case PM_MORDOR_ORC:    return "mordor orc";
    case PM_URUK_HAI:      return "uruk-hai";
    case PM_ORC_CAPTAIN:   return "orc-captain";
    case PM_KOBOLD:        return "kobold";
    case PM_LARGE_KOBOLD:  return "large kobold";
    case PM_KOBOLD_LEADER: return "kobold leader";
    case PM_GNOME:         return "gnome";
    default:               return (const char *) 0;
    }
}

void
decision_characters_new_action(void)
{
    /* Round robin over the eligible movement opportunities seen last action.
       If the pack shrinks, the next action uses the new opportunity count. */
    if (opportunities)
        next_opportunity = (next_opportunity + 1) % opportunities;
    else
        next_opportunity = 0;
    opportunities = 0;
    attempted = FALSE;
}

boolean
decision_characters_eligible(struct monst *mon, coordxy target_x,
                             coordxy target_y)
{
    const char *socket_path = getenv("NETHACK_DECISION_SOCKET");

    return (boolean) (socket_path && *socket_path == '/' && !gm.multi
                      && gc.command_count <= 1
                      && !svc.context.run && !svc.context.travel
                      && !go.occupation && !Unaware && !u.uswallow && !Conflict
                      && !helpless(mon) && mon->mcansee && !mon->mtrapped
                      && !mon->mpeaceful && !mon->mtame && !mon->mflee
                      && !mon->mconf && !mon->mstun && !mon->wormno
                      && !mon->isshk && !mon->isgd && !mon->ispriest
                      && !mon->isminion && mon != u.ustuck
                      && !u.uundetected && U_AP_TYPE == M_AP_NOTHING
                      && target_x == mon->mux && target_y == mon->muy
                      && isok(target_x, target_y) && decision_species(mon)
                      && dist2(mon->mx, mon->my, target_x, target_y)
                             <= DECISION_SENSE_RANGE * DECISION_SENSE_RANGE
                      && !monnear(mon, target_x, target_y)
                      && !monnear(mon, u.ux, u.uy)
                      && m_canseeu(mon) && m_cansee(mon, target_x, target_y)
                      && (levl[target_x][target_y].lit
                          || !levl[mon->mx][mon->my].lit));
}

static boolean
ordinary_ground(coordxy x, coordxy y)
{
    int typ = levl[x][y].typ;

    return (boolean) (typ == ROOM || typ == CORR
                      || (typ == DOOR && !closed_door(x, y)));
}

static boolean
ordinary_step(struct monst *mon, const struct mfndposdata *mfp, int i)
{
    coordxy x = mfp->poss[i].x, y = mfp->poss[i].y;

    return (boolean) (!(mfp->info[i] & (ALLOW_U | ALLOW_M | ALLOW_MDISP
                                       | ALLOW_ROCK))
                      && !u_at(x, y) && !MON_AT(x, y)
                      && !(x == mon->mux && y == mon->muy)
                      && ordinary_ground(x, y));
}

static const char *
step_direction(struct monst *mon, coordxy x, coordxy y)
{
    static const char *const directions[3][3] = {
        { "nw", "n", "ne" }, { "w", "", "e" }, { "sw", "s", "se" }
    };

    return directions[y - mon->my + 1][x - mon->mx + 1];
}

static boolean
perceived_monster(struct monst *mon, struct monst *other)
{
    return (boolean) (mon != other && !DEADMONSTER(other)
                      && !mon_offmap(other) && !other->mundetected
                      && M_AP_TYPE(other) == M_AP_NOTHING
                      && (!other->minvis || perceives(mon->data))
                      && distmin(mon->mx, mon->my, other->mx, other->my)
                             <= DECISION_SENSE_RANGE
                      && (levl[other->mx][other->my].lit
                          || !levl[mon->mx][mon->my].lit)
                      && m_cansee(mon, other->mx, other->my));
}

static boolean
decision_ally(struct monst *mon, struct monst *other)
{
    return (boolean) (!other->mtame && !other->mpeaceful
                      && mon->data->mlet == other->data->mlet);
}

static boolean
narrow_step(struct monst *mon, coordxy x, coordxy y)
{
    int i, exits = 0;
    static const int dx[] = { -1, 0, 1, 0 }, dy[] = { 0, -1, 0, 1 };

    if (levl[x][y].typ == DOOR || levl[x][y].typ == CORR)
        return TRUE;

    for (i = 0; i < 4; ++i) {
        coordxy cx = x + dx[i], cy = y + dy[i];

        if (isok(cx, cy) && ordinary_ground(cx, cy)
            && m_cansee(mon, cx, cy))
            ++exits;
    }
    return (boolean) (exits <= 2);
}

static struct decision_step
describe_step(struct monst *mon, coordxy x, coordxy y, boolean ranged)
{
    struct decision_step step;
    struct monst *other;
    struct trap *trap = t_at(x, y);
    coordxy tx = mon->mux, ty = mon->muy;
    int dx = tx - x, dy = ty - y;
    boolean crowded_approach = FALSE;

    step.id = step_direction(mon, x, y);
    step.target_distance = distmin(x, y, tx, ty);
    step.closes = (boolean) (step.target_distance
                            < distmin(mon->mx, mon->my, tx, ty));
    step.known_hazard = (boolean) (trap && mon_knows_traps(mon, trap->ttyp));
    step.cover = (boolean) (!clear_path(x, y, tx, ty));
    step.firing_lane = (boolean) (ranged && !step.cover
                                  && step.target_distance < BOLT_LIM
                                  && (!dx || !dy || abs(dx) == abs(dy)));
    step.narrow = narrow_step(mon, x, y);
    step.nearby_allies = 0;
    for (other = fmon; other; other = other->nmon) {
        if (!decision_ally(mon, other) || !perceived_monster(mon, other))
            continue;
        if (distmin(x, y, other->mx, other->my) <= 2)
            ++step.nearby_allies;
        /* An ally closer to the target on this side already covers it. */
        if ((tx - other->mx) * dx + (ty - other->my) * dy > 0
            && distmin(other->mx, other->my, tx, ty) < step.target_distance)
            crowded_approach = TRUE;
    }
    step.flank = (boolean) (step.closes && !crowded_approach);
    return step;
}

static const char *
json_bool(boolean value)
{
    return value ? "true" : "false";
}

static int
decision_request(char *buf, size_t size, struct monst *mon,
                 const struct mfndposdata *mfp, unsigned choices, int native,
                 const char *id, int level)
{
    struct monst *other;
    int allies = 0, opponents = 1, len, i, step_len;
    const char *comma = "";
    const char *health = 3 * mon->mhp <= mon->mhpmax ? "critical"
                        : 2 * mon->mhp <= mon->mhpmax ? "wounded" : "healthy";
    boolean ranged = FALSE;

    for (other = fmon; other; other = other->nmon) {
        if (!perceived_monster(mon, other))
            continue;
        if (decision_ally(mon, other))
            ++allies;
        else if (other->mtame)
            ++opponents;
    }
    if (monsndx(mon->data) == PM_URUK_HAI) {
        struct obj *propellor = gp.propellor;

        ranged = (boolean) (select_rwep(mon) != (struct obj *) 0);
        gp.propellor = propellor;
    }
    len = snprintf(buf, size,
                   "{\"id\":\"%s\",\"turn\":%ld,\"level\":%d,\"monster\":%u,"
                   "\"species\":\"%s\",\"health\":\"%s\",\"native\":\"%s\","
                   "\"allies\":%d,\"opponents\":%d,\"ranged\":%s,\"steps\":[",
                   id, svm.moves, level, mon->m_id, decision_species(mon),
                   health, step_direction(mon, mfp->poss[native].x,
                                          mfp->poss[native].y),
                   allies, opponents, json_bool(ranged));
    if (len < 0 || (size_t) len >= size)
        return -1;
    for (i = 0; i < mfp->cnt; ++i) {
        struct decision_step step;

        if (!(choices & (1U << i)))
            continue;
        step = describe_step(mon, mfp->poss[i].x, mfp->poss[i].y, ranged);
        step_len = snprintf(buf + len, size - (size_t) len,
                            "%s{\"id\":\"%s\",\"target_distance\":%d,"
                            "\"closes\":%s,\"known_hazard\":%s,\"nearby_allies\":%d,"
                            "\"cover\":%s,\"firing_lane\":%s,\"narrow\":%s,\"flank\":%s}",
                            comma, step.id, step.target_distance,
                            json_bool(step.closes), json_bool(step.known_hazard),
                            step.nearby_allies, json_bool(step.cover),
                            json_bool(step.firing_lane), json_bool(step.narrow),
                            json_bool(step.flank));
        if (step_len < 0 || (size_t) step_len >= size - (size_t) len)
            return -1;
        len += step_len;
        comma = ",";
    }
    if (size - (size_t) len < sizeof("]}\n"))
        return -1;
    memcpy(buf + len, "]}\n", sizeof("]}\n"));
    return len + 3;
}

/* Use one deadline across connect, send, and receive. All file descriptors are
   nonblocking, including the best-effort acknowledgement after a move. */
static int64_t
monotonic_ms(void)
{
    struct timespec now;

    if (clock_gettime(CLOCK_MONOTONIC, &now) < 0)
        return -1;
    return (int64_t) now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static boolean
wait_for_io(int fd, short events, int64_t deadline)
{
    struct pollfd item = { fd, events, 0 };
    int64_t now;
    int result;

    do {
        now = monotonic_ms();
        if (now < 0 || now >= deadline)
            return FALSE;
        result = poll(&item, 1, (int) (deadline - now));
    } while (result < 0 && errno == EINTR);

    now = monotonic_ms();
    return (boolean) (result > 0 && now >= 0 && now < deadline);
}

static boolean
send_request(int fd, const char *request, size_t size, int64_t deadline)
{
    while (size && wait_for_io(fd, POLLOUT, deadline)) {
        ssize_t sent = send(fd, request, size, DECISION_SEND_FLAGS);

        if (sent < 0 && (errno == EINTR || errno == EAGAIN))
            continue;
        if (sent <= 0)
            return FALSE;
        request += sent;
        size -= (size_t) sent;
    }
    return (boolean) (size == 0);
}

static boolean
receive_reply(int fd, char *reply, size_t size, int64_t deadline)
{
    size_t length = 0;

    while (length < size - 1 && wait_for_io(fd, POLLIN, deadline)) {
        ssize_t received = recv(fd, reply + length, size - 1 - length, 0);

        if (received < 0 && (errno == EINTR || errno == EAGAIN))
            continue;
        if (received <= 0 || memchr(reply + length, '\0', (size_t) received))
            return FALSE;
        length += (size_t) received;
        if (memchr(reply, '\n', length)) {
            reply[length] = '\0';
            return (boolean) (reply[length - 1] == '\n');
        }
    }
    return FALSE;
}

static int
connect_broker(const char *path, int64_t deadline)
{
    struct sockaddr_un address = { 0 };
    int fd, status = 0;
    socklen_t size = sizeof(status);
#ifdef SO_NOSIGPIPE
    const int no_sigpipe = 1;
#endif

    if (!path || strlen(path) >= sizeof(address.sun_path))
        return -1;
#ifdef MACOS
    address.sun_len = sizeof(address);
#endif
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, path, strlen(path) + 1);
    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0)
        return -1;
    if (fcntl(fd, F_SETFL, O_NONBLOCK) < 0
        || fcntl(fd, F_SETFD, FD_CLOEXEC) < 0
#ifdef SO_NOSIGPIPE
        || setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe,
                      sizeof(no_sigpipe)) < 0
#endif
        || (connect(fd, (struct sockaddr *) &address, sizeof(address)) < 0
            && (errno != EINPROGRESS || !wait_for_io(fd, POLLOUT, deadline)
                || getsockopt(fd, SOL_SOCKET, SO_ERROR, &status, &size) < 0
                || status != 0))) {
        close(fd);
        return -1;
    }
    return fd;
}

int
decision_characters_step(struct monst *mon, const struct mfndposdata *mfp,
                         unsigned considered, int native, int *outcome_fd)
{
    char request[DECISION_PROTOCOL_SIZE], reply[128], expected[128], id[32];
    unsigned choices = 0;
    int i, count = 0, level, length, fd;
    int64_t start, deadline;

    if (native < 0 || !ordinary_step(mon, mfp, native))
        return -1;
    for (i = 0; i < mfp->cnt; ++i) {
        if ((considered & (1U << i)) && ordinary_step(mon, mfp, i)) {
            choices |= 1U << i;
            ++count;
        }
    }
    if (count < 2 || opportunities++ != next_opportunity || attempted)
        return -1;
    attempted = TRUE;
    start = monotonic_ms();
    if (start < 0)
        return -1;
    deadline = start + DECISION_TIMEOUT_MS;
    level = ledger_no(&u.uz);
    (void) snprintf(id, sizeof(id), "%lu", ++request_id);
    length = decision_request(request, sizeof(request), mon, mfp, choices,
                              native, id, level);
    if (length < 0)
        return -1;
    fd = connect_broker(getenv("NETHACK_DECISION_SOCKET"), deadline);
    if (fd < 0)
        return -1;
    if (send_request(fd, request, (size_t) length, deadline)
        && receive_reply(fd, reply, sizeof(reply), deadline)) {
        for (i = 0; i < mfp->cnt; ++i) {
            if (!(choices & (1U << i)))
                continue;
            (void) snprintf(expected, sizeof(expected), "%s %ld %d %u %s\n",
                            id, svm.moves, level, mon->m_id,
                            step_direction(mon, mfp->poss[i].x, mfp->poss[i].y));
            if (!strcmp(reply, expected)) {
                *outcome_fd = fd;
                return i;
            }
        }
    }
    close(fd);
    return -1;
}

void
decision_characters_outcome(int fd, boolean applied)
{
    if (fd >= 0) {
        const char *outcome = applied ? "applied\n" : "blocked\n";

        (void) send(fd, outcome, strlen(outcome), DECISION_SEND_FLAGS);
        close(fd);
    }
}
#endif /* DECISION_CHARACTERS */
