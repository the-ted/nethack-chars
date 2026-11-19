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
#define DECISION_PROTOCOL_SIZE 32768
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
    int target_distance, nearby_allies;
    boolean closes, known_hazard, cover, firing_lane, narrow, flank;
};

static const char *
configured_form(int pm)
{
    switch (pm) {
#define DECISION_OVERALL(text)
#define DECISION_SPECIES(pm, name, tactics) case pm: return name;
#include "decision_prompts.conf"
#undef DECISION_OVERALL
#undef DECISION_SPECIES
    default:               return (const char *) 0;
    }
}

const char *
decision_species(struct monst *mon)
{
    /* Role state and a natural shapechanger's identity survive a form change. */
    if (mon->iswiz || mon->m_id == svq.quest_status.leader_m_id
        || (mon->cham != NON_PM && !configured_form(mon->cham)))
        return NULL;
    return configured_form(monsndx(mon->data));
}

void
decision_characters_new_action(void)
{
    /* Round robin over the eligible encounter turns seen last action.
       If the pack shrinks, the next action uses the new opportunity count. */
    if (opportunities)
        next_opportunity = (next_opportunity + 1) % opportunities;
    else
        next_opportunity = 0;
    opportunities = 0;
    attempted = FALSE;
}

boolean
decision_opportunity(struct monst *mon)
{
    const char *path = getenv("NETHACK_DECISION_SOCKET");

    if (!path || path[0] != '/' || gm.multi || gc.command_count > 1
        || svc.context.run || svc.context.travel || go.occupation || Unaware
        || u.uswallow || Conflict || helpless(mon)
        || mon->meating || mon->mpeaceful || mon->mtame
        || mon->wormno
        || mon->isshk || mon->isgd || mon->ispriest || mon->isminion
        || mon == u.ustuck || u.uundetected || U_AP_TYPE != M_AP_NOTHING
        || !decision_species(mon) || !isok(mon->mux, mon->muy)
        || dist2(mon->mx, mon->my, mon->mux, mon->muy) > 36
        || (mon->mcansee && (!m_canseeu(mon) || !m_cansee(mon, mon->mux, mon->muy)
            || (!levl[mon->mux][mon->muy].lit && levl[mon->mx][mon->my].lit))))
        return FALSE;
    if (opportunities++ != next_opportunity || attempted)
        return FALSE;
    attempted = TRUE;
    return TRUE;
}

static boolean
ordinary_ground(coordxy x, coordxy y)
{
    int typ = levl[x][y].typ;

    return (boolean) (typ == ROOM || typ == CORR
                      || (typ == DOOR && !closed_door(x, y)));
}

