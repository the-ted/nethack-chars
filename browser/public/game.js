'use strict';

const gameTerminal = document.querySelector('#game-terminal');
const gameStatus = document.querySelector('#game-status');
const startButton = document.querySelector('#start-game');
const decisionToggle = document.querySelector('#decision-toggle');
const decisionStatus = document.querySelector('#decision-status');
const terminal = new Terminal({
    cols: 80,
    rows: 25,
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: '"Cascadia Mono", "DejaVu Sans Mono", Consolas, monospace',
    fontSize: 15,
    lineHeight: 1.15,
    scrollback: 500,
    screenReaderMode: true,
    theme: {
        background: '#101612',
        foreground: '#d5e2d0',
        cursor: '#d2ec93',
        selectionBackground: '#394e3a',
        brightBlack: '#838f80',
        red: '#ec8e81',
        green: '#a4cf82',
        yellow: '#e3c281',
        blue: '#87a9e5',
        magenta: '#d7a6db',
        cyan: '#84cbc2',
        white: '#d5e2d0',
        brightWhite: '#f1f4ec',
    },
});
const fit = new FitAddon.FitAddon();
terminal.loadAddon(fit);
terminal.open(gameTerminal);

let socket;
let connected = false;
let retry;
let retryDelay = 500;
let waitingForStart = false;

function setStatus(text, active = false) {
    gameStatus.textContent = text;
    gameStatus.parentElement.classList.toggle('is-connected', active);
}

function send(message) {
    if (connected && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function updateSize() {
    const dimensions = fit.proposeDimensions();
    if (!dimensions) return;
    const cols = Math.max(80, Math.min(240, dimensions.cols));
    const rows = Math.max(24, Math.min(80, dimensions.rows));
    if (cols === terminal.cols && rows === terminal.rows) return;
    terminal.resize(cols, rows);
    send({ type: 'resize', cols, rows });
}

const observer = new ResizeObserver(() => {
    if (connected) updateSize();
});
observer.observe(gameTerminal);

function offerStart(label, message) {
    startButton.textContent = label;
    startButton.hidden = false;
    setStatus(message);
}

function openSocket() {
    const url = new URL('/game', location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    socket = ws;
    waitingForStart = false;
    ws.addEventListener('message', (event) => {
        if (ws !== socket) return;
        const message = JSON.parse(event.data);
        switch (message.type) {
        case 'snapshot':
            terminal.reset();
            terminal.resize(message.cols, message.rows);
            terminal.write(message.data, () => {
                if (ws !== socket || ws.readyState !== WebSocket.OPEN) return;
                connected = true;
                retryDelay = 500;
                setStatus('Game connected', true);
                updateSize();
                terminal.focus();
            });
            break;
        case 'data':
            terminal.write(message.data);
            break;
        case 'decisions':
            decisionToggle.disabled = !message.available;
            decisionToggle.checked = message.enabled;
            decisionStatus.textContent = message.available
                ? (message.notice || (message.enabled ? 'On' : 'Off'))
                : 'Unavailable';
            break;
        case 'exit':
            waitingForStart = true;
            offerStart('Open game', message.exitCode === 0 ? 'Game closed' : 'Game process exited');
            break;
        case 'error':
            waitingForStart = true;
            offerStart('Try again', message.message);
            break;
        }
    });
    ws.addEventListener('close', (event) => {
        if (ws !== socket) return;
        connected = false;
        decisionToggle.disabled = true;
        if (waitingForStart) return;
        if (event.code === 4001) {
            offerStart('Rejoin game', 'Game opened in another tab');
            return;
        }
        setStatus('Reconnecting…');
        retry = setTimeout(openSocket, retryDelay);
        retryDelay = Math.min(8000, retryDelay * 2);
    });
}

async function start() {
    window.clearTimeout(retry);
    startButton.hidden = true;
    setStatus('Opening game…');
    try {
        const response = await fetch('/api/session', { method: 'POST' });
        if (!response.ok) throw new Error('Session unavailable');
        if (socket) {
            const previous = socket;
            socket = undefined;
            previous.close();
        }
        openSocket();
    } catch {
        offerStart('Try again', 'Connection unavailable');
    }
}

terminal.onData((data) => send({ type: 'input', data }));
terminal.onBinary((bytes) => send({ type: 'binary-input', data: bytes }));
// NetHack's Unix TTY expects vi keys as its default movement bindings.
const arrowKeys = { ArrowLeft: 'h', ArrowDown: 'j', ArrowUp: 'k', ArrowRight: 'l' };
terminal.attachCustomKeyEventHandler((event) => {
    const movement = arrowKeys[event.key];
    if (!movement || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true;
    if (event.type === 'keydown') {
        event.preventDefault();
        send({ type: 'input', data: movement });
    }
    return false;
});
decisionToggle.addEventListener('change', () => {
    send({ type: 'decisions', enabled: decisionToggle.checked });
    terminal.focus();
});
startButton.addEventListener('click', start);
void start();
