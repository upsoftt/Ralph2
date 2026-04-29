#!/usr/bin/env node
/**
 * collect-sprint-results.js
 *
 * Резюмирует сессию Claude Code через PTY и собирает RALPH_RESULT
 * по каждой задаче. Пишет в live_console_4.log — виден в дашборде.
 *
 * Usage: node collect-sprint-results.js <project-dir> <session-id> [task-ids]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { regenerateIndex } = require('./index-generator');

// ─── ARGS ───
const projectDir = process.argv[2];
const sessionId = process.argv[3];
const taskIdsArg = process.argv[4]; // optional: "5.3,5.4,5.5"

if (!projectDir || !sessionId) {
    console.error('Usage: node collect-sprint-results.js <project-dir> <session-id> [task-ids]');
    process.exit(1);
}

const runnerDir = path.join(projectDir, '.ralph-runner');
const resultsDir = path.join(runnerDir, 'results');
const statusFile = path.join(runnerDir, 'collect_status.json');
const historyFile = path.join(projectDir, 'execution_history.md');
const specsDir = path.join(projectDir, 'specs');
const liveConsoleLog = path.join(runnerDir, 'live_console_4.log');

// Workspace for session isolation
const ralphDir = path.dirname(process.argv[1] || __filename);
const projectBaseName = path.basename(projectDir);
const workspaceDir = path.join(ralphDir, 'workspaces', projectBaseName);
if (!fs.existsSync(workspaceDir)) fs.mkdirSync(workspaceDir, { recursive: true });

if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

// ─── FIND CLAUDE ───
const claudeExe = process.env.CLAUDE_EXE
    || (fs.existsSync(path.join(os.homedir(), '.local', 'bin', 'claude.exe'))
        ? path.join(os.homedir(), '.local', 'bin', 'claude.exe')
        : 'claude');

// ─── LOGGING ───
function log(msg) {
    const ts = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = `[${ts}] [COLLECT] ${msg}\n`;
    process.stdout.write(line);
    try { fs.appendFileSync(liveConsoleLog, line); } catch {}
}

function writeStatus(data) {
    try { fs.writeFileSync(statusFile, JSON.stringify(data, null, 2), 'utf8'); } catch {}
}

// ─── FIND TASKS WITHOUT RESULTS ───
function findTasksWithoutResults() {
    const doneSet = new Set();
    function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (f.endsWith('spec.md')) {
                const content = fs.readFileSync(p, 'utf8');
                const re = /^-\s+\[x\]\s+[\s\S]*?\{\{TASK:(\d+\.\d+)\}\}/gm;
                let m;
                while ((m = re.exec(content)) !== null) doneSet.add(m[1]);
            }
        }
    }
    walk(specsDir);
    const tasksFile = path.join(projectDir, 'tasks.md');
    if (fs.existsSync(tasksFile)) {
        const content = fs.readFileSync(tasksFile, 'utf8');
        const re = /^-\s+\[x\]\s+[\s\S]*?\{\{TASK:(\d+\.\d+)\}\}/gm;
        let m;
        while ((m = re.exec(content)) !== null) doneSet.add(m[1]);
    }
    const tasks = [];
    for (const taskId of doneSet) {
        const safeId = taskId.replace(/\./g, '_');
        if (!fs.existsSync(path.join(resultsDir, `${safeId}.json`))) tasks.push(taskId);
    }
    tasks.sort((a, b) => {
        const [aM, am] = a.split('.').map(Number);
        const [bM, bm] = b.split('.').map(Number);
        return aM !== bM ? aM - bM : am - bm;
    });
    return tasks;
}

// ─── PARSE RALPH_RESULT ───
function parseResult(text) {
    const cleaned = text.replace(/\*\*/g, '').replace(/[─│┌┐└┘├┤┬┴┼]/g, '');
    const blockMatch = cleaned.match(/RALPH_RESULT[\s\S]*?RALPH_END/)
        || cleaned.match(/RALPH_RESULT[\s\S]*?STATUS:\s*(DONE|FAIL)/i);
    if (!blockMatch) return null;
    const block = blockMatch[0];
    const taskMatch = block.match(/TASK:\s*(.+)/i);
    const briefMatch = block.match(/BRIEF:\s*(.*?)(?=\n|SUMMARY:|STATUS:|RALPH_END)/is);
    const summaryMatch = block.match(/SUMMARY:\s*([\s\S]*?)(?=STATUS:|RALPH_END)/i);
    const statusMatch = block.match(/STATUS:\s*(DONE|FAIL)/i);
    if (!statusMatch) return null;
    return {
        task_id: taskMatch ? taskMatch[1].trim() : '',
        brief: briefMatch ? briefMatch[1].trim() : '',
        summary: summaryMatch ? summaryMatch[1].trim() : '',
        status: statusMatch[1].toUpperCase()
    };
}