boolean
decision_perceives(struct monst *mon, struct monst *other)
{
    return (boolean) (other && mon->mcansee && mon != other && !DEADMONSTER(other)
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
        if (!decision_ally(mon, other) || !decision_perceives(mon, other))
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

/* Per-process memory keeps existing saves and bones binary-compatible.
   Entries follow monster IDs across levels and polymorph. */
#define MEMORY_ACTORS 128
#define MEMORY_ACTIONS 8
#define VIEW_LIMIT 16
struct past_action {
    const char *verb;
    int otyp, level, hp;
    long turn;
    coord pos;
};
struct actor_memory {
    unsigned id;
    unsigned long last;
    struct past_action events[MEMORY_ACTIONS];
    int count, next;
};
static struct actor_memory memories[MEMORY_ACTORS];
static unsigned long memory_clock;

static struct actor_memory *
memory_for(unsigned id, boolean create)
{
    int i;
    struct actor_memory *oldest = memories;
    for (i = 0; i < MEMORY_ACTORS; ++i) {
        if (memories[i].id == id)
            return &memories[i];
        if (memories[i].last < oldest->last)
            oldest = &memories[i];
    }
    if (!create)
        return NULL;
    memset(oldest, 0, sizeof *oldest);
    oldest->id = id;
    return oldest;
}

void
decision_note(struct monst *mon, const char *verb, struct obj *obj)
{
    struct actor_memory *memory;
    struct past_action *e;
    if (!decision_species(mon) || !getenv("NETHACK_DECISION_SOCKET")
        || !mon->m_id || !isok(mon->mx, mon->my))
        return;
    memory = memory_for(mon->m_id, TRUE);
    memory->last = ++memory_clock;
    e = &memory->events[memory->next];
    e->verb = verb;
    e->otyp = obj ? obj->otyp : STRANGE_OBJECT;
    e->level = ledger_no(&u.uz);
    e->turn = svm.moves;
    e->hp = mon->mhp;
    e->pos.x = mon->mx;
    e->pos.y = mon->my;
    memory->next = (memory->next + 1) % MEMORY_ACTIONS;
    if (memory->count < MEMORY_ACTIONS)
        ++memory->count;
}

struct json_writer {
    char *data;
    size_t used, size;
    boolean failed;
};

static void
append(struct json_writer *w, const char *fmt, ...)
{
    va_list args;
    int n;
    if (w->failed)
        return;
    va_start(args, fmt);
    n = vsnprintf(w->data + w->used, w->size - w->used, fmt, args);
    va_end(args);
    if (n < 0 || (size_t) n >= w->size - w->used)
        w->failed = TRUE;
    else
        w->used += n;
}

static void
quoted(struct json_writer *w, const char *s)
{
    append(w, "\"");
    for (; *s; ++s) {
        if (*s == '"' || *s == '\\')
            append(w, "\\%c", *s);
        else if ((unsigned char) *s < 32)
            append(w, "\\u%04x", (unsigned char) *s);
        else
            append(w, "%c", *s);
    }
    append(w, "\"");
}

/* Only stable engine vocabulary. Never serialize user-assigned names,
   scroll labels, messages, or player inventory. */
static void
item_description(struct json_writer *w, int otyp, const char *name)
{
    append(w, "{\"class\":");
    quoted(w, def_oc_syms[objects[otyp].oc_class].explain);
    append(w, ",\"type\":");
    quoted(w, name);
    append(w, "}");
}

static void
item_type(struct json_writer *w, int otyp)
{
    item_description(w, otyp, OBJ_NAME(objects[otyp]));
}

static void
write_history(struct json_writer *w, struct monst *mon)
{
    struct actor_memory *m = memory_for(mon->m_id, FALSE);
    int i;
    append(w, ",\"history\":[");
    for (i = 0; m && i < m->count; ++i) {
        const struct past_action *e = &m->events[
            (m->next - m->count + i + MEMORY_ACTIONS) % MEMORY_ACTIONS];
        append(w, "%s{\"action\":\"%s\",\"turn\":%ld,\"level\":%d,"
               "\"x\":%d,\"y\":%d,\"hp\":%d", i ? "," : "", e->verb,
               e->turn, e->level, e->pos.x, e->pos.y, e->hp);
        if (e->otyp != STRANGE_OBJECT) {
            append(w, ",\"item\":");
            item_type(w, e->otyp);
        }
        append(w, "}");
    }
    append(w, "]");
}

static void
write_scene(struct json_writer *w, struct monst *mon)
{
    int i, x, y, allies = 0, opponents = mon->mcansee ? 1 : 0;
    struct obj *obj;
    struct monst *other;
    append(w, ",\"hp\":%d,\"max_hp\":%d,\"x\":%d,\"y\":%d,\"target\":",
           mon->mhp, mon->mhpmax, mon->mx, mon->my);
    if (mon->mcansee)
        append(w, "{\"x\":%d,\"y\":%d}", mon->mux, mon->muy);
    else
        append(w, "null");
    append(w, ",\"status\":{\"blind\":%s,\"confused\":%s,\"stunned\":%s,"
           "\"fleeing\":%s,\"trapped\":%s},\"inventory\":[", json_bool(!mon->mcansee),
           json_bool(mon->mconf), json_bool(mon->mstun), json_bool(mon->mflee),
           json_bool(mon->mtrapped));
    for (obj = mon->minvent, i = 0; obj && i < VIEW_LIMIT; obj = obj->nobj, ++i) {
        append(w, "%s{\"item\":", i ? "," : "");
        item_type(w, obj->otyp);
        append(w, ",\"id\":%u,\"quantity\":%ld,\"equipped\":%s", obj->o_id,
               obj->quan, json_bool(!!obj->owornmask));
        if (obj->oclass == WAND_CLASS
            || (obj->oclass == TOOL_CLASS && objects[obj->otyp].oc_charged))
            append(w, ",\"charges\":%d", max(0, obj->spe));
        append(w, "}");
    }
    append(w, "],\"characters\":[");
    for (other = fmon, i = 0; other; other = other->nmon) {
        boolean ally;
        if (!decision_perceives(mon, other))
            continue;
        ally = decision_ally(mon, other);
        allies += ally;
        opponents += !!other->mtame;
        if (i >= VIEW_LIMIT)
            continue;
        append(w, "%s{\"species\":", i++ ? "," : "");
        quoted(w, pmname(other->data, NEUTRAL));
        append(w, ",\"x\":%d,\"y\":%d,\"relation\":\"%s\"}",
               other->mx, other->my, ally ? "ally" : other->mtame ? "opponent" : "other");
    }
    append(w, "],\"allies\":%d,\"opponents\":%d,\"floor\":[", allies, opponents);
    i = 0;
    for (x = max(1, mon->mx - DECISION_SENSE_RANGE);
         x <= min(COLNO - 1, mon->mx + DECISION_SENSE_RANGE) && i < VIEW_LIMIT; ++x)
        for (y = max(0, mon->my - DECISION_SENSE_RANGE);
             y <= min(ROWNO - 1, mon->my + DECISION_SENSE_RANGE) && i < VIEW_LIMIT; ++y) {
            const char *appearance;
            obj = svl.level.objects[x][y];
            if (!mon->mcansee || !obj || is_pool(x, y) || is_lava(x, y) || !m_cansee(mon, x, y)
                || (!levl[x][y].lit && levl[mon->mx][mon->my].lit))
                continue;
            append(w, "%s{\"x\":%d,\"y\":%d,\"item\":", i++ ? "," : "", x, y);
            /* A distant observer sees the appearance of a randomized item. */
            appearance = OBJ_DESCR(objects[obj->otyp]);
            item_description(w, obj->otyp, appearance ? appearance : OBJ_NAME(objects[obj->otyp]));
            append(w, "}");
        }
    append(w, "]");
}

static int
decision_request(char *buf, size_t size, struct monst *mon,
                 struct decision_menu *menu, const char *id, int level)
{
    struct json_writer w = { buf, 0, size, FALSE };
    boolean ranged = menu->ranged;
    int i;

    append(&w, "{\"version\":2,\"id\":\"%s\",\"turn\":%ld,\"level\":%d,"
           "\"monster\":%u,\"species\":\"%s\",\"health\":\"%s\",\"ranged\":%s",
           id, svm.moves, level, mon->m_id, decision_species(mon),
           3 * mon->mhp <= mon->mhpmax ? "critical" :
           2 * mon->mhp <= mon->mhpmax ? "wounded" : "healthy", json_bool(ranged));
    write_scene(&w, mon);
    write_history(&w, mon);
    append(&w, ",\"actions\":[");
    for (i = 0; i < menu->count; ++i) {
        const struct decision_action *a = &menu->actions[i];
        append(&w, "%s{\"id\":\"%s\",\"action\":\"%s\"", i ? "," : "", a->id, a->verb);
        if (a->obj) {
            append(&w, ",\"item\":");
            item_type(&w, a->obj->otyp);
        }
        if (!a->obj && (a->kind == DC_DEFENSE || a->kind == DC_MISC))
            append(&w, ",\"x\":%d,\"y\":%d", a->pos.x, a->pos.y);
        if (a->kind == DC_MOVE) {
            struct decision_step s = describe_step(mon, a->pos.x, a->pos.y, ranged);
            append(&w, ",\"x\":%d,\"y\":%d,\"target_distance\":%d,"
                   "\"closes\":%s,\"known_hazard\":%s,\"nearby_allies\":%d,"
                   "\"cover\":%s,\"firing_lane\":%s,\"narrow\":%s,\"flank\":%s",
                   a->pos.x, a->pos.y, s.target_distance, json_bool(s.closes),
                   json_bool(s.known_hazard), s.nearby_allies, json_bool(s.cover),
                   json_bool(s.firing_lane), json_bool(s.narrow), json_bool(s.flank));
        }
        append(&w, "}");
    }
    append(&w, "]}\n");
    return w.failed ? -1 : (int) w.used;
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

/* Match brokerDeadline's accepted range. Bound the parse before converting. */
static int
decision_timeout_ms(void)
{
    const char *s = getenv("NETHACK_DECISION_TIMEOUT_MS");
    int ms;
    if (!s || *s < '1' || *s > '9' || strlen(s) > 5
        || s[strspn(s, "0123456789")] != '\0')
        return DECISION_TIMEOUT_MS;
    ms = atoi(s);
    return (ms >= 500 && ms <= 10000) ? ms : DECISION_TIMEOUT_MS;
}

int
decision_choose(struct monst *mon, struct decision_menu *menu, int *outcome_fd)
{
    char request[DECISION_PROTOCOL_SIZE], reply[128], expected[128], id[32];
    int i, level, length, fd;
    int64_t start, deadline;

    start = monotonic_ms();
    if (start < 0)
        return -1;
    deadline = start + decision_timeout_ms();
    level = ledger_no(&u.uz);
    (void) snprintf(id, sizeof(id), "%lu", ++request_id);
    length = decision_request(request, sizeof(request), mon, menu, id, level);
    if (length < 0)
        return -1;
    fd = connect_broker(getenv("NETHACK_DECISION_SOCKET"), deadline);
    if (fd < 0)
        return -1;
    if (send_request(fd, request, (size_t) length, deadline)
        && receive_reply(fd, reply, sizeof(reply), deadline)) {
        for (i = 0; i < menu->count; ++i) {
            (void) snprintf(expected, sizeof(expected), "%s %ld %d %u %s\n",
                            id, svm.moves, level, mon->m_id,
                            menu->actions[i].id);
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
