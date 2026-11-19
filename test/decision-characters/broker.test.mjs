import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createDecisionBroker } from "../../decision-characters/broker.mjs";
import { monsterPrompts, overallPrompt } from "../../decision-characters/prompts.mjs";

function encounter(overrides = {}) {
    const step = {
        action: "move", x: 5, y: 3, target_distance: 2,
        closes: true,
        known_hazard: false,
        nearby_allies: 0,
        cover: false,
        firing_lane: false,
        narrow: false,
        flank: false,
    };
    return {
        version: 2, id: "1", turn: 8, level: 3, monster: 36,
        species: "goblin", health: "wounded", hp: 3, max_hp: 8, x: 4, y: 3, target: { x: 7, y: 4 },
        status: { blind: false, confused: false, stunned: false, fleeing: false, trapped: false },
        characters: [], floor: [], history: [], inventory: [],
        allies: 1, opponents: 1, ranged: false,
        actions: [{ ...step, id: "n" }, { ...step, id: "w", nearby_allies: 1 },
            { id: "native", action: "follow usual NetHack tactics" }, { id: "wait", action: "hold position" }],
        ...overrides,
    };
}

function choice(value = "w") {
    return Response.json({
        answers: [{ name: "action", type: "choice", choice: value }],
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
        assert.deepEqual(questions[0].choices.map((step) => step.value), ["n", "w", "native", "wait"]);
        assert.equal(questions[0].type, "choice");
        const [evidence] = input[0].content;
        assert.equal(evidence.type, "input_json");
        assert.equal(evidence.data.species, "goblin");
        assert.match(questions[0].choices[1].description, /near allies 1/);
        assert.equal(evidence.data.hp, 3);
        assert.deepEqual(evidence.data.target, { x: 7, y: 4 });
        assert.deepEqual(evidence.data.history, []);
        assert.equal(evidence.data.monster, undefined);
        assert.equal(evidence.data.actions, undefined);
        return choice();
    });
    assert.equal((await stat(broker.socketPath)).mode & 0o777, 0o600);
    const first = encounter();
    first.actions[1].unexpected = "freeform text";
    assert.equal(await exchange(broker, first), "1 8 3 36 w\n");
    assert.equal(await exchange(broker, encounter({ id: "2" }), "blocked"), "2 8 3 36 w\n");
    assert.equal(calls, 2);
    assert.deepEqual(events.map(({ outcome, inputTokens, selected }) => [outcome, inputTokens, selected]),
        [["applied", 99, "w"], ["blocked", 99, "w"]]);
});

test("request logging captures the outbound JSON before a failed call and skips backoff", async t => {
    const records = [];
    const bodies = [];
    const { broker, events } = await brokerFixture(t, (_url, options) => {
        assert.equal(records.length, 1);
        bodies.push(options.body);
        return new Response(null, { status: 401 });
    }, { onRequest: record => records.push(record) });

    assert.equal(await exchange(broker, encounter()), "1 8 3 36 -\n");
    assert.equal(await exchange(broker, encounter({ id: "2" })), "2 8 3 36 -\n");
    assert.equal(bodies.length, 1);
    assert.deepEqual(records, [{ type: "request", id: "1", turn: 8, level: 3,
        monster: 36, species: "goblin", body: JSON.parse(bodies[0]) }]);
    assert.deepEqual(events.map(e => e.reason), ["authentication", "authentication_backoff"]);
});

test("sends the shared instructions followed by the selected monster's configured prompt", async t => {
    const instructions = [];
    const { broker } = await brokerFixture(t, (_url, options) => {
        instructions.push(JSON.parse(options.body).questions[0].instructions);
        return choice();
    });
    let id = 0;
    for (const [species, prompt] of monsterPrompts) {
        const request = encounter({ species, id: String(++id) });
        assert.equal(await exchange(broker, request), `${id} 8 3 36 w\n`);
        assert.equal(instructions.shift(), `${overallPrompt} ${prompt}`, species);
    }
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
        Response.json({ answers: [{ name: "action", type: "refusal" }] }),
        Response.json({ answers: [{ type: "refusal" }] }),
        new Response("<not json>"),
        Response.json({ answers: [null, { name: "bogus", type: "choice", choice: "w" }] }),
    ];
    const { broker, events } = await brokerFixture(t, () => responses.shift());
    assert.equal(await exchange(broker, encounter({ actions: [{ id: "bogus", action: "bogus" }] })), "");
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

test("the configured wait also extends the broker's HTTP deadline", async t => {
    const previous = process.env.NETHACK_DECISION_TIMEOUT_MS;
    process.env.NETHACK_DECISION_TIMEOUT_MS = "1500";
    t.after(() => {
        if (previous === undefined) delete process.env.NETHACK_DECISION_TIMEOUT_MS;
        else process.env.NETHACK_DECISION_TIMEOUT_MS = previous;
    });
    const { broker, events } = await brokerFixture(t, async () => {
        await delay(550);
        return choice();
    });
    assert.equal(await exchange(broker, encounter()), "1 8 3 36 w\n");
    assert.equal(events[0].outcome, "applied");
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


test("projects a mixed action menu and the actor's observations into the API prompt", async t => {
    const potion = { class: "potion", type: "healing" };
    const r = encounter();
    r.history.push({ turn: 7, level: 3, action: "move", x: 4, y: 3, hp: 4 });
    r.characters.push({ species: "hill orc", x: 3, y: 2, relation: "ally" });
    r.inventory.push({ id: 7, item: potion, quantity: 1, equipped: false });
    r.floor.push({ x: 4, y: 3, item: { class: "weapon", type: "dagger" } });
    r.actions.push({ id: "defense_7", action: "use defensively", item: potion });
    const { broker } = await brokerFixture(t, (_url, { body }) => {
        const { input, questions: [q] } = JSON.parse(body);
        const evidence = input[0].content[0].data;
        for (const key of ["history", "inventory", "floor", "characters"])
            assert.deepEqual(evidence[key], r[key]);
        assert.equal(q.name, "action");
        assert.deepEqual(q.choices.map(c => c.value), r.actions.map(a => a.id));
        assert.match(q.choices.at(-1).description, /healing/);
        return choice("defense_7");
    });
    assert.equal(await exchange(broker, r), "1 8 3 36 defense_7\n");
    r.actions.push(r.actions.at(-1));
    assert.equal(await exchange(broker, r), "");
});
