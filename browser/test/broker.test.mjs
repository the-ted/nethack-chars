import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDecisionBroker } from "../broker.mjs";

function encounter(overrides = {}) {
    const step = {
        target_distance: 2,
        closes: true,
        known_hazard: false,
        nearby_allies: 0,
        cover: false,
        firing_lane: false,
        narrow: false,
        flank: false,
    };
    return {
        id: "1", turn: 8, level: 3, monster: 36,
        species: "goblin", health: "wounded", native: "n",
        allies: 1, opponents: 1, ranged: false,
        steps: [{ ...step, id: "n" }, { ...step, id: "w", nearby_allies: 1 }],
        ...overrides,
    };
}

function choice(value = "w") {
    return Response.json({
        answers: [{ name: "step", type: "choice", choice: value }],
        usage: { input_tokens: 99 },
    });
}

async function brokerFixture(t, fetchImpl, overrides = {}) {
    const dir = await mkdtemp(join(tmpdir(), "nethack-broker-test-"));
    const events = [];
    const broker = await createDecisionBroker({
        socketPath: join(dir, "d.sock"),
        apiKey: "test-key",
        fetchImpl,
        onEvent: (event) => events.push(event),
        ...overrides,
    });
    t.after(async () => {
        await broker.close();
        await rm(dir, { recursive: true });
    });
    return { broker, events };
}

function exchange(broker, request, ack = "applied") {
    return new Promise((resolve, reject) => {
        const client = createConnection(broker.socketPath);
        let response = "";
        client.setEncoding("utf8");
        client.setTimeout(1500, () => client.destroy(new Error("No reply")));
        client.once("error", reject);
        client.once("connect", () => client.write(JSON.stringify(request) + "\n"));
        client.on("data", (part) => {
            response += part;
            if (!response.endsWith("\n")) return;
            if (response.endsWith(" -\n") || !ack) client.end();
            else client.end(ack + "\n");
        });
        client.once("close", () => resolve(response));
    });
}

test("uses the Decisions choice API and records the engine's applied outcome", async (t) => {
    let calls = 0;
    const { broker, events } = await brokerFixture(t, (url, options) => {
        calls++;
        assert.equal(url, "https://api.openai.com/v1/decisions");
        assert.equal(options.headers.authorization, "Bearer test-key");
        assert.equal(options.redirect, "error");
        const { model, input, questions } = JSON.parse(options.body);
        assert.equal(model, "gpt-6-luna");
        assert.deepEqual(questions[0].choices.map((step) => step.value), ["n", "w"]);
        assert.equal(questions[0].type, "choice");
        assert.match(questions[0].instructions, /nearby allied support/);
        const [evidence] = input[0].content;
        assert.equal(evidence.type, "input_json");
        assert.equal(evidence.data.species, "goblin");
        assert.equal(evidence.data.steps[1].nearby_allies, 1);
        assert.deepEqual(Object.keys(evidence.data), ["species", "health", "allies", "opponents", "ranged", "steps"]);
        assert.equal(evidence.data.steps[1].unexpected, undefined);
        return choice();
    });
    assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
    const first = encounter();
    first.steps[1].unexpected = "freeform text";
    assert.equal(await exchange(broker, first), "1 8 3 36 w\n");
    assert.equal(await exchange(broker, encounter({ id: "2" }), "blocked"), "2 8 3 36 w\n");
    assert.equal(calls, 2);
    assert.deepEqual(events.map(({ outcome, inputTokens, selected }) => [outcome, inputTokens, selected]),
        [["applied", 99, "w"], ["blocked", 99, "w"]]);
});

test("keyless mode creates no socket", async () => {
    const broker = await createDecisionBroker({ apiKey: "" });
    assert.equal(broker.available, false);
    assert.equal(broker.socketPath, null);
    assert.equal(broker.setEnabled(true), false);
    await broker.close();
});

test("disable, replay checks, and the session cap avoid extra calls", async (t) => {
    let calls = 0;
    const { broker, events } = await brokerFixture(t, () => {
        calls++;
        return choice();
    }, { maxCalls: 1, enabled: false });
    assert.equal(await exchange(broker, encounter()), "1 8 3 36 -\n");
    broker.setEnabled(true);
    assert.equal(await exchange(broker, encounter({ id: "2" })), "2 8 3 36 w\n");
    assert.equal(await exchange(broker, encounter({ id: "2" })), "2 8 3 36 -\n");
    assert.equal(await exchange(broker, encounter({ id: "3", turn: 9 })), "3 9 3 36 -\n");
    assert.equal(calls, 1);
    assert.deepEqual(events.map(({ reason }) => reason), ["disabled", null, "stale", "session_limit"]);
});

test("invalid steps, unknown answers, refusals, and malformed responses fall back", async (t) => {
    const responses = [
        choice("e"),
        Response.json({ answers: [{ name: "step", type: "refusal" }] }),
        Response.json({ answers: [{ type: "refusal" }] }),
        new Response("<not json>"),
        Response.json({ answers: [null, { name: "bogus", type: "choice", choice: "w" }] }),
    ];
    const { broker, events } = await brokerFixture(t, () => responses.shift());
    assert.equal(await exchange(broker, encounter({ native: "e" })), "");
    for (let id = 1; id <= 5; id++) {
        assert.equal(await exchange(broker, encounter({ id: String(id) })), `${id} 8 3 36 -\n`);
    }
    assert.deepEqual(events.map(({ reason }) => reason), [
        "invalid_response", "refusal", "refusal", "invalid_response", "invalid_response",
    ]);
});

test("authentication and rate-limit failures back off across sessions", async (t) => {
    for (const [status, reason, subsequent] of [
        [401, "authentication", "authentication_backoff"],
        [429, "rate_limited", "rate_limit_backoff"],
    ]) {
        await t.test(String(status), async (subtest) => {
            let calls = 0;
            const provider = () => { calls++; return new Response(null, { status }); };
            const first = await brokerFixture(subtest, provider);
            const second = await brokerFixture(subtest, provider);
            assert.equal(await exchange(first.broker, encounter()), "1 8 3 36 -\n");
            assert.equal(await exchange(second.broker, encounter()), "1 8 3 36 -\n");
            assert.equal(calls, 1);
            assert.equal(first.events[0].reason, reason);
            assert.equal(second.events[0].reason, subsequent);
        });
    }
});

test("a late answer is discarded within the deadline and cannot affect another move", async (t) => {
    let finish;
    let calls = 0;
    const { broker, events } = await brokerFixture(t, () => {
        calls++;
        return calls === 1 ? new Promise((resolve) => { finish = resolve; }) : choice();
    }, { deadlineMs: 30 });
    assert.equal(await exchange(broker, encounter()), "1 8 3 36 -\n");
    assert.equal(events[0].reason, "timeout");
    assert.ok(events[0].latencyMs < 500);
    finish(choice("n"));
    await delay(5);
    assert.equal(await exchange(broker, encounter({ id: "2" })), "2 8 3 36 w\n");
    assert.deepEqual(events.map(({ selected }) => selected), [null, "w"]);
});
