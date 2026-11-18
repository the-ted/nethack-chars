import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const serverEntry = fileURLToPath(new URL('../server.mjs', import.meta.url));
const installedAssets = process.env.NETHACK_ASSETS
  ?? fileURLToPath(new URL('../../build/stage/games/lib/nethackdir', import.meta.url));
const executable = process.env.NETHACK_BIN ?? join(installedAssets, 'nethack');
const scratch = await mkdtemp(join(tmpdir(), 'nethack-browser-test-'));
const state = join(scratch, 'state');
const browserEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: scratch };

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => (
    error ? reject(error) : resolve()
  )));
  return port;
}

async function waitFor(check, description, timeout = 8000, interval = 40) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(interval);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const port = await availablePort();
const url = `http://127.0.0.1:${port}/`;
let server;
let browser;
let serverOutput = '';

async function startServer(assets = installedAssets) {
  serverOutput = '';
  server = spawn(process.execPath, [serverEntry], {
    env: {
      ...browserEnv,
      PORT: String(port),
      NETHACK_BIN: executable,
      NETHACK_ASSETS: assets,
      NETHACK_WEB_STATE: state,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { serverOutput = (serverOutput + chunk).slice(-10000); });
  }
  await waitFor(async () => {
    if (server.exitCode !== null) throw new Error('Game server exited at startup');
    return fetch(url).then((response) => response.ok, () => false);
  }, 'the game server');
}

async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const done = once(server, 'exit');
  server.kill('SIGTERM');
  const timer = setTimeout(() => server.kill('SIGKILL'), 8000);
  try {
    const [code, signal] = await done;
    assert.equal(signal, null, 'server handled SIGTERM gracefully');
    assert.equal(code, 0, 'server exited successfully');
  } finally {
    clearTimeout(timer);
  }
}

async function terminalRows(page) {
  return (await page.locator('#game-terminal .xterm-rows > div').allTextContents())
    .map((line) => line.replaceAll('\u00a0', ' '));
}

async function expectScreen(page, pattern) {
  try {
    return await waitFor(async () => {
      const rows = await terminalRows(page);
      return pattern.test(rows.join('\n')) && rows;
    }, pattern.toString());
  } catch (error) {
    throw new Error(`${error.message}\n${(await terminalRows(page)).join('\n')}`, { cause: error });
  }
}

async function key(page, value) {
  await page.locator('#game-terminal .xterm-helper-textarea').focus();
  await page.keyboard.press(value);
}

async function startCharacter(page, name) {
  for (let i = 0; i < 16; i += 1) {
    const screen = (await expectScreen(page,
      /Who are you\? *$|Shall I pick|--More--|Is this ok|Do you want to|Dlvl:\s*1/imu)).join('\n');
    if (screen.includes('--More--')) await key(page, 'Space');
    else if (/Do you want a tutorial\?/iu.test(screen)) await key(page, 'n');
    else if (/Is this ok|Do you want to/iu.test(screen) && !/Dlvl:\s*1/u.test(screen)) {
      await key(page, 'y');
    } else if (/Shall I pick/iu.test(screen)) await key(page, 'a');
    else if (/Who are you\? *$/imu.test(screen)) {
      await page.locator('#game-terminal .xterm-helper-textarea').focus();
      await page.keyboard.type(name);
      await key(page, 'Enter');
    } else if (/Dlvl:\s*1/u.test(screen)) {
      return;
    }
    await delay(90);
  }
  throw new Error('Could not complete character creation');
}

function hero(rows) {
  for (let y = 1; y < rows.length - 2; y += 1) {
    const x = rows[y].indexOf('@');
    if (x !== -1) return { x, y };
  }
  throw new Error(`Hero not found in terminal:\n${rows.join('\n')}`);
}

