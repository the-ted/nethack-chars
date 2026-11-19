import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDecisionBroker } from "./broker.mjs";

const socketPath = process.argv[2];
if (!socketPath) throw new Error("The Decisions broker requires a socket path.");

const log = process.env.NETHACK_DECISION_LOG;
const writeLog = event => console.log(JSON.stringify(event));
const broker = await createDecisionBroker({
    socketPath,
    onEvent: log === "1" || log === "requests" ? writeLog : undefined,
    onRequest: log === "requests" ? writeLog : undefined,
});
if (!broker.available) throw new Error("The Decisions broker requires OPENAI_API_KEY.");

const stop = () => {
    void broker.close().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
};
process.on("SIGHUP", stop);
process.on("SIGTERM", stop);

// The foreground game handles terminal interrupts such as Ctrl-C.
process.on("SIGINT", () => {});
await writeFile(join(dirname(socketPath), "ready"), "", { mode: 0o600 }).catch(async (error) => {
    await broker.close();
    throw error;
});
