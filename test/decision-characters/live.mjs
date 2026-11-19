import assert from "node:assert/strict";
import { monsterPrompts, overallPrompt } from "../../decision-characters/prompts.mjs";
import { createDecisionBroker } from "../../decision-characters/broker.mjs";

const [socketPath, provider, fixture] = process.argv.slice(2);

async function mockFetch(_url, { body }) {
    const { questions, input } = JSON.parse(body);
    const scene = input[0].content[0].data;
    function select({ choices }) {
        if (fixture === "roster") {
            assert.equal(questions[0].instructions, overallPrompt + " " + monsterPrompts.get(scene.species));
            assert.deepEqual([scene.x, scene.y, scene.hp, scene.max_hp], [10, 10, 24, 24]);
            assert.ok(scene.target && choices.some(c => c.value === "native"));
            if (!scene.history.length) return "wait";
            assert.equal(scene.history.at(-1).action, "wait");
            return choices.find(c => c.description.startsWith("move,") && /^[nsew]{1,2}$/.test(c.value)).value;
        }
        if (fixture === "items") {
            if (!scene.history.length)
                return choices.find(c => c.value.startsWith("defense_") && c.description.endsWith("/ healing")).value;
            if (scene.history.at(-1).item.type !== "healing" || scene.hp <= 6
                || scene.inventory.some(s => s.item.type === "healing"))
                throw new Error("Provider received inconsistent action history");
            return "wait";
        }
        if (fixture === "melee") return "melee";
        return choices[0].value;
    }
    return Response.json({
        answers: questions.map(q => ({
            name: q.name, type: "choice", choice: select(q),
        })),
        usage: { input_tokens: 120 },
    });
}

const broker = await createDecisionBroker({
    socketPath,
    ...(provider === "mock" && { apiKey: "fixture", fetchImpl: mockFetch }),
    maxCalls: provider === "mock" && ["items", "roster"].includes(fixture) ? 2 : 1,
    onEvent(event) {
        console.log(JSON.stringify(event));
    },
});

if (!broker.available) {
    await broker.close();
    throw new Error("Decisions broker requires OPENAI_API_KEY");
}
process.on("SIGTERM", async () => {
    await broker.close();
    process.exitCode = 0;
});
console.log("READY");
