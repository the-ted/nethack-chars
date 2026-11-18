import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, open, readdir, readFile, realpath, rmdir, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import pty from 'node-pty';
import { WebSocket, WebSocketServer } from 'ws';
import { createDecisionBroker } from './broker.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const browser = fileURLToPath(new URL('./', import.meta.url));
const cookieName = 'nethack_owner';
const files = new Map([
    ['/', ['public/index.html', 'text/html']],
    ['/game.js', ['public/game.js', 'text/javascript']],
    ['/game.css', ['public/game.css', 'text/css']],
    ['/xterm.js', ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript']],
    ['/xterm.css', ['node_modules/@xterm/xterm/css/xterm.css', 'text/css']],
    ['/xterm-fit.js', ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript']],
]);
const writableFiles = ['perm', 'record', 'logfile', 'xlogfile', 'livelog'];
const excludedAssets = new Set(['nethack', 'recover', 'save', 'sysconf', ...writableFiles]);
const startupSize = { cols: 80, rows: 25 };
const decisionNotices = new Map([
    ['authentication', 'API authorization failed'],
    ['authentication_backoff', 'API authorization failed'],
    ['rate_limited', 'API rate limited'],
    ['rate_limit_backoff', 'API rate limited'],
    ['session_limit', 'Session limit reached'],
]);

function sessionToken(req) {
    const match = req.headers.cookie?.match(/(?:^|;\s*)nethack_owner=([a-f0-9]{64})(?:;|$)/);
    return match?.[1];
}

function sameOrigin(req, expected) {
    const origin = req.headers.origin;
    if (expected) return origin === expected;
    try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:')
            && url.host === req.headers.host;
    } catch {
        return false;
    }
}

function send(ws, message) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) {
        ws.terminate();
        return;
    }
    ws.send(JSON.stringify(message));
}

function mkdirPrivate(path) {
    return mkdir(path, { recursive: true, mode: 0o700 });
}

async function createFile(path) {
    const handle = await open(path, 'a', 0o600);
    await handle.close();
}

async function prepareMacPty() {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve('node-pty/package.json'));
    // node-pty launches the helper next to the loaded addon. Its macOS
    // prebuilt helpers ship without execute permission in the npm package.
    const addon = Object.keys(require.cache).find((path) => (
        path.startsWith(packageRoot + sep) && basename(path) === 'pty.node'
    ));
    if (!addon) throw new Error('Could not locate the loaded node-pty addon for macOS.');
    const helper = join(dirname(addon), 'spawn-helper');
    const { mode } = await stat(helper);
    if (!(mode & constants.S_IXUSR)) {
        await chmod(helper, mode | constants.S_IXUSR);
    }
    await access(helper, constants.X_OK);
}

