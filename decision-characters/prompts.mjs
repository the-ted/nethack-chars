// C includes this same config to map enabled PM_* constants to wire names.
// Prompt literals allow plain text, escaped quotes, and escaped backslashes.
import { readFileSync } from "node:fs";

const file = new URL("../include/decision_prompts.conf", import.meta.url);
const sentences = [];
const speciesIds = new Set();
export const monsterPrompts = new Map();
const literal = String.raw`("(?:[^"\\\x00-\x1f]|\\["\\])*")`;
const overall = new RegExp(`^DECISION_OVERALL\\(\\s*${literal}\\s*\\)$`);
const species = new RegExp(`^DECISION_SPECIES\\(\\s*(PM_[A-Z0-9_]+)\\s*,\\s*"([a-z0-9 -]+)"\\s*,\\s*${literal}\\s*\\)$`);

for (const [i, raw] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || (line.startsWith("/*") && line.endsWith("*/"))) continue;
    const shared = overall.exec(line);
    if (shared) {
        const prompt = JSON.parse(shared[1]);
        if (!prompt.trim()) throw new Error(`Empty overall prompt at line ${i + 1} of decision_prompts.conf`);
        sentences.push(prompt);
        continue;
    }
    const entry = species.exec(line);
    if (!entry) throw new Error(`Invalid declaration at line ${i + 1} of decision_prompts.conf`);
    const [, id, name, quotedPrompt] = entry;
    const prompt = JSON.parse(quotedPrompt);
    if (!prompt.trim() || !name.trim() || speciesIds.has(id) || monsterPrompts.has(name))
        throw new Error(`Empty or duplicate species entry at line ${i + 1} of decision_prompts.conf`);
    speciesIds.add(id);
    monsterPrompts.set(name, prompt);
}
if (!sentences.length || !monsterPrompts.size)
    throw new Error("decision_prompts.conf needs shared instructions and at least one monster");
export const overallPrompt = sentences.join(" ");
