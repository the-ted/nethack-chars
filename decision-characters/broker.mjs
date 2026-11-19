import { createHash } from "node:crypto";
import { chmod, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { boundedInteger, parseRequest } from "./protocol.mjs";

import { overallPrompt, monsterPrompts } from "./prompts.mjs";

const endpoint = "https://api.openai.com/v1/decisions";
const model = "gpt-6-luna";
const choiceName = "action";
const requestLimit = 32768;
// The engine allows a further 70 ms for the socket exchange and acknowledgement.
function brokerDeadline() {
    const setting = process.env.NETHACK_DECISION_TIMEOUT_MS ?? "";
    const ms = /^[1-9][0-9]{2,4}$/.test(setting) ? Number(setting) : 0;
    return (ms >= 500 && ms <= 10000 ? ms : 500) - 70;
}
const maxConcurrentCalls = 8;
const providers = new WeakMap();
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

function retryDelay(retryAfter) {
    const now = Date.now();
    const delay = retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - now;
    return Number.isNaN(delay) ? 60_000 : Math.max(15_000, Math.min(delay, 300_000));
}

function describeAction(a) {
    const parts = [a.action];
    if (a.item) parts.push(a.item.class + " / " + a.item.type);
    if (a.x !== undefined) {
        parts.push(`at (${a.x},${a.y})`);
        if (a.target_distance !== undefined) {
            parts.push(`distance ${a.target_distance}`);
            if (a.nearby_allies) parts.push(`near allies ${a.nearby_allies}`);
            for (const key of ["closes", "known_hazard", "cover", "firing_lane", "narrow", "flank"])
                if (a[key]) parts.push(key.replaceAll("_", " "));
        }
    }
    return parts.join(", ");
}

async function askDecision(request, { apiKey, fetchImpl, state, signal }) {
    const { evidence, ids } = request;
    const { actions, ...scene } = evidence;
    const body = {
        model,
        input: [{ role: "user", content: [{ type: "input_json", data: scene }] }],
        questions: [{
            type: "choice",
            name: choiceName,
            instructions: `${overallPrompt} ${monsterPrompts.get(evidence.species)}`,
            choices: actions.map(a => ({ value: a.id, description: describeAction(a) })),
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
    deadlineMs = brokerDeadline(),
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
    if (!boundedInteger(maxCalls) || !boundedInteger(deadlineMs, 9930) || deadlineMs === 0) {
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
        socket.setTimeout(2 * Math.max(430, deadlineMs));
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
            const selectedAction = request.evidence.actions.find(a => a.id === answer.choice);
            result = {
                id, turn, level, monster, species: request.evidence.species,
                selected: answer.choice ?? null,
                action: selectedAction?.action ?? null,
                ...(selectedAction?.item && { item: selectedAction.item }),
                reason: answer.reason ?? null,
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
