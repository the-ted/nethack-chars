import { monsterPrompts } from "./prompts.mjs";

export function boundedInteger(value, limit = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value >= 0 && value <= limit;
}

function requireValue(ok) {
    if (!ok) throw new Error("Invalid decision request");
}

function integer(value, limit) {
    requireValue(boundedInteger(value, limit));
    return value;
}

function flag(value) {
    requireValue(typeof value === "boolean");
    return value;
}

function label(value) {
    requireValue(typeof value === "string" && value.length > 0 && value.length <= 100
        && !/[\u0000-\u001f]/u.test(value));
    return value;
}

function list(values, limit, parse) {
    requireValue(Array.isArray(values) && values.length <= limit);
    return values.map(parse);
}

function position({ x, y }) {
    return { x: integer(x, 255), y: integer(y, 255) };
}

function item(value) {
    return { class: label(value.class), type: label(value.type) };
}

const directions = new Set(["n", "ne", "e", "se", "s", "sw", "w", "nw"]);

function action(value) {
    const { id } = value;
    requireValue(typeof id === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(id));
    const result = { id, action: label(value.action) };
    if (value.item) result.item = item(value.item);
    if (value.x !== undefined) Object.assign(result, position(value));
    if (directions.has(id)) {
        Object.assign(result, position(value), {
            target_distance: integer(value.target_distance, 255),
            nearby_allies: integer(value.nearby_allies, 65535),
        });
        for (const field of ["closes", "known_hazard", "cover", "firing_lane", "narrow", "flank"])
            result[field] = flag(value[field]);
    }
    return result;
}

export function parseRequest(line) {
    const r = JSON.parse(line);
    requireValue(r?.version === 2 && typeof r.id === "string" && /^[1-9][0-9]{0,19}$/.test(r.id)
        && monsterPrompts.has(r.species) && ["healthy", "wounded", "critical"].includes(r.health));
    const turn = integer(r.turn);
    const level = integer(r.level, 65535);
    const monster = integer(r.monster, 0xffffffff);
    const evidence = {
        turn, level, species: r.species, health: r.health, hp: integer(r.hp), max_hp: integer(r.max_hp),
        ...position(r), target: r.target === null ? null : position(r.target), allies: integer(r.allies), opponents: integer(r.opponents),
        status: Object.fromEntries(["blind", "confused", "stunned", "fleeing", "trapped"]
            .map(key => [key, flag(r.status[key])])),
        ranged: flag(r.ranged),
        inventory: list(r.inventory, 16, v => ({
            id: integer(v.id, 0xffffffff), item: item(v.item),
            ...(v.charges !== undefined && { charges: integer(v.charges) }),
            quantity: integer(v.quantity), equipped: flag(v.equipped),
        })),
        characters: list(r.characters, 16, v => {
            requireValue(["ally", "opponent", "other"].includes(v.relation));
            return { species: label(v.species), ...position(v), relation: v.relation };
        }),
        floor: list(r.floor, 16, v => ({ ...position(v), item: item(v.item) })),
        history: list(r.history, 8, v => ({
            turn: integer(v.turn, turn), level: integer(v.level), ...position(v), hp: integer(v.hp),
            action: label(v.action), ...(v.item && { item: item(v.item) }),
        })),
        actions: list(r.actions, 96, action),
    };
    const ids = new Set(evidence.actions.map(v => v.id));
    requireValue(evidence.hp <= evidence.max_hp && ids.size === evidence.actions.length
        && ids.has("native") && ids.size >= 2);
    return { id: r.id, turn, level, monster, evidence, ids };
}