export async function startServer({
    assets = resolve(process.env.NETHACK_ASSETS ?? join(root, 'build/stage/games/lib/nethackdir')),
    executable = resolve(process.env.NETHACK_BIN ?? join(assets, 'nethack')),
    state = resolve(process.env.NETHACK_WEB_STATE ?? join(root, 'build/web-state')),
    host = process.env.NETHACK_WEB_HOST ?? '127.0.0.1',
    port = Number(process.env.PORT ?? 8080),
    origin = process.env.NETHACK_WEB_ORIGIN,
    graceMs = 120_000,
    maxActive = 16,
    decisionFactory = createDecisionBroker,
} = {}) {
    if (process.platform === 'darwin') await prepareMacPty();
    await access(executable, constants.X_OK);
    await access(join(assets, 'sysconf'), constants.R_OK);
    await mkdirPrivate(state);
    if ((await stat(state)).mode & 0o077) {
        throw new Error('NETHACK_WEB_STATE must be private (chmod 700)');
    }
    const assetDir = await realpath(assets);
    const assetFiles = (await readdir(assetDir, { withFileTypes: true }))
        .filter((file) => file.isFile() && !excludedAssets.has(file.name));
    const staticFiles = new Map(await Promise.all([...files].map(async ([url, [name, type]]) => (
        [url, { body: await readFile(join(browser, name)), type }]
    ))));
    const sessions = new Map();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
    let stopping = false;

    async function startGame(id, readyToArchive) {
        const path = join(state, id);
        await mkdirPrivate(path);
        await mkdirPrivate(join(path, 'save'));
        await Promise.all([
            ...writableFiles.map((name) => createFile(join(path, name))),
            ...assetFiles.map(async ({ name }) => {
                try {
                    await symlink(join(assetDir, name), join(path, name));
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                }
            }),
            copyFile(join(assetDir, 'sysconf'), join(path, 'sysconf')),
        ]);

        const socketDir = await mkdtemp(join(tmpdir(), 'nhd-'));
        let broker;
        let owner;
        let notice;
        function updateOptions(ws) {
            if (!broker) return;
            send(ws, {
                type: 'decisions',
                enabled: broker.enabled,
                available: broker.available,
                notice: broker.enabled ? notice : undefined,
            });
        }
        const mirror = new headless.Terminal({ ...startupSize, allowProposedApi: true, scrollback: 500 });
        try {
            broker = await decisionFactory({
                socketPath: join(socketDir, 's'),
                enabled: process.env.NETHACK_DECISIONS !== 'off',
                onEvent(event) {
                    const nextNotice = decisionNotices.get(event.reason);
                    if (nextNotice !== notice && event.reason !== 'disabled') {
                        notice = nextNotice;
                        updateOptions(owner);
                    }
                    if (process.env.NETHACK_DECISION_LOG === '1') {
                        console.info(JSON.stringify({ event: 'decision', ...event }));
                    }
                },
            });
            const child = pty.spawn(executable, ['-u', 'player'], {
                name: 'xterm-256color',
                cwd: path,
                ...startupSize,
                env: {
                    PATH: '/usr/bin:/bin',
                    HOME: path,
                    LANG: 'C.UTF-8',
                    NETHACKDIR: path,
                    NETHACKOPTIONS: 'selectsaved',
                    ...(broker.socketPath ? { NETHACK_DECISION_SOCKET: broker.socketPath } : {}),
                },
            });
            let pendingOutput;
            let exited = false;
            let disconnectTimer;
            let exitInfo;
            const serializer = new serialize.SerializeAddon();
            mirror.loadAddon(serializer);

            let resolveExit;
            const done = new Promise((resolveDone) => { resolveExit = resolveDone; });

            async function finish() {
                try {
                    await broker.close();
                    await rmdir(socketDir);
                } catch (error) {
                    console.error('Unable to clean up a game session', error.message);
                } finally {
                    mirror.dispose();
                    readyToArchive();
                    send(owner, exitInfo);
                    owner?.close(1000);
                    resolveExit();
                }
            }

            child.onData((data) => {
                // Update the terminal mirror even with no connected client.
                mirror.write(data);
                if (!owner) return;
                if (pendingOutput !== undefined) {
                    pendingOutput += data;
                } else {
                    send(owner, { type: 'data', data });
                }
            });
            child.onExit(({ exitCode, signal }) => {
                exited = true;
                pendingOutput = undefined;
                clearTimeout(disconnectTimer);
                exitInfo = { type: 'exit', exitCode, signal };
                // onData may be queued ahead of this exit. Flush the mirror first.
                mirror.write('', () => { void finish(); });
            });

            function stop() {
                if (exited) return done;
                clearTimeout(disconnectTimer);
                // NetHack's hangup handler saves an in-progress game before exiting.
                child.kill('SIGHUP');
                return done;
            }

            function scheduleDisconnect() {
                disconnectTimer = setTimeout(() => { void stop(); }, graceMs);
                disconnectTimer.unref();
            }
            scheduleDisconnect();

            return {
                stop,
                attach(ws) {
                    if (exited) {
                        send(ws, exitInfo);
                        ws.close(1000);
                        return;
                    }
                    clearTimeout(disconnectTimer);
                    owner?.close(4001, 'Game opened in another tab');
                    owner = ws;
                    pendingOutput = '';
                    ws.once('close', () => {
                        if (ws !== owner) return;
                        owner = undefined;
                        pendingOutput = undefined;
                        if (!exited) scheduleDisconnect();
                    });
                    mirror.write('', () => {
                        if (ws !== owner || exited) return;
                        send(ws, {
                            type: 'snapshot',
                            data: serializer.serialize(),
                            cols: mirror.cols,
                            rows: mirror.rows,
                        });
                        if (pendingOutput) send(ws, { type: 'data', data: pendingOutput });
                        pendingOutput = undefined;
                        updateOptions(ws);
                    });
                    ws.on('message', (data, binary) => {
                        if (ws !== owner || pendingOutput !== undefined || exited || binary || stopping) return;
                        let msg;
                        try {
                            msg = JSON.parse(data.toString());
                        } catch {
                            return;
                        }
                        if (!msg || typeof msg !== 'object') return;
                        if ((msg.type === 'input' || msg.type === 'binary-input')
                            && typeof msg.data === 'string' && msg.data.length <= 4096) {
                            child.write(msg.type === 'input' ? msg.data : Buffer.from(msg.data, 'latin1'));
                        } else if (msg.type === 'resize'
                            && Number.isInteger(msg.cols) && msg.cols >= 80 && msg.cols <= 240
                            && Number.isInteger(msg.rows) && msg.rows >= 24 && msg.rows <= 80) {
                            // Keep the PTY and snapshot in the same coordinate space.
                            mirror.resize(msg.cols, msg.rows);
                            child.resize(msg.cols, msg.rows);
                        } else if (msg.type === 'decisions' && typeof msg.enabled === 'boolean') {
                            broker.setEnabled(msg.enabled);
                            updateOptions(ws);
                        }
                    });
                },
            };
        } catch (error) {
            mirror.dispose();
            await broker?.close();
            await rmdir(socketDir);
            throw error;
        }
    }

    const server = createServer((req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy',
            "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; "
            + "font-src 'self' data:; img-src 'self' data:; object-src 'none'; "
            + "base-uri 'none'; frame-ancestors 'none'");
        if (req.url === '/api/session' && req.method === 'POST' && sameOrigin(req, origin)) {
            if (!sessionToken(req)) {
                const secure = req.headers.origin?.startsWith('https:') ? '; Secure' : '';
                res.setHeader('Set-Cookie',
                    `${cookieName}=${randomBytes(32).toString('hex')}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`);
            }
            res.writeHead(204).end();
            return;
        }
        const asset = (req.method === 'GET' || req.method === 'HEAD') && staticFiles.get(req.url);
        if (asset) {
            res.writeHead(200, {
                'Content-Type': `${asset.type}; charset=utf-8`,
                'Content-Length': asset.body.length,
            }).end(req.method === 'HEAD' ? undefined : asset.body);
        } else {
            res.writeHead(404).end('Not found');
        }
    });

    server.on('upgrade', (req, socket, head) => {
        const token = sessionToken(req);
        if (req.url !== '/game' || !token || !sameOrigin(req, origin) || stopping) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, async (ws) => {
            ws.on('error', () => ws.terminate());
            ws.alive = true;
            ws.on('pong', () => { ws.alive = true; });
            const id = createHash('sha256').update(token).digest('hex');
            let game = sessions.get(id);
            if (!game && sessions.size >= maxActive) {
                send(ws, { type: 'error', message: 'All game slots are occupied. Try again shortly.' });
                ws.close(1013);
                return;
            }
            if (!game) {
                game = startGame(id, () => sessions.delete(id));
                sessions.set(id, game);
            }
            try {
                const session = await game;
                if (ws.readyState === WebSocket.OPEN && !stopping) session.attach(ws);
            } catch (error) {
                sessions.delete(id);
                console.error('Unable to start NetHack', error.message);
                send(ws, { type: 'error', message: 'Unable to launch NetHack.' });
                ws.close(1011);
            }
        });
    });

    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.alive) {
                ws.terminate();
                continue;
            }
            ws.alive = false;
            ws.ping();
        }
    }, 20_000);
    heartbeat.unref();
    await new Promise((resolveListening, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolveListening);
    });

    return {
        address: server.address(),
        async close() {
            if (stopping) return;
            stopping = true;
            clearInterval(heartbeat);
            const closeHttp = new Promise((resolveClose) => server.close(resolveClose));
            for (const ws of wss.clients) ws.close(1001, 'Server stopping');
            await Promise.allSettled([...sessions.values()].map(async (game) => (await game).stop()));
            for (const ws of wss.clients) ws.terminate();
            await closeHttp;
        },
    };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        const service = await startServer();
        console.log(`NetHack listening on http://${service.address.address}:${service.address.port}`);
        const exit = () => { void service.close(); };
        process.once('SIGINT', exit);
        process.once('SIGTERM', exit);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