async function moveHero(page) {
  const rows = await expectScreen(page, /Dlvl:\s*1/u);
  const before = hero(rows);
  for (const [dx, dy, direction] of [
    [1, 0, 'ArrowRight'], [-1, 0, 'ArrowLeft'], [0, 1, 'ArrowDown'], [0, -1, 'ArrowUp'],
  ]) {
    if (!/[.#<>{]/u.test(rows[before.y + dy]?.[before.x + dx] ?? '')) continue;
    await key(page, direction);
    await delay(120);
    const after = hero(await terminalRows(page));
    if (after.x !== before.x || after.y !== before.y) return;
  }
  throw new Error(`Could not move using browser keyboard:\n${rows.join('\n')}`);
}

async function showInventory(page) {
  await key(page, 'i');
  await expectScreen(page, /Weapons|Armor|Comestibles/u);
}

async function prepareFixtureAssets() {
  const assets = join(scratch, 'fixture-assets');
  await cp(installedAssets, assets, { recursive: true, dereference: true });
  const fixtureDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
  await cp(fixtureDir, assets, { recursive: true });
  const dungeonPath = join(assets, 'dungeon.lua');
  const dungeon = await readFile(dungeonPath, 'utf8');
  const patched = dungeon.replace('levels = {', `levels = {
         {name = "wbr-first", base = 1},
         {name = "wbr-next", base = 2},`);
  assert.notEqual(patched, dungeon, 'fixture floors registered in the copied dungeon');
  await writeFile(dungeonPath, patched);
  await appendFile(join(assets, 'sysconf'), '\nOPTIONS=role:valkyrie,race:human,gender:female,'
    + 'align:lawful,pettype:none,!news,!tutorial,!autopickup\n');
  return assets;
}

async function step(page, dx) {
  const position = hero(await terminalRows(page));
  const start = performance.now();
  await key(page, dx === 1 ? 'l' : 'h');
  await waitFor(async () => {
    const now = hero(await terminalRows(page));
    return now.x === position.x + dx && now.y === position.y;
  }, 'horizontal redraw after movement', 1500, 5);
  return performance.now() - start;
}

async function playCombatFloor(page, observations) {
  await startCharacter(page, 'Mira');
  await expectScreen(page, /\|@F\(\.\.>/u);
  for (let i = 0; i < 12; i += 1) {
    await key(page, 'l');
    await delay(65);
    const screen = (await terminalRows(page)).join('\n');
    if (screen.includes('--More--')) await key(page, 'Space');
    if (screen.includes('You kill the lichen')) break;
    assert.ok(i < 11, 'the player defeated the lichen using ordinary combat');
  }
  await step(page, 1);
  await step(page, 1);
  await key(page, ',');
  const lamp = /([a-zA-Z]) - an? (?:oil )?lamp named Browser Test/u;
  const pickup = (await expectScreen(page, lamp)).join('\n');
  const slot = pickup.match(lamp)[1];
  await key(page, 'a');
  await expectScreen(page, /What do you want to use/u);
  await key(page, slot);
  await expectScreen(page, /is now on\./u);

  const timings = [];
  for (let i = 0; i < 24; i += 1) timings.push(await step(page, i % 2 === 0 ? -1 : 1));
  timings.sort((a, b) => a - b);
  observations.push(`keyless movement redraw p50 ${timings[11].toFixed(1)} ms, p95 ${timings[22].toFixed(1)} ms, ${timings.length} keys`);
  for (let i = 0; i < 3; i += 1) await step(page, 1);
  await key(page, '>');
  const descent = (await expectScreen(page, /You descend the stairs|Dlvl:\s*2/u)).join('\n');
  if (descent.includes('--More--')) await key(page, 'Space');
  await expectScreen(page, /Dlvl:\s*2/u);
  observations.push('defeated a monster, picked up and used a lamp, and descended to level 2');

  for (let i = 0; i < 32; i += 1) {
    if (await page.locator('#start-game').isVisible()) break;
    const screen = (await terminalRows(page)).join('\n');
    if (/--More--|\(end\)|\(\d+ of \d+\)/u.test(screen)) await key(page, 'Space');
    else if (/Do you want|Would you like/u.test(screen)) await key(page, 'n');
    else await key(page, 'l');
    await delay(90);
  }
  await page.locator('#start-game').waitFor({ state: 'visible' });
  const sessions = await readdir(state);
  const records = await Promise.all(sessions.map((id) => readFile(join(state, id, 'record'), 'utf8')));
  assert.ok(records.some((record) => /Mira.*minotaur/iu.test(record)), 'normal death recorded a score');
  await page.locator('#start-game').click();
  await startCharacter(page, 'Nora');
  await expectScreen(page, /Dlvl:\s*1/u);
  observations.push('died in normal gameplay, recorded a score, and started a new character');
}

const observations = [];

try {
  await startServer();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_BIN || '/usr/bin/chromium',
    env: browserEnv,
  });
  const firstContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const secondContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  first.setDefaultTimeout(8000);
  second.setDefaultTimeout(8000);
  await Promise.all([first.goto(url), second.goto(url)]);
  try {
    await Promise.all([startCharacter(first, 'Elin'), startCharacter(second, 'Runa')]);
    await first.locator('#decision-status').getByText('Unavailable', { exact: true }).waitFor();
    assert.ok(await first.locator('#decision-toggle').isDisabled(), 'keyless mode disables live calls');
    observations.push('created two characters in separate browser contexts with keyless fallback');

    const otherScreen = await terminalRows(second);
    await moveHero(first);
    await showInventory(first);
    assert.deepEqual(await terminalRows(second), otherScreen, 'input changed only the owning game');
    observations.push('moved with arrow keys and opened inventory with isolated input');

    await first.reload();
    await expectScreen(first, /Weapons|Armor|Comestibles/u);
    await key(first, 'Escape');
    await key(first, 'S');
    await expectScreen(first, /Really save\?/u);
    await key(first, 'y');
    await delay(120);
    if ((await terminalRows(first)).join('\n').includes('--More--')) await key(first, 'Space');
    await first.locator('#start-game').waitFor({ state: 'visible' });
    observations.push('reattached to an active inventory menu and explicitly saved');

    await showInventory(second);
    await stopServer();
    const sessionDirs = await readdir(state);
    assert.ok(sessionDirs.length >= 2, 'two games had separate state directories');
    await startServer();
    await Promise.all([first.reload(), second.reload()]);
    await Promise.all([[first, 'Elin', 'Runa'], [second, 'Runa', 'Elin']].map(async ([page, name, other]) => {
      const savedMenu = (await expectScreen(page, /Select one of your saved games/u)).join('\n');
      assert.match(savedMenu, new RegExp(`a - ${name}-`, 'u'));
      assert.ok(!savedMenu.includes(other), 'only the owning player’s save appears');
      await key(page, 'a');
      await expectScreen(page, /Dlvl:\s*1/u);
      const screen = (await terminalRows(page)).join('\n');
      assert.doesNotMatch(screen, /Shall I pick/u, 'existing game restored across a server restart');
      if (screen.includes('--More--')) await key(page, 'Space');
      await showInventory(page);
      await key(page, 'Escape');
    }));
    observations.push('restored an explicit save and a shutdown save after restarting the server');
  } catch (error) {
    console.error('First terminal:\n' + (await terminalRows(first)).join('\n'));
    console.error('Second terminal:\n' + (await terminalRows(second)).join('\n'));
    throw error;
  }
  await firstContext.close();
  await secondContext.close();
  await stopServer();
  await startServer(await prepareFixtureAssets());
  const fixture = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  fixture.setDefaultTimeout(8000);
  await fixture.goto(url);
  try {
    await playCombatFloor(fixture, observations);
  } catch (error) {
    console.error('Combat fixture terminal:\n' + (await terminalRows(fixture)).join('\n'));
    throw error;
  }
  for (const observation of observations) console.log(`PASS ${observation}`);
} catch (error) {
  console.error(serverOutput);
  throw error;
} finally {
  try {
    await browser?.close();
    await stopServer();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
