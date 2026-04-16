/**
 * TrayConsole Bridge — Node.js обёртка для ralph-tracker-web.py.
 *
 * Запускает TrayConsole клиент (Named Pipe, heartbeat, mutex) и
 * спавнит Python web-сервер как дочерний процесс. Обрабатывает
 * shutdown/status/custom:open_dashboard от TrayConsole.
 *
 * trayconsole.json → start: "node trayconsole-bridge.js"
 */

const { spawn } = require('child_process');
const { execSync } = require('child_process');
const path = require('path');
const { TrayConsoleClient } = require('./trayconsole-client');

const WEB_PORT = 8767;
const PIPE_NAME = 'trayconsole_ralph2';
const SCRIPT_DIR = __dirname;

let pythonProc = null;

// --- Запуск Python web-сервера ---

function startPythonServer() {
    const pyScript = path.join(SCRIPT_DIR, 'ralph-tracker-web.py');
    pythonProc = spawn('python', [pyScript], {
        cwd: SCRIPT_DIR,
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
    });

    pythonProc.on('exit', (code) => {
        console.log(`[bridge] Python server exited with code ${code}`);
        // Если Python упал, останавливаем и bridge
        if (tc) tc.stop();
        process.exit(code || 0);
    });

    console.log(`[bridge] Python server started (PID: ${pythonProc.pid})`);
}

// --- Graceful shutdown ---

function shutdownPython() {
    if (!pythonProc || pythonProc.exitCode !== null) return;
    try {
        // Отправляем SIGTERM (на Windows — taskkill по PID)
        if (process.platform === 'win32') {
            execSync(`taskkill /PID ${pythonProc.pid} /F`, { stdio: 'ignore' });
        } else {
            pythonProc.kill('SIGTERM');
        }
    } catch { /* process already dead */ }
}

// --- TrayConsole клиент ---

const tc = new TrayConsoleClient(PIPE_NAME);

tc.on('status', () => {
    return {
        status: 'running',
        port: WEB_PORT,
        pythonPid: pythonProc ? pythonProc.pid : null,
        pythonAlive: pythonProc ? pythonProc.exitCode === null : false,
    };
});

tc.on('shutdown', () => {
    console.log(`[bridge] Graceful shutdown по команде TrayConsole...`);
    shutdownPython();
    return { status: 'ok' };
});

tc.on('custom:open_dashboard', () => {
    const { exec } = require('child_process');
    exec(`start http://localhost:${WEB_PORT}`);
    return { ok: true };
});

// --- Main ---

startPythonServer();
tc.start();

// Ctrl+C
process.on('SIGINT', () => {
    console.log('\n[bridge] Остановка по Ctrl+C...');
    shutdownPython();
    tc.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    shutdownPython();
    tc.stop();
    process.exit(0);
});
