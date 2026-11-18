import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';
import { startServer } from '../server.mjs';

async function connect(url, cookie) {
    const ws = new WebSocket(url.replace('http:', 'ws:') + '/game', {
        origin: url,
        headers: { Cookie: cookie },
    });
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    return {
        ws,
        input(data) {
            ws.send(JSON.stringify({ type: 'input', data }));
        },
        async find(predicate) {
            for (let i = 0; i < 100; i++) {
                const result = messages.find(predicate);
                if (result) return result;
                await delay(20);
            }
            assert.fail(`Expected message. Received ${JSON.stringify(messages)}`);
        },
    };
}

test('isolates game owners, reconnects to a menu and saves on hangup', async () => {
    const work = await mkdtemp(join(tmpdir(), 'nh-web-test-'));
    const assets = join(work, 'assets');
    const executable = join(work, 'game');
    const state = join(work, 'state');
    await mkdir(assets);
    await writeFile(join(assets, 'sysconf'), '# test\n');
    await writeFile(join(assets, 'map-data'), 'immutable');
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
process.stdin.setRawMode(true);
process.on('SIGHUP', () => {
    fs.writeFileSync('save/test', 'hangup saved');
    process.exit(0);
});
process.stdin.on('data', (buf) => process.stdout.write('input=' + buf));
process.stdout.write('game menu\\r\\n');
`, { mode: 0o700 });

    let server;
    try {
        server = await startServer({
            executable, assets, state, port: 0, graceMs: 250,
            async decisionFactory() {
                return { enabled: false, available: false, async close() {} };
            },
        });
        const url = `http://127.0.0.1:${server.address.port}`;
        assert.equal((await fetch(url)).status, 200);
        assert.equal((await fetch(url + '/api/session', {
            method: 'POST', headers: { Origin: 'https://unrelated.example' },
        })).status, 404);
        const unauthenticated = new WebSocket(url.replace('http:', 'ws:') + '/game', { origin: url });
        assert.match((await once(unauthenticated, 'error'))[0].message, /403/);

        async function createOwner() {
            const response = await fetch(url + '/api/session', {
                method: 'POST', headers: { Origin: url },
            });
            assert.equal(response.status, 204);
            return response.headers.get('set-cookie').split(';', 1)[0];
        }

        const owner = await createOwner();
        const anotherOwner = await createOwner();
        const first = await connect(url, owner);
        const second = await connect(url, anotherOwner);
        await first.find((msg) => msg.data?.includes('game menu'));
        await second.find((msg) => msg.data?.includes('game menu'));
        first.input('first-tab');
        await first.find((msg) => msg.type === 'data' && msg.data.includes('first-tab'));

        const tabReplaced = once(first.ws, 'close');
        const replacement = await connect(url, owner);
        assert.equal((await tabReplaced)[0], 4001);
        const snapshot = await replacement.find((msg) => msg.type === 'snapshot');
        assert.match(snapshot.data, /game menu/);
        assert.match(snapshot.data, /first-tab/);

        const secondClosed = once(second.ws, 'close');
        second.ws.close();
        await secondClosed;
        const resumed = await connect(url, anotherOwner);
        const otherSnapshot = await resumed.find((msg) => msg.type === 'snapshot');
        assert.match(otherSnapshot.data, /game menu/);
        assert.doesNotMatch(otherSnapshot.data, /first-tab/);
        resumed.ws.close();

        await delay(400);
        const folders = await readdir(state);
        assert.equal(folders.length, 2);
        assert.equal((await Promise.all(folders.map((folder) => (
            readFile(join(state, folder, 'save/test'), 'utf8').catch(() => undefined)
        )))).filter((value) => value === 'hangup saved').length, 1);

        await server.close();
        server = undefined;
        for (const folder of folders) {
            assert.equal(await readFile(join(state, folder, 'save/test'), 'utf8'), 'hangup saved');
            assert.equal(await readFile(join(state, folder, 'map-data'), 'utf8'), 'immutable');
        }
    } finally {
        await server?.close();
        await rm(work, { recursive: true, force: true });
    }
});