// ─── MAIN ───
async function main() {
    let taskIds;
    if (taskIdsArg) {
        taskIds = taskIdsArg.split(',').map(s => s.trim()).filter(Boolean);
    } else {
        taskIds = findTasksWithoutResults();
    }

    if (taskIds.length === 0) {
        log('✅ Все результаты уже собраны.');
        writeStatus({ collecting: false, done: 0, total: 0, message: 'Все результаты уже собраны' });
        return;
    }

    log(`📋 Задачи для сбора: ${taskIds.join(', ')} (${taskIds.length} шт)`);
    log(`📋 Session: ${sessionId}`);
    writeStatus({ collecting: true, current: null, done: 0, total: taskIds.length, tasks: taskIds });

    // ─── SPAWN CLAUDE WITH --resume ───
    log('🚀 Запуск Claude Code --resume ...');

    const proc = pty.spawn(claudeExe, ['--resume', sessionId], {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd: workspaceDir,
        env: { ...process.env }
    });

    let buffer = '';
    let currentTaskIdx = -1;
    let collected = 0;
    let failed = 0;
    let bootReady = false;
    let waitingForResult = false;
    let resultTimeout = null;

    function sendPrompt(text) {
        // Send text + Enter via PTY
        proc.write(text + '\r');
    }

    function saveResult(taskId, parsed) {
        const safeId = taskId.replace(/\./g, '_');
        fs.writeFileSync(path.join(resultsDir, `${safeId}.json`), JSON.stringify({
            status: 'READY',
            task_id: parsed.task_id || taskId,
            brief: parsed.brief || '',
            summary: parsed.summary || 'Задача выполнена.'
        }, null, 2), 'utf8');

        if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, "# История проекта\n\n", 'utf8');
        let briefLine = parsed.brief || parsed.summary?.split(/\.\s/)[0] || `Task ${taskId}`;
        if (briefLine.length > 150) briefLine = briefLine.slice(0, 147) + '...';
        fs.appendFileSync(historyFile, `### [${new Date().toLocaleString()}] Задача ${taskId}\n${briefLine}\n\n<details><summary>Подробности</summary>\n\n${parsed.summary}\n\n</details>\n\n---\n\n`, 'utf8');
        try { regenerateIndex(projectDir); } catch (e) { log(`⚠️ regenerateIndex failed: ${e.message}`); }
    }

    function askNextTask() {
        currentTaskIdx++;
        if (currentTaskIdx >= taskIds.length) {
            // All done
            log(`\n✅ Сбор завершён: ${collected} собрано, ${failed} ошибок из ${taskIds.length}`);
            writeStatus({
                collecting: false, done: taskIds.length, total: taskIds.length,
                collected, failed,
                message: `Готово: ${collected} собрано, ${failed} ошибок`,
                finishedAt: new Date().toISOString()
            });
            setTimeout(() => { proc.kill(); process.exit(0); }, 2000);
            return;
        }

        const taskId = taskIds[currentTaskIdx];
        const safeId = taskId.replace(/\./g, '_');
        if (fs.existsSync(path.join(resultsDir, `${safeId}.json`))) {
            collected++;
            log(`⏭️ ${taskId}: результат уже есть, пропускаю`);
            askNextTask();
            return;
        }

        log(`📝 [${currentTaskIdx + 1}/${taskIds.length}] Запрашиваю отчёт задачи ${taskId}...`);
        writeStatus({ collecting: true, current: taskId, done: currentTaskIdx, total: taskIds.length, collected, failed });

        buffer = ''; // reset buffer for new task
        waitingForResult = true;

        const prompt = `Ты ранее выполнил задачу ${taskId}. Напиши краткий отчёт. Выведи ТОЛЬКО отчёт без markdown-блоков:\n\nRALPH_RESULT\nTASK: ${taskId}\nBRIEF: что сделано с точки зрения пользователя (1 предложение без имён файлов)\nSUMMARY: техническое описание (какие файлы создал/изменил)\nSTATUS: DONE\nRALPH_END`;

        sendPrompt(prompt);

        // Timeout per task: 3 minutes
        if (resultTimeout) clearTimeout(resultTimeout);
        resultTimeout = setTimeout(() => {
            if (waitingForResult) {
                log(`⚠️ ${taskId}: таймаут (180s), пропускаю`);
                failed++;
                waitingForResult = false;
                askNextTask();
            }
        }, 180000);
    }

    // ─── PTY DATA HANDLER ───
    proc.onData((data) => {
        // Write to live console
        try { fs.appendFileSync(liveConsoleLog, data); } catch {}

        // Strip ANSI for parsing
        const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
        buffer += clean;

        // Detect boot ready (Claude loaded)
        if (!bootReady) {
            if (buffer.includes('Claude Code') || buffer.includes('bypass permissions') || buffer.length > 500) {
                bootReady = true;
                log('✅ Claude Code загружен, начинаю сбор...');
                // Wait a bit for stabilization, then ask first task
                setTimeout(() => askNextTask(), 3000);
            }
            return;
        }

        // Check for RALPH_RESULT in buffer
        if (waitingForResult) {
            const parsed = parseResult(buffer);
            if (parsed && parsed.status === 'DONE') {
                const taskId = taskIds[currentTaskIdx];
                waitingForResult = false;
                if (resultTimeout) { clearTimeout(resultTimeout); resultTimeout = null; }

                saveResult(taskId, parsed);
                collected++;
                log(`✅ ${taskId}: ${(parsed.brief || '').slice(0, 80)}`);

                // Small delay before next task
                setTimeout(() => askNextTask(), 2000);
            }
        }
    });

    proc.onExit(({ exitCode }) => {
        log(`Claude Code завершился (code=${exitCode})`);
        writeStatus({
            collecting: false, done: currentTaskIdx + 1, total: taskIds.length,
            collected, failed,
            message: `Claude завершился: ${collected} собрано, ${failed} ошибок`,
            finishedAt: new Date().toISOString()
        });
        process.exit(exitCode || 0);
    });
}

main().catch(err => {
    log(`❌ Ошибка: ${err.message}`);
    writeStatus({ collecting: false, message: `Ошибка: ${err.message}` });
    process.exit(1);
});
