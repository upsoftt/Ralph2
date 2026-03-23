/**
 * Ralph 2.0 Idea Worker — мини-overseer для анализа идей через PTY
 * Использует тот же механизм что и ralph-overseer.js:
 * node-pty + boot sequence + JSONL → полный доступ к скиллам Claude Code
 *
 * Usage: node ralph-idea.js <projectDir> <ideaText> [ideaText2] ...
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');
const stripAnsi = require('strip-ansi');
const { getAgent } = require('./agents');

const projectDir = process.argv[2];
if (!projectDir) { console.error('Usage: node ralph-idea.js <projectDir> <idea1> [idea2] ...'); process.exit(1); }

const ideas = process.argv.slice(3);
if (ideas.length === 0) { console.error('No ideas provided'); process.exit(1); }

const agent = getAgent('claude');
const sessionId = crypto.randomUUID();
const claudeProjectsDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'projects');

function projectSlug(dir) {
    return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

const jsonlPath = path.join(claudeProjectsDir, projectSlug(projectDir), `${sessionId}.jsonl`);
let jsonlReadPos = 0;
let jsonlBuffer = '';
let logicalBuffer = '';
let bootStepsDone = new Set();
let lastThinkingTime = 0;
let ptyProcess = null;

// Strip ANSI + control chars
function superStrip(s) {
    return stripAnsi(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function isThinkingSignal(clean, lower) {
    if (agent.patterns.thinkingRegex && agent.patterns.thinkingRegex.test(clean)) return true;
    return agent.patterns.thinking.some(p => lower.includes(p));
}

// JSONL reader — same as overseer
function readJsonlChunk() {
    try {
        if (!fs.existsSync(jsonlPath)) return;
        const stat = fs.statSync(jsonlPath);
        if (stat.size <= jsonlReadPos) return;
        const fd = fs.openSync(jsonlPath, 'r');
        const buf = Buffer.alloc(stat.size - jsonlReadPos);
        fs.readSync(fd, buf, 0, buf.length, jsonlReadPos);
        fs.closeSync(fd);
        jsonlReadPos = stat.size;
        const chunk = buf.toString('utf8');
        for (const line of chunk.split('\n')) {
            if (!line.trim()) continue;
            try {
                const obj = JSON.parse(line);
                if (obj.type === 'assistant' && obj.message && obj.message.content) {
                    for (const block of obj.message.content) {
                        if (block.type === 'text' && block.text) {
                            jsonlBuffer += block.text + '\n';
                        }
                    }
                }
            } catch (e) {}
        }
    } catch (e) {}
}

let jsonlWatcherInterval = null;
function startJsonlWatcher() {
    jsonlWatcherInterval = setInterval(readJsonlChunk, 2000);
}
function stopJsonlWatcher() {
    if (jsonlWatcherInterval) clearInterval(jsonlWatcherInterval);
}

// Wait for a condition in JSONL buffer
function waitForCondition(checkFn, timeoutSec) {
    return new Promise(resolve => {
        const start = Date.now();
        const interval = setInterval(() => {
            readJsonlChunk();
            const result = checkFn(jsonlBuffer);
            if (result) {
                clearInterval(interval);
                resolve(result);
                return;
            }
            if (Date.now() - start > timeoutSec * 1000) {
                // Check if still thinking
                if (lastThinkingTime && (Date.now() - lastThinkingTime) < 60000) {
                    // Still active, extend timeout
                    return;
                }
                clearInterval(interval);
                resolve(null);
            }
        }, 3000);
    });
}

function sendCommand(cmd) {
    logicalBuffer = '';
    jsonlBuffer = '';
    jsonlReadPos = 0; // Reset to catch fresh output
    try { if (fs.existsSync(jsonlPath)) jsonlReadPos = fs.statSync(jsonlPath).size; } catch(e) {}
    ptyProcess.write(cmd.replace(/\n/g, ' ') + '\r');
}

// ─── MAIN ───
(async () => {
    console.log(`[IDEA] Starting idea worker for ${projectDir}`);
    console.log(`[IDEA] Ideas: ${ideas.length}`);
    console.log(`[IDEA] Session: ${sessionId}`);

    const ptyArgs = [...agent.args, '--session-id', sessionId];
    ptyProcess = pty.spawn(agent.command, ptyArgs, {
        name: 'xterm-color',
        ...agent.pty,
        cwd: projectDir,
        env: { ...process.env, RALPH_NODE_HEAP: '8192', ...agent.env },
    });

    ptyProcess.onData((data) => {
        const clean = superStrip(data);
        const lower = clean.toLowerCase();
        logicalBuffer += clean;

        // Boot sequence
        if (agent.bootSequence) {
            for (let i = 0; i < agent.bootSequence.length; i++) {
                if (bootStepsDone.has(i)) continue;
                const step = agent.bootSequence[i];
                if (lower.includes(step.wait)) {
                    bootStepsDone.add(i);
                    console.log(`[IDEA] Boot: ${step.desc}`);
                    setTimeout(() => ptyProcess.write(step.send), step.delay || 500);
                    break;
                }
            }
        }

        // Track thinking activity
        if (isThinkingSignal(clean, lower)) {
            lastThinkingTime = Date.now();
        }
    });

    ptyProcess.onExit(({ exitCode }) => {
        console.log(`[IDEA] PTY exited with code ${exitCode}`);
        stopJsonlWatcher();
        process.exit(exitCode || 0);
    });

    // Wait for boot (ready pattern)
    console.log('[IDEA] Waiting for boot...');
    let booted = false;
    for (let i = 0; i < 120; i++) {
        await delay(1000);
        const low = logicalBuffer.toLowerCase();
        if (agent.patterns.ready.some(p => low.includes(p))) { booted = true; break; }
    }
    if (!booted) { console.error('[IDEA] Boot timeout'); ptyProcess.kill(); process.exit(1); }

    console.log('[IDEA] Boot OK, stabilizing...');
    await delay(3000);
    logicalBuffer = '';

    // Start JSONL watcher
    startJsonlWatcher();

    // Send init command
    const initCmd = 'Прочитай PRD.md, CLAUDE.md, planning.md и tasks.md. Когда прочитаешь — выведи одно слово: RALPH_READY';
    sendCommand(initCmd);

    const readyCheck = (buf) => buf.includes('RALPH_READY') ? 'READY' : null;
    let ready = await waitForCondition(readyCheck, 300);
    if (!ready) {
        console.error('[IDEA] Init timeout — Claude did not respond RALPH_READY');
        ptyProcess.kill();
        process.exit(1);
    }
    console.log('[IDEA] Init OK, sending idea...');

    // Format ideas
    let ideasBlock;
    if (ideas.length === 1) {
        ideasBlock = `Идея: ${ideas[0]}`;
    } else {
        ideasBlock = 'Идеи (обработай ВСЕ за один раз): ' + ideas.map((idea, i) => `${i + 1}. ${idea}`).join('; ');
    }

    const ideaPrompt = (
        'Используй скилл /task-architect (вызови через Skill tool) для обработки следующего запроса. ' +
        'Контекст: пользователь добавляет идеи в существующий проект через веб-интерфейс Ralph. ' +
        'Проект уже существует, tasks.md и specs/ уже есть. ' +
        'Нужно ДОПОЛНИТЬ существующие задачи, НЕ перезаписывая. ' +
        'Используй ВСЕ доступные скиллы по ситуации. ' +
        'После завершения выведи: RALPH_IDEA_DONE ' +
        ideasBlock
    );

    sendCommand(ideaPrompt);

    const doneCheck = (buf) => buf.includes('RALPH_IDEA_DONE') ? 'DONE' : null;
    let result = await waitForCondition(doneCheck, 600);

    if (result) {
        console.log('[IDEA] Idea processed successfully');
    } else {
        console.log('[IDEA] Idea processing timed out (may still have worked)');
    }

    // Graceful exit
    sendCommand('/exit');
    await delay(3000);
    try { ptyProcess.kill(); } catch(e) {}
    process.exit(0);
})();
