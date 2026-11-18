import { createHash } from "node:crypto";
import { chmod, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute } from "node:path";

const endpoint = "https://api.openai.com/v1/decisions";
const model = "gpt-6-luna";
const choiceName = "step";
const requestLimit = 4096;
const defaultDeadlineMs = 430;
const maxConcurrentCalls = 8;
const providers = new WeakMap();
const directions = new Map([
    ["n", "north"], ["ne", "northeast"], ["e", "east"],
    ["se", "southeast"], ["s", "south"], ["sw", "southwest"],
    ["w", "west"], ["nw", "northwest"],
]);

const tactics = new Map([
    ["goblin", "Prefer nearby allied support when wounded, then close toward the target."],
    ["hobgoblin", "When healthy, close directly using the shortest distance to the target."],
    ["hill orc", "Favor a flank when allies are already closing on the target."],
    ["mordor orc", "Close toward the target while remaining near another ally."],
    ["uruk-hai", "Preserve a firing lane if carrying usable ranged equipment. Otherwise close in."],
    ["orc-captain", "Close from a square that supports as many nearby allies as possible."],
    ["kobold", "Seek cover when critically injured. Otherwise close toward the target."],
    ["large kobold", "When healthy and confronting an isolated target, close as quickly as possible."],
    ["kobold leader", "Rally near several allies if outnumbered. Otherwise close toward the target."],
    ["gnome", "Prefer a defensible narrow approach as you close toward the target."],
]);

function providerState(fetchImpl, key) {
    let credentials = providers.get(fetchImpl);
    if (!credentials) {
        credentials = new Map();
        providers.set(fetchImpl, credentials);
    }
    // Sessions sharing a credential also share concurrency and backoff.
    const fingerprint = createHash("sha256").update(key).digest("hex");
    if (!credentials.has(fingerprint)) {
        credentials.set(fingerprint, { inFlight: 0, backoffUntil: 0, denied: false });
    }
    return credentials.get(fingerprint);
}

function boundedInteger(value, limit = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value >= 0 && value <= limit;
}

function parseRequest(line) {
    const request = JSON.parse(line);
    if (!request || typeof request.id !== "string" || !/^[1-9][0-9]{0,19}$/.test(request.id)
        || !boundedInteger(request.turn) || !boundedInteger(request.level, 65535)
        || !boundedInteger(request.monster, 0xffffffff)
        || !tactics.has(request.species)
        || !["healthy", "wounded", "critical"].includes(request.health)
        || !directions.has(request.native)
        || !boundedInteger(request.allies, 65535) || !boundedInteger(request.opponents, 65535)
        || typeof request.ranged !== "boolean"
        || !Array.isArray(request.steps) || request.steps.length < 2 || request.steps.length > 8) {
        throw new Error("Invalid decision request");
    }
    const ids = new Set();
    const steps = request.steps.map((step) => {
        if (!step) throw new Error("Invalid decision step");
        const {
            id, target_distance, closes, known_hazard, nearby_allies,
            cover, firing_lane, narrow, flank,
        } = step;
        if (!directions.has(id) || ids.has(id)
            || !boundedInteger(target_distance, 255) || !boundedInteger(nearby_allies, 65535)
            || ![closes, known_hazard, cover, firing_lane, narrow, flank]
                .every((flag) => typeof flag === "boolean")) {
            throw new Error("Invalid decision step");
        }
        ids.add(id);
        return {
            id, target_distance, closes, known_hazard, nearby_allies,
            cover, firing_lane, narrow, flank,
        };
    });
    if (!ids.has(request.native)) throw new Error("Invalid native step");
    const { id, turn, level, monster, species, health, allies, opponents, ranged } = request;
    return { id, turn, level, monster, evidence: { species, health, allies, opponents, ranged, steps }, ids };
}

function retryDelay(retryAfter) {
    const now = Date.now();
    const delay = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - now;
    return Number.isNaN(delay) ? 60_000 : Math.max(15_000, Math.min(delay, 300_000));
}

async function askDecision(request, { apiKey, fetchImpl, state, signal }) {
    const { evidence, ids } = request;
    const body = {
        model,
        input: [{ role: "user", content: [{ type: "input_json", data: evidence }] }],
        questions: [{
            type: "choice",
            name: choiceName,
            instructions: [
                "Choose the step that best matches this monster's tactical preference.",
                "A shorter target_distance is closer to the perceived target.",
                "Allies and opponents are the counts the monster can perceive. Avoid known hazards when possible.",
                tactics.get(evidence.species),
            ].join(" "),
            choices: evidence.steps.map(({ id }) => ({
                value: id,
                description: `Step ${directions.get(id)}`,
            })),
        }],
    };
    const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        redirect: "error",
        signal,
        body: JSON.stringify(body),
    });
    if (response.status === 401 || response.status === 403) {
        state.denied = true;
        await response.body?.cancel();
        return { reason: "authentication" };
    }
    if (response.status === 429) {
        state.backoffUntil = Date.now() + retryDelay(response.headers.get("retry-after"));
        await response.body?.cancel();
        return { reason: "rate_limited" };
    }
    if (!response.ok) {
        await response.body?.cancel();
        return { reason: "http_error" };
    }

    let data;
    try {
        data = await response.json();
    } catch (error) {
        if (signal.aborted) throw error;
        return { reason: "invalid_response" };
    }
    const inputTokens = boundedInteger(data?.usage?.input_tokens) ? data.usage.input_tokens : null;
    const allAnswers = Array.isArray(data?.answers) ? data.answers : [];
    if (allAnswers.length === 1 && allAnswers[0]?.type === "refusal" && allAnswers[0].name == null) {
        return { reason: "refusal", inputTokens };
    }
    const answers = allAnswers.filter((answer) => answer?.name === choiceName);
    if (answers.length !== 1) return { reason: "invalid_response", inputTokens };
    const [answer] = answers;
    if (answer.type === "refusal") return { reason: "refusal", inputTokens };
    if (answer.type !== "choice" || !ids.has(answer.choice)) {
        return { reason: "invalid_response", inputTokens };
    }
    return { choice: answer.choice, inputTokens };
}

