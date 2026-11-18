import { createDecisionBroker } from "../../browser/broker.mjs";

const [socketPath, provider] = process.argv.slice(2);

async function mockFetch(_url, { body }) {
    const { questions } = JSON.parse(body);
    return Response.json({
        answers: questions.map(({ name, choices }) => ({
            name, type: "choice", choice: choices[0].value,
        })),
        usage: { input_tokens: 120 },
    });
}

const broker = await createDecisionBroker({
    socketPath,
    ...(provider === "mock" && { apiKey: "fixture", fetchImpl: mockFetch }),
    maxCalls: 1,
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