async function beforeDeadline(promise, signal) {
    let abort;
    const aborted = new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

export async function createDecisionBroker({
    socketPath,
    enabled = true,
    apiKey = process.env.OPENAI_API_KEY,
    fetchImpl = globalThis.fetch,
    maxCalls = 500,
    deadlineMs = defaultDeadlineMs,
    onEvent = () => {},
} = {}) {
    const key = apiKey?.trim();
    if (!key) {
        return { available: false, enabled: false, socketPath: null, setEnabled: () => false, close: async () => {} };
    }
    if (typeof socketPath !== "string" || !isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 103) {
        throw new TypeError("The decision broker needs a short absolute socket path");
    }
    const parent = await stat(dirname(socketPath));
    if (!parent.isDirectory() || (parent.mode & 0o077) || parent.uid !== process.getuid()) {
        throw new Error("The decision socket directory must be private and owned by the server");
    }
    if (!boundedInteger(maxCalls) || !boundedInteger(deadlineMs, defaultDeadlineMs) || deadlineMs === 0) {
        throw new TypeError("Invalid decision session limits");
    }

    const state = providerState(fetchImpl, key);
    const clients = new Set();
    let running = null;
    let calls = 0;
    let lastId = 0n;
    let closed = false;
    let active = Boolean(enabled);

    async function decide(request, connectionSignal) {
        if (!active) return { reason: "disabled" };
        if (BigInt(request.id) <= lastId) return { reason: "stale" };
        lastId = BigInt(request.id);
        if (calls >= maxCalls) return { reason: "session_limit" };
        if (state.denied) return { reason: "authentication_backoff" };
        if (state.backoffUntil > Date.now()) return { reason: "rate_limit_backoff" };
        if (running || state.inFlight >= maxConcurrentCalls) return { reason: "busy" };

        const controller = new AbortController();
        const deadline = AbortSignal.timeout(deadlineMs);
        const signal = AbortSignal.any([deadline, controller.signal, connectionSignal]);
        running = controller;
        calls++;
        state.inFlight++;
        try {
            const result = await beforeDeadline(askDecision(request, {
                apiKey: key, fetchImpl, state, signal,
            }), signal);
            return { ...result, requested: true };
        } catch {
            let reason = "network";
            if (connectionSignal.aborted) reason = "disconnected";
            else if (controller.signal.aborted) reason = "disabled";
            else if (deadline.aborted) reason = "timeout";
            return { reason, requested: true };
        } finally {
            running = null;
            state.inFlight--;
        }
    }

    const server = createServer((socket) => {
        clients.add(socket);
        socket.setEncoding("utf8");
        socket.setTimeout(2 * defaultDeadlineMs);
        const connection = new AbortController();
        const start = performance.now();
        let pending = "";
        let phase = "request";
        let result;

        const report = (outcome) => {
            if (!result) return;
            const event = { ...result, outcome };
            result = undefined;
            onEvent(event);
        };

        socket.on("error", () => socket.destroy());
        socket.on("timeout", () => socket.destroy());
        socket.on("close", () => {
            clients.delete(socket);
            connection.abort();
            report("unknown");
        });
        socket.on("data", async (chunk) => {
            pending += chunk;
            const lineEnd = pending.indexOf("\n");
            if (Buffer.byteLength(pending) > requestLimit || (lineEnd >= 0 && lineEnd !== pending.length - 1)) {
                socket.destroy();
                return;
            }
            if (lineEnd === -1) return;
            const line = pending.slice(0, lineEnd);
            pending = "";

            if (phase === "ack") {
                phase = "done";
                if (line === "applied" || line === "blocked") report(line);
                socket.end();
                return;
            }
            if (phase !== "request") {
                socket.destroy();
                return;
            }

            let request;
            try {
                request = parseRequest(line);
            } catch {
                socket.destroy();
                return;
            }
            phase = "decision";
            const answer = await decide(request, connection.signal);
            const { id, turn, level, monster } = request;
            result = {
                id, turn, level, monster, species: request.evidence.species,
                selected: answer.choice ?? null, reason: answer.reason ?? null,
                requested: answer.requested ?? false, inputTokens: answer.inputTokens ?? null,
                latencyMs: Math.round(performance.now() - start),
            };
            if (socket.destroyed) {
                report("fallback");
                return;
            }
            const reply = `${id} ${turn} ${level} ${monster} ${answer.choice ?? "-"}\n`;
            if (answer.choice) {
                phase = "ack";
                socket.write(reply);
            } else {
                phase = "done";
                report("fallback");
                socket.end(reply);
            }
        });
    });
    server.maxConnections = 4;

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
            server.removeListener("error", reject);
            resolve();
        });
    });
    const close = async () => {
        if (closed) return;
        closed = true;
        active = false;
        running?.abort();
        for (const socket of clients) socket.destroy();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    };
    try {
        await chmod(socketPath, 0o600);
    } catch (error) {
        await close();
        throw error;
    }

    return {
        available: true,
        get enabled() { return active; },
        socketPath,
        setEnabled(value) {
            active = !closed && Boolean(value);
            if (!active) running?.abort();
            return active;
        },
        close,
    };
}
