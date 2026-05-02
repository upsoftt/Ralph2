const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');
const { getAgent } = require('./agents');

/**
 * Ralph 2.0 Overseer — универсальная модель CLI-агентов
 * Переключение агента: node ralph-overseer.js <projectDir> [claude|gemini]
 * Или через env: RALPH_AGENT=claude
 */

// --- КОНФИГУРАЦИЯ ---
const projectDir = process.argv[2];
if (!projectDir) { process.exit(1); }

// Singleton-check: запрещаем второй overseer на том же projectDir.
// Защита от UI-кнопки /api/start пока первый ещё жив, и от accidentальных
// двойных стартов. За день видели 6 параллельных зомби — Windows ConPTY
// засорялся, новый CC не мог spawn'ить (DLL init failure).
try {
    const myPid = process.pid;
    const out = require('child_process').execSync(
        `wmic process where "name='node.exe'" get ProcessId,CommandLine /format:csv 2>nul`,
        { encoding: 'utf8', timeout: 5000 }
    );
    const conflicts = out.split('\n').filter(line => {
        if (!line.trim() || line.startsWith('Node,')) return false;
        const parts = line.split(',');
        const cmd = parts.slice(1, -1).join(',').toLowerCase();
        const pid = parseInt(parts[parts.length - 1]);
        if (!cmd || isNaN(pid) || pid === myPid) return false;
        return cmd.includes('ralph-overseer') && cmd.includes(projectDir.toLowerCase().replace(/\\/g, '\\\\'));
    });
    if (conflicts.length > 0) {
        const pids = conflicts.map(c => c.split(',').pop()).join(', ');
        console.error(`[FATAL] Уже запущен overseer на projectDir=${projectDir} (PID ${pids}). Останови его прежде чем запускать новый, или дождись его graceful shutdown через .ralph-stop.`);
        process.exit(2);
    }
} catch (e) {
    // wmic недоступен / другая ошибка — НЕ блокируем старт (могут быть legitimate сценарии)
    if (e.status !== 2) console.error('[warn] singleton-check skipped:', e.message);
}

const agentName = process.argv[3] || process.env.RALPH_AGENT || 'claude';
const agent = getAgent(agentName);

const runnerDir = path.join(projectDir, '.ralph-runner');

// Workspace: отдельная папка для Claude Code сессий (изоляция от пользовательских сессий).
// Физически это Windows junction (mklink /J) на projectDir — агент видит все файлы проекта
// по относительным путям, но CWD остаётся workspace-путём, поэтому Claude Code индексирует
// JSONL-сессии отдельно от ручных сессий в projectDir.
const ralphDir = path.dirname(process.argv[1] || __filename);
const projectBaseName = path.basename(projectDir);
const workspaceDir = path.join(ralphDir, 'workspaces', projectBaseName);
ensureWorkspaceJunction(projectDir, workspaceDir);

function ensureWorkspaceJunction(target, link) {
    try {
        const workspacesRoot = path.dirname(link);
        if (!fs.existsSync(workspacesRoot)) fs.mkdirSync(workspacesRoot, { recursive: true });

        // Если projectDir и workspaceDir физически совпадают — пропускаем (редкий случай).
        if (path.resolve(target) === path.resolve(link)) return;

        if (fs.existsSync(link)) {
            const st = fs.lstatSync(link);
            if (st.isSymbolicLink()) {
                // Проверим, что junction указывает именно на target. Если на другое — пересоздадим.
                try {
                    const current = fs.readlinkSync(link);
                    if (path.resolve(current) === path.resolve(target)) return; // уже правильный
                    // Указывает не туда — убьём и пересоздадим
                    try { fs.rmSync(link, { recursive: false, force: true, maxRetries: 3 }); }
                    catch (e) { console.error('[error] junction_stale_remove:', e.message); return; }
                } catch (e) {
                    // readlinkSync может падать на Windows junction в старых Node — считаем корректным
                    return;
                }
            } else {
                // Обычная папка. Если там только стаб CLAUDE.md (или пусто) — заменим junction-ом.
                // Если реальный контент — не трогаем, пишем warning и работаем дальше как раньше.
                const items = fs.readdirSync(link).filter(n => n !== '.' && n !== '..');
                const onlyStub = items.length === 0 || (items.length === 1 && items[0] === 'CLAUDE.md');
                if (!onlyStub) {
                    console.error(`[warn] workspace ${link} содержит пользовательские файлы (${items.length} элементов), junction НЕ создаётся. Агент будет работать в этой папке.`);
                    return;
                }
                try { fs.rmSync(link, { recursive: true, force: true, maxRetries: 3 }); }
                catch (e) { console.error('[error] workspace_stub_remove:', e.message); return; }
            }
        }

        // Создаём junction: cmd /c mklink /J "<link>" "<target>"
        const { execFileSync } = require('child_process');
        try {
            execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
        } catch (e) {
            // Фолбэк: обычная папка со стаб-CLAUDE.md (старое поведение, чтобы не уронить overseer).
            console.error('[error] junction_create:', e.message);
            if (!fs.existsSync(link)) fs.mkdirSync(link, { recursive: true });
            const stubPath = path.join(link, 'CLAUDE.md');
            if (!fs.existsSync(stubPath)) {
                fs.writeFileSync(stubPath,
                    '# Ralph Workspace\n\nПроект расположен в: ' + target +
                    '\nВсе файлы проекта находятся по абсолютным путям в этой директории.\n' +
                    'Работай с файлами проекта используя абсолютные пути.\n', 'utf8');
            }
        }
    } catch (e) {
        console.error('[error] ensure_workspace_junction:', e.message);
    }
}

const crashLog = path.join(runnerDir, 'crash.log');
const liveConsoleLog = path.join(runnerDir, 'live_console_4.log');
const thinkingStatusFile = path.join(runnerDir, 'thinking_status.txt');
const statusFile = path.join(runnerDir, 'status.json');
const historyFile = path.join(projectDir, 'execution_history.md');
const stopFile = path.join(projectDir, '.ralph-stop');
const pauseFile = path.join(projectDir, '.ralph-pause');
const specsDir = path.join(projectDir, 'specs');
const resultsDir = path.join(runnerDir, 'results');

if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

// Ротация логов: если >10MB — обрезать до последнего 1MB
function rotateLog(logFile) {
    try {
        if (!fs.existsSync(logFile)) return;
        const stat = fs.statSync(logFile);
        if (stat.size > 10 * 1024 * 1024) {
            const fd = fs.openSync(logFile, 'r');
            const keepBytes = 1024 * 1024;
            const buf = Buffer.alloc(keepBytes);
            fs.readSync(fd, buf, 0, keepBytes, stat.size - keepBytes);
            fs.closeSync(fd);
            fs.writeFileSync(logFile, '[...truncated...]\n' + buf.toString('utf8'), 'utf8');
        }
    } catch (e) { console.error('[error] log_rotation:', e.message); }
}
rotateLog(crashLog);
rotateLog(liveConsoleLog);

// Бэкап лога предыдущей сессии перед очисткой
const logsBackupDir = path.join(runnerDir, 'logs_backup');
try {
    if (!fs.existsSync(logsBackupDir)) fs.mkdirSync(logsBackupDir, { recursive: true });
    if (fs.existsSync(liveConsoleLog)) {
        const stat = fs.statSync(liveConsoleLog);
        if (stat.size > 100) { // не бэкапить пустые
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            fs.copyFileSync(liveConsoleLog, path.join(logsBackupDir, `session_${ts}.log`));
            // Удаляем старые бэкапы (оставляем 20 последних)
            const backups = fs.readdirSync(logsBackupDir).filter(f => f.startsWith('session_')).sort();
            while (backups.length > 20) {
                try { fs.unlinkSync(path.join(logsBackupDir, backups.shift())); } catch (e) { console.error('[error] backup_cleanup:', e.message); }
            }
        }
    }
} catch (e) { console.error('[error] backup_create:', e.message); }

fs.writeFileSync(liveConsoleLog, '', 'utf8');
fs.writeFileSync(thinkingStatusFile, '', 'utf8');

// --- STATUS TRACKING ---
function atomicWriteFileSync(filePath, content) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
}

function writeStatus(running, extra = {}) {
    try {
        atomicWriteFileSync(statusFile, JSON.stringify({
            running,
            pid: process.pid,
            version: 'v4',
            agent: agentName,
            started: new Date().toISOString(),
            heartbeat: new Date().toISOString(),
            ...extra
        }, null, 2));
    } catch (e) { console.error('[error] write_status:', e.message); }
}

// Merge-обновление status.json — сохраняет существующие поля (sprint, phase, sprintTitle
// и т.д.), пишет только переданные. Используется для фазовых переходов и паузы,
// чтобы они не перетирали контекст текущего спринта.
function updateStatus(partial) {
    try {
        let existing = {};
        if (fs.existsSync(statusFile)) {
            try { existing = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch {}
        }
        const merged = { ...existing, ...partial, heartbeat: new Date().toISOString() };
        atomicWriteFileSync(statusFile, JSON.stringify(merged, null, 2));
    } catch (e) { console.error('[error] update_status:', e.message); }
}

// Уровень 3: Heartbeat — обновляем timestamp каждые 5 секунд
setInterval(() => {
    try {
        if (fs.existsSync(statusFile)) {
            const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            if (data.running) {
                data.heartbeat = new Date().toISOString();
                atomicWriteFileSync(statusFile, JSON.stringify(data, null, 2));
            }
        }
    } catch (e) { console.error('[error] heartbeat_update:', e.message); }
}, 5000);

function clearStatus() {
    try {
        atomicWriteFileSync(statusFile, JSON.stringify({ running: false, version: 'v4' }));
    } catch (e) { console.error('[error] clear_status:', e.message); }
}

// ════════════════════════════════════════════════════════════════════════
// ─── RESILIENCE LAYER ───────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
// Канонический task_state.json + reconciler + lock + retry state + enforcer log.
// Эти компоненты обеспечивают auto-recovery после crash/limit/network blip
// и защищают tasks.md/spec.md от самовольных правок Claude (ставит [x] игнорируя
// инструкции, потому что CLAUDE.md проектов часто прямо требует это).

const taskStateFile = path.join(runnerDir, 'task_state.json');
const retryStateFile = path.join(runnerDir, 'retry_state.json');
const lockFile = path.join(runnerDir, 'overseer.lock');
const enforcerLog = path.join(runnerDir, 'enforcer.log');

// ─── LOCK ────────────────────────────────────────────────────────────────
function acquireLock() {
    try {
        if (fs.existsSync(lockFile)) {
            const data = fs.readFileSync(lockFile, 'utf8').trim();
            const oldPid = parseInt(data);
            if (oldPid && oldPid !== process.pid) {
                try {
                    const check = require('child_process').execSync(
                        `tasklist /FI "PID eq ${oldPid}" /NH`,
                        { encoding: 'utf8', timeout: 5000 }
                    );
                    if (check.includes(String(oldPid))) {
                        console.error(`\n❌ Ralph overseer уже запущен на этом проекте (PID ${oldPid}, lock-файл существует). Выход.\n`);
                        process.exit(2);
                    }
                } catch (e) { /* tasklist failed = считаем процесс мёртвым */ }
            }
        }
        atomicWriteFileSync(lockFile, String(process.pid));
    } catch (e) { console.error('[error] acquire_lock:', e.message); }
}

function releaseLock() {
    try {
        if (fs.existsSync(lockFile)) {
            const data = fs.readFileSync(lockFile, 'utf8').trim();
            if (parseInt(data) === process.pid) fs.unlinkSync(lockFile);
        }
    } catch (e) { console.error('[error] release_lock:', e.message); }
}

// ─── ENFORCER LOG ─────────────────────────────────────────────────────────
function enforcerLogAppend(msg) {
    try {
        // rotation: если >5MB — обрезать до последнего 1MB
        if (fs.existsSync(enforcerLog)) {
            const sz = fs.statSync(enforcerLog).size;
            if (sz > 5 * 1024 * 1024) {
                const fd = fs.openSync(enforcerLog, 'r');
                const keepBytes = 1024 * 1024;
                const buf = Buffer.alloc(keepBytes);
                fs.readSync(fd, buf, 0, keepBytes, sz - keepBytes);
                fs.closeSync(fd);
                fs.writeFileSync(enforcerLog, '[...truncated...]\n' + buf.toString('utf8'), 'utf8');
            }
        }
        fs.appendFileSync(enforcerLog, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch (e) { console.error('[error] enforcer_log:', e.message); }
}

// ─── TASK STATE (canonical) ──────────────────────────────────────────────
// Schema: { taskId: { sprint, title, status: 'pending'|'done', report_collected, sessionId, marked_done_at } }
function loadTaskState() {
    try {
        if (!fs.existsSync(taskStateFile)) return {};
        const raw = fs.readFileSync(taskStateFile, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        // Corrupted — переименовать и вернуть пустой; reconciler ниже re-import'нёт из tasks.md
        try {
            const corruptedPath = `${taskStateFile}.corrupted-${Date.now()}`;
            fs.renameSync(taskStateFile, corruptedPath);
            enforcerLogAppend(`task_state.json corrupted, renamed to ${path.basename(corruptedPath)}: ${e.message}`);
        } catch (e2) { console.error('[error] task_state_corrupted_rename:', e2.message); }
        return {};
    }
}

function saveTaskState(state) {
    try {
        atomicWriteFileSync(taskStateFile, JSON.stringify(state, null, 2));
    } catch (e) { console.error('[error] save_task_state:', e.message); }
}

// Парсит tasks.md и spec.md, возвращает {taskId: {sprint, title, marked_x_in_md}}
function scanTasksFiles() {
    const result = {};
    const tasksMd = path.join(projectDir, 'tasks.md');
    if (fs.existsSync(tasksMd)) {
        try {
            const content = fs.readFileSync(tasksMd, 'utf8');
            const re = /^-\s+\[([ x])\]\s+\{\{TASK:(\d+\.\d+)\}\}\s*(.*)$/gm;
            let m;
            while ((m = re.exec(content)) !== null) {
                const id = m[2];
                if (!result[id]) {
                    result[id] = { sprint: id.split('.')[0], title: m[3].trim(), marked_x_in_md: m[1] === 'x' };
                } else {
                    result[id].marked_x_in_md = result[id].marked_x_in_md || (m[1] === 'x');
                }
            }
        } catch (e) { console.error('[error] scan_tasks_md:', e.message); }
    }
    if (fs.existsSync(specsDir)) {
        const walk = (dir) => {
            try {
                fs.readdirSync(dir).forEach(f => {
                    const p = path.join(dir, f);
                    try {
                        const st = fs.statSync(p);
                        if (st.isDirectory()) walk(p);
                        else if (f === 'spec.md') {
                            const c = fs.readFileSync(p, 'utf8');
                            const re = /^-\s+\[([ x])\]\s+[\s\S]*?\{\{TASK:(\d+\.\d+)\}\}/gm;
                            let m;
                            while ((m = re.exec(c)) !== null) {
                                const id = m[2];
                                if (!result[id]) {
                                    result[id] = { sprint: id.split('.')[0], title: '', marked_x_in_md: m[1] === 'x' };
                                } else {
                                    result[id].marked_x_in_md = result[id].marked_x_in_md || (m[1] === 'x');
                                }
                            }
                        }
                    } catch {}
                });
            } catch {}
        };
        walk(specsDir);
    }
    return result;
}

// При первом запуске или если tasks.md новее task_state.json — импорт.
// Каждая задача: pending→done определяется по [x] в md И наличию results/<id>.json.
function importTaskStateFromMd() {
    const scanned = scanTasksFiles();
    const existing = loadTaskState();
    const merged = {};
    for (const [id, info] of Object.entries(scanned)) {
        const safeId = id.replace(/\./g, '_');
        const resultFile = path.join(resultsDir, `${safeId}.json`);
        const reportExists = fs.existsSync(resultFile);
        const prev = existing[id] || {};

        // Правило: задача = done только если есть [x] в md AND results/<id>.json существует.
        // Это защита от ложно-зелёных ([x] без отчёта = недозакрытая задача).
        const isDone = info.marked_x_in_md && reportExists;

        merged[id] = {
            sprint: info.sprint,
            title: info.title || prev.title || '',
            status: isDone ? 'done' : 'pending',
            report_collected: reportExists,
            sessionId: prev.sessionId || null,
            marked_done_at: isDone ? (prev.marked_done_at || new Date().toISOString()) : null,
        };
    }
    saveTaskState(merged);
    return merged;
}

// Reconciler: гарантирует, что tasks.md и spec.md отражают task_state.json.
// Если в md есть [x] для задач со status≠done — откатывает на [ ]. И наоборот.
let _reconcilerWriting = false; // защита от рекурсии fs.watch

function renderExpectedMark(state, id) {
    const t = state[id];
    if (!t) return null; // задача не в state — не трогаем
    return (t.status === 'done' && t.report_collected) ? 'x' : ' ';
}

function reconcileFile(filePath, state) {
    if (!fs.existsSync(filePath)) return false;
    let changed = false;
    const log = [];
    try {
        const original = fs.readFileSync(filePath, 'utf8');
        const re = /^(-\s+\[)([ x])(\]\s+(?:[\s\S]*?\{\{TASK:(\d+\.\d+)\}\}|\{\{TASK:(\d+\.\d+)\}\}.*))$/gm;
        const updated = original.replace(re, (full, prefix, mark, rest, id1, id2) => {
            const id = id1 || id2;
            const expected = renderExpectedMark(state, id);
            if (expected === null) return full; // не наша забота
            if (mark !== expected) {
                changed = true;
                log.push(`${path.relative(projectDir, filePath)}: TASK ${id} ${mark}→${expected}`);
                return prefix + expected + rest;
            }
            return full;
        });
        if (changed) {
            _reconcilerWriting = true;
            try {
                atomicWriteFileSync(filePath, updated);
            } finally {
                // Сброс флага через 200мс (позволяет fs.watch event пройти и быть проигнорированным)
                setTimeout(() => { _reconcilerWriting = false; }, 200);
            }
            for (const l of log) enforcerLogAppend(`reconcile ${l}`);
        }
        return changed;
    } catch (e) {
        console.error(`[error] reconcile_file ${filePath}:`, e.message);
        return false;
    }
}

function reconcileAllFiles() {
    const state = loadTaskState();
    if (Object.keys(state).length === 0) return; // не реконсайлим если state пуст
    let any = false;
    const tasksMd = path.join(projectDir, 'tasks.md');
    if (reconcileFile(tasksMd, state)) any = true;
    if (fs.existsSync(specsDir)) {
        const walk = (dir) => {
            try {
                fs.readdirSync(dir).forEach(f => {
                    const p = path.join(dir, f);
                    try {
                        const st = fs.statSync(p);
                        if (st.isDirectory()) walk(p);
                        else if (f === 'spec.md') { if (reconcileFile(p, state)) any = true; }
                    } catch {}
                });
            } catch {}
        };
        walk(specsDir);
    }
    return any;
}

// markTaskCollected — официальный путь для overseer пометить задачу как закрытую.
// Используется ПОСЛЕ получения RALPH_RESULT и записи results/<id>.json.
function markTaskCollected(taskId, sessionId) {
    const state = loadTaskState();
    if (!state[taskId]) {
        // Задача не в state — досканировать
        Object.assign(state, importTaskStateFromMd());
    }
    if (state[taskId]) {
        state[taskId].status = 'done';
        state[taskId].report_collected = true;
        state[taskId].marked_done_at = new Date().toISOString();
        if (sessionId) state[taskId].sessionId = sessionId;
        saveTaskState(state);
        reconcileAllFiles(); // отрендерит [x] в tasks.md и spec.md
    }
}

// Enforcer file watcher — реактивный триггер reconcile (defense-in-depth).
// Основная гарантия — periodic reconcile (ниже), это просто ускоряет реакцию.
let enforcerWatchers = [];
let enforcerEnabled = false; // включается после grace period в startup

function startEnforcer() {
    enforcerEnabled = true;
    const debounced = debounce(() => {
        if (!enforcerEnabled) return;
        if (_reconcilerWriting) return;
        try {
            const before = fs.readFileSync(path.join(projectDir, 'tasks.md'), 'utf8');
            const changed = reconcileAllFiles();
            if (changed) {
                // Если был откат — отправить nudge Claude (если PTY жив)
                try {
                    if (typeof ptyProcess !== 'undefined' && ptyProcess) {
                        ptyProcess.write('\nИзменения в tasks.md/spec.md были автоматически откачены overseer\'ом. Не ставь самостоятельно [x] — overseer сам отметит задачи после получения RALPH_RESULT.\n');
                    }
                } catch {}
            }
        } catch {}
    }, 250);

    const watch = (filePath) => {
        try {
            if (!fs.existsSync(filePath)) return;
            const w = fs.watch(filePath, { persistent: true }, () => {
                try { debounced(); } catch (e) { console.error('[error] enforcer_callback:', e.message); }
            });
            // Critical: fs.watch на Windows может выкинуть EPERM на atomic write (tmp+rename).
            // Без error handler — это uncaughtException и death overseer'а. Логируем, не падаем.
            w.on('error', (e) => {
                console.error(`[warn] enforcer_watch_error ${filePath}:`, e.message);
                try { enforcerLogAppend(`watch_error ${path.relative(projectDir, filePath)}: ${e.message}`); } catch {}
                // Не пытаемся пере-watch'ить — periodic reconcile (30s) подхватит изменения.
            });
            enforcerWatchers.push(w);
        } catch (e) { console.error('[error] enforcer_watch_setup:', e.message); }
    };
    watch(path.join(projectDir, 'tasks.md'));
    if (fs.existsSync(specsDir)) {
        const walk = (dir) => {
            try {
                fs.readdirSync(dir).forEach(f => {
                    const p = path.join(dir, f);
                    try {
                        const st = fs.statSync(p);
                        if (st.isDirectory()) walk(p);
                        else if (f === 'spec.md') watch(p);
                    } catch {}
                });
            } catch {}
        };
        walk(specsDir);
    }
}

function stopEnforcer() {
    enforcerEnabled = false;
    for (const w of enforcerWatchers) { try { w.close(); } catch {} }
    enforcerWatchers = [];
}

function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Periodic reconcile (defense-in-depth, на случай если fs.watch промахнётся).
setInterval(() => {
    if (enforcerEnabled && !_reconcilerWriting) {
        try { reconcileAllFiles(); } catch {}
    }
}, 30000);

// ─── RETRY STATE ─────────────────────────────────────────────────────────
function loadRetryState() {
    try {
        if (!fs.existsSync(retryStateFile)) return null;
        return JSON.parse(fs.readFileSync(retryStateFile, 'utf8'));
    } catch { return null; }
}

function saveRetryState(rs) {
    try { atomicWriteFileSync(retryStateFile, JSON.stringify(rs, null, 2)); }
    catch (e) { console.error('[error] save_retry_state:', e.message); }
}

function clearRetryState() {
    try { if (fs.existsSync(retryStateFile)) fs.unlinkSync(retryStateFile); }
    catch (e) { console.error('[error] clear_retry_state:', e.message); }
}

// Stop-reactive sleep: ждёт до timeMs, проверяя stopFile/pauseFile/wake (clearRetryState) каждые 5с.
// Пауза НЕ прерывает сон — она продлевает untilTimeMs на длительность паузы, чтобы backoff/reset-timer
// не завершался раньше времени пока пользователь держит pause.
async function sleepInterruptible(untilTimeMs, label) {
    while (Date.now() < untilTimeMs) {
        if (fs.existsSync(stopFile)) return 'stop';
        if (fs.existsSync(pauseFile)) {
            const pauseStart = Date.now();
            try { updateStatus({ phase: 'paused_during_sleep', wait_label: label }); } catch {}
            while (fs.existsSync(pauseFile) && !fs.existsSync(stopFile)) {
                await new Promise(r => setTimeout(r, 2000));
            }
            untilTimeMs += Date.now() - pauseStart; // продлеваем deadline на длительность паузы
            continue;
        }
        if (!fs.existsSync(retryStateFile)) return 'wake'; // wake-up через POST /api/wake
        const remainSec = Math.max(0, Math.round((untilTimeMs - Date.now()) / 1000));
        if (remainSec % 30 === 0) {
            try {
                updateStatus({ phase: 'waiting_for_reset', wait_label: label, next_try_at: new Date(untilTimeMs).toISOString(), remaining_sec: remainSec });
            } catch {}
        }
        await new Promise(r => setTimeout(r, 5000));
    }
    return 'timeout';
}

// ─── PATTERN DETECTOR ────────────────────────────────────────────────────
// Table-driven парсинг PTY output. Одна функция, разные реакции.
const PATTERN_TABLE = [
    {
        name: 'limit_with_reset',
        re: /You['’]ve hit your limit\s*[·•\-]+\s*resets\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
        action: 'sleep_until_reset',
    },
    {
        name: 'limit_extra_usage',
        re: /\/extra-usage to finish what you['’]re working on/i,
        action: 'sleep_short_then_retry',
    },
    {
        // Inaccurate сообщение от Claude Code при истечении 5h-сессии с включённым
        // extra usage: текст говорит про monthly cap, по факту extra-usage переключение
        // уже произошло. Лечим коротким retry (5 мин) а не long sleep — иначе встанем
        // в паузу впустую. Если же это РЕАЛЬНЫЙ monthly cap — на retry увидим то же
        // сообщение и снова откатимся, без spam'а в мёртвый CC. См. инцидент 2026-04-27.
        name: 'limit_org_monthly',
        re: /hit your (org['’]s|organization['’]s)?\s*(monthly|weekly|daily)?\s*usage limit/i,
        action: 'sleep_short_then_retry',
    },
    {
        // Только реальные сообщения об ошибке — НЕ матчит "rate limit" в нейтральном
        // тексте промпта/документации. Иначе ловит ложные срабатывания на boot'е.
        name: 'rate_limit_generic',
        re: /\b(rate.limit\s+(exceeded|reached|hit)|usage limit reached|too many requests|api rate.limit|429\s+too many)\b/i,
        action: 'backoff',
    },
    {
        name: 'auth_required',
        re: /(authentication required|please run \/login|api key|session expired)/i,
        action: 'stop_manual',
    },
    {
        name: 'context_overflow',
        re: /(context length exceeded|context too long|prompt is too long)/i,
        action: 'inject_compact',
    },
    {
        name: 'network_error',
        // Требуем КОНТЕКСТ реальной ошибки, не любое упоминание (false positive: задача
        // спринта может называться "Network error state", в коде/таске Claude обсуждает
        // обработку ошибок сети — это НЕ значит что overseer должен убивать его).
        // Контексты: "Error: ECONNRESET", "throw ETIMEDOUT", "caught network error",
        // "failed with: connection refused", "Error connecting:" и т.п.
        // См. инцидент 2026-04-27: TASK:30.7 "Offline / Network error state" триггерил
        // kill loop потому что Claude читал tasks.md / создавал TaskCreate с этим именем.
        re: /(?:^|\n)\s*(?:Error[: ]|Failed[: ]|throw\s|caught\s|encountered\s|fatal[: ]|fetch failed[: ]|API.{0,30}error[: ]).{0,80}(network error|connection refused|ECONNRESET|ETIMEDOUT)/i,
        action: 'backoff_short',
    },
    {
        name: 'internal_server_error',
        re: /(internal server error|500 Internal|503 Service|api error: 5\d\d)/i,
        action: 'backoff_short',
    },
];

let _lastPatternMatch = { name: null, ts: 0 }; // дедупликация повторных matches

// ─── PROMPT FRAMES ───────────────────────────────────────────────────────
// Каждый промпт overseer'а оборачивается в эти маркеры. Все consumers
// (detectPattern, extract*, frontend) перед matching/grepping вырезают
// содержимое между маркерами через stripPromptFrames(). Это защищает от
// false-positive когда инструкция в промпте содержит триггер-фразу
// (RALPH_SPRINT_DONE, RALPH_AUDIT_OK, "rate limit" и т.п.).
const PROMPT_BEGIN = '<<<RALPH_PROMPT_BEGIN>>>';
const PROMPT_END = '<<<RALPH_PROMPT_END>>>';
const PROMPT_FRAME_RE = /<<<RALPH_PROMPT_BEGIN>>>[\s\S]*?<<<RALPH_PROMPT_END>>>/g;

function stripPromptFrames(text) {
    return (text || '').replace(PROMPT_FRAME_RE, '');
}

// Защита от false-positive matches: Claude часто пишет про network errors / rate limits
// в КОДЕ или в обсуждении (особенно при работе над error-handling спринтами). Markdown
// code blocks (```...```) и inline code (`...`) вырезаются ДО pattern detection,
// чтобы overseer не убивал живого Claude из-за упоминания "network error" в Templ.
// См. инцидент 2026-04-27: спринт 30 (Mobile + offline/network error handling) →
// false-positive network_error → kill+resume → DLL crash loop.
function stripCodeBlocks(text) {
    return (text || '')
        .replace(/```[\s\S]*?```/g, '')  // markdown fenced code
        .replace(/`[^`\n]+`/g, '');       // inline code
}

function detectPattern(textChunk) {
    // Защита от matching внутри инструкций overseer'а: вырезаем содержимое рамок
    // ДО matching. Если строка не содержит маркеров — replace no-op, накладных нет.
    textChunk = stripPromptFrames(textChunk);
    textChunk = stripCodeBlocks(textChunk);
    for (const p of PATTERN_TABLE) {
        const m = textChunk.match(p.re);
        if (m) {
            // дедупликация: один и тот же pattern в течение 30 сек игнорируем
            const now = Date.now();
            if (_lastPatternMatch.name === p.name && now - _lastPatternMatch.ts < 30000) continue;
            _lastPatternMatch = { name: p.name, ts: now };
            return { ...p, match: m };
        }
    }
    return null;
}

// Парсит время "4pm (Europe/Moscow)" / "16:00" из match'а — возвращает Date следующего такого момента.
function parseResetTime(match) {
    const h = parseInt(match[1]);
    const min = match[2] ? parseInt(match[2]) : 0;
    const ampm = (match[3] || '').toLowerCase();
    let hour = h;
    if (ampm === 'pm' && h < 12) hour += 12;
    if (ampm === 'am' && h === 12) hour = 0;
    const now = new Date();
    let target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0);
    if (target <= now) target = new Date(target.getTime() + 24 * 3600 * 1000); // следующий день
    return target;
}

// handlePatternAction вызывается из PTY-callback. НЕ выполняет блокирующих операций —
// только записывает желаемое действие в pendingRecoveryAction, которое подберёт mainLoop
// (через waitForModel периодически проверяет это поле).
function handlePatternAction(hit) {
    let action = null;
    try {
        switch (hit.action) {
            case 'sleep_until_reset': {
                const until = parseResetTime(hit.match);
                action = { kind: 'sleep_until', untilMs: until.getTime() + 30000, label: `API limit reset at ${until.toLocaleTimeString()}` };
                break;
            }
            case 'sleep_short_then_retry':
                action = { kind: 'sleep_until', untilMs: Date.now() + 5 * 60 * 1000, label: 'API limit cooldown 5m' };
                break;
            case 'backoff':
                action = { kind: 'sleep_until', untilMs: Date.now() + 5 * 60 * 1000, label: 'rate limit backoff 5m' };
                break;
            case 'backoff_short':
                action = { kind: 'sleep_until', untilMs: Date.now() + 30 * 1000, label: 'network/server cooldown 30s' };
                break;
            case 'stop_manual':
                action = { kind: 'stop_manual', label: 'требуется ручной /login' };
                break;
            case 'inject_compact': {
                // /compact не работает при превышенном контексте (Catch-22): команда сама
                // отправляется как промпт, который не помещается. Если предыдущий inject_compact
                // был меньше 5 мин назад в том же спринте — значит /compact уже не помог.
                // Переключаемся на session_reset: clearSprintSession + null sessionId →
                // mainLoop сделает fresh restart без resume.
                let curSprint = null;
                try {
                    const stat = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
                    curSprint = stat.sprint || null;
                } catch (e) { console.error('[error] read_sprint_for_compact:', e.message); }
                const now = Date.now();
                const sameSprintRecent = curSprint && lastCompactAttempt.sprintNum === curSprint
                                       && (now - lastCompactAttempt.ts) < 5 * 60 * 1000;
                if (sameSprintRecent) {
                    action = {
                        kind: 'session_reset',
                        sprintNum: curSprint,
                        label: `context overflow x2 для спринта ${curSprint} → session reset (fresh start)`
                    };
                    lastCompactAttempt = { ts: 0, sprintNum: null };
                } else {
                    action = { kind: 'inject_command', text: '/compact\r', label: 'context overflow → /compact' };
                    lastCompactAttempt = { ts: now, sprintNum: curSprint };
                }
                break;
            }
        }
    } catch (e) { console.error('[error] handle_pattern_action:', e.message); }
    if (action) {
        // Сохраняем как pending — НЕ перезаписываем если уже есть и более старая (sleep_until больше pending'а)
        if (!pendingRecoveryAction || (action.kind === 'sleep_until' && pendingRecoveryAction.untilMs && action.untilMs > pendingRecoveryAction.untilMs)) {
            pendingRecoveryAction = action;
            saveRetryState({ ...action, started_at: new Date().toISOString() });
            updateStatus({ phase: 'waiting_for_recovery', recovery_label: action.label });
        }
    }
}

// ════════════════════════════════════════════════════════════════════════
// ─── /RESILIENCE LAYER ──────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

// Проверяем: не запущен ли уже другой overseer на этом проекте
if (fs.existsSync(statusFile)) {
    try {
        const existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        if (existing.running && existing.pid && existing.pid !== process.pid) {
            // Проверяем жив ли процесс (Windows: tasklist)
            try {
                const check = require('child_process').execSync(
                    `tasklist /FI "PID eq ${existing.pid}" /NH`,
                    { encoding: 'utf8', timeout: 5000 }
                );
                if (check.includes(String(existing.pid))) {
                    console.error(`\n❌ Ralph уже запущен на этом проекте (PID ${existing.pid}). Выход.\n`);
                    process.exit(2);
                }
            } catch (e) { console.error('[error] check_process_alive:', e.message); } // Если tasklist не сработал — считаем что процесс мёртв
        }
    } catch (e) { console.error('[error] parse_status:', e.message); }
}

// Очищаем .ralph-stop если остался от прошлого раза
if (fs.existsSync(stopFile)) { try { fs.unlinkSync(stopFile); } catch (e) { console.error('[error] cleanup_stop_file:', e.message); } }

// Acquire single-instance lock (вторая защита, плюс к проверке status.pid выше)
acquireLock();

// Импортируем task_state.json из tasks.md/spec.md (создаст файл при первом запуске,
// синхронизирует если пользователь правил руками между запусками overseer)
try { importTaskStateFromMd(); } catch (e) { console.error('[error] import_task_state:', e.message); }

// Записываем статус: запущен
writeStatus(true);

// Grace period 10 секунд — даём пользователю успеть сохранить ручные правки tasks.md
// перед включением enforcer'а (иначе он откатит несохранённые изменения).
setTimeout(() => {
    try { importTaskStateFromMd(); } catch {} // ещё раз — подхватываем правки за окном
    startEnforcer();
}, 10000);

// Гарантируем очистку статуса при любом выходе + диагностика
process.on('exit', (code) => {
    try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [PROCESS] exit event, code=${code}\n`, 'utf8'); } catch(e) {}
    try { stopEnforcer(); } catch {}
    try { releaseLock(); } catch {}
    clearStatus();
});
process.on('SIGINT', () => {
    try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [PROCESS] SIGINT received\n`, 'utf8'); } catch(e) {}
    clearStatus(); process.exit(0);
});
process.on('SIGTERM', () => {
    try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [PROCESS] SIGTERM received\n`, 'utf8'); } catch(e) {}
    clearStatus(); process.exit(0);
});
process.on('uncaughtException', (err) => {
    try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [PROCESS] uncaughtException: ${err.stack}\n`, 'utf8'); } catch(e) {}
    // Recoverable error классы — НЕ kill overseer (Claude Code PTY останется orphan, мы потеряем спринт).
    // Это про fs.watch EPERM (Windows atomic write race), фриз filesystem ENOSPC, и т.п.
    const recoverable = err && (
        err.code === 'EPERM' ||
        err.code === 'EBUSY' ||
        err.code === 'ENOENT' ||
        /\bwatch\b/.test(err.message || '') ||
        /\bwatcher\b/.test(err.message || '')
    );
    if (recoverable) {
        try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [PROCESS] uncaughtException RECOVERED, continuing\n`, 'utf8'); } catch {}
        return; // НЕ делаем clearStatus и НЕ exit — продолжаем работу
    }
    clearStatus();
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [PROCESS] unhandledRejection: ${reason}\n`, 'utf8'); } catch(e) {}
    clearStatus();
    process.exit(1);
});

let logicalBuffer = '';
let lastSentCmd = '';
let stopRequested = false;
let recentHashes = new Set();
let ptyProcess = null; // PTY процесс агента (глобальный для доступа из JSONL watcher)
let lastThinkingTime = 0;
let bootStepsDone = new Set(); // Выполненные шаги boot sequence
let lastQuestionNudgeTime = 0; // Время последнего авто-ответа на вопрос
let currentLivePauseInterval = null; // Интервал live-паузы (для очистки в killAgent)
let patternBuffer = ''; // Sliding window 4KB для Pattern Detector
let pendingRecoveryAction = null; // Поставленный pattern detector'ом запрос на adaptive sleep
let lastCompactAttempt = { ts: 0, sprintNum: null }; // Дедуп context_overflow: 2 inject_compact для того же спринта в течение 5 мин = session reset
let consecutiveFastResumeDeaths = 0; // Подряд PTY смертей <15s после spawn при resume → session corrupted, нужен fresh start
let lastSuccessfulReady = Date.now(); // Время последнего успешного RALPH_READY (для retry budget 24ч)
let consecutivePtyFails = 0; // Подряд PTY-spawn'ов с code=1 без RALPH_READY (circuit breaker)
let ptyDeadFlag = false; // Установлен onExit'ом — mainLoop увидит и сделает auto-restart

// ─── DUAL-CHANNEL: JSONL ─────────────────────────────────────
// PTY = управление (команды, boot, thinking-статус)
// JSONL = данные (ответы Claude, результаты, чистый текст)
let sessionId = crypto.randomUUID();
// Slug: D:\MyProjects\Ralph\projects\SkyStrike → D--MyProjects-Ralph-projects-SkyStrike
// Claude Code заменяет ВСЕ не-алфавитно-цифровые символы на дефис (включая пробелы, точки)
function projectSlug(dir) {
    // Не используем path.resolve — он может изменить разделители
    return dir.replace(/[^a-zA-Z0-9]/g, '-');
}
const claudeProjectsDir = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'projects');
// workspaceDir определяется выше — сессии хранятся по slug workspace, не проекта.
// Claude Code v2.1.117+ резолвит Windows junction в реальный путь перед вычислением
// slug для JSONL-директории. Поэтому overseer ДОЛЖЕН резолвить workspaceDir так же,
// иначе jsonlPath будет указывать в пустую папку и RALPH_READY не увидится.
let workspaceDirResolved = workspaceDir;
try {
    workspaceDirResolved = fs.realpathSync.native
        ? fs.realpathSync.native(workspaceDir)
        : fs.realpathSync(workspaceDir);
} catch (e) {
    console.error('[warn] realpath workspaceDir failed, using as-is:', e.message);
}
let jsonlPath = '';
let jsonlReadPos = 0; // Позиция чтения в JSONL файле (байты)
let jsonlBuffer = ''; // Накопленный текст ответов Claude из JSONL
let jsonlWatchInterval = null;
let lastJsonlAssistantTexts = []; // Последние текстовые блоки для chatLog

/**
 * Читает новые строки из JSONL, парсит assistant-сообщения
 * Возвращает массив текстовых блоков из новых assistant-сообщений
 */
function readNewJsonlMessages() {
    if (!fs.existsSync(jsonlPath)) return [];
    const stat = fs.statSync(jsonlPath);
    if (stat.size <= jsonlReadPos) return [];

    const prevPos = jsonlReadPos;
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(stat.size - prevPos);
    fs.readSync(fd, buf, 0, buf.length, prevPos);
    fs.closeSync(fd);

    const newData = buf.toString('utf8');

    // Сдвигаем позицию только до последнего полного перевода строки,
    // чтобы не потерять обрезанную строку JSON
    const lastNl = newData.lastIndexOf('\n');
    if (lastNl === -1) {
        // Нет ни одной полной строки — откатываем, дочитаем в следующий раз
        jsonlReadPos = prevPos;
        return [];
    }
    jsonlReadPos = prevPos + Buffer.byteLength(newData.substring(0, lastNl + 1), 'utf8');

    const completeData = newData.substring(0, lastNl + 1);
    const lines = completeData.split('\n');
    const texts = [];

    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant' && obj.message && obj.message.content) {
                for (const block of obj.message.content) {
                    if (block.type === 'text' && block.text) {
                        texts.push(block.text);
                        jsonlBuffer += block.text + '\n';
                    }
                    if (block.type === 'tool_use') {
                        const toolLine = `● ${block.name}(${JSON.stringify(block.input || {}).substring(0, 80)})`;
                        texts.push(toolLine);
                    }
                }
            }
            // tool_result и progress — пропускаем, нас интересует только assistant output
        } catch (e) {
            // Неполная строка JSON — JSONL ещё пишется, пропускаем
        }
    }
    return texts;
}

/**
 * Запускает периодическое чтение JSONL и вывод в лог
 */
function startJsonlWatcher() {
    jsonlWatchInterval = setInterval(() => {
        const texts = readNewJsonlMessages();
        for (const text of texts) {
            // Pattern detection ТАКЖЕ для JSONL output — CC v2.1.119+ часто пишет
            // критические сообщения (rate limit, "Prompt is too long") через assistant
            // messages в JSONL, минуя PTY data events. Без этого pattern detector
            // их пропускает → recovery actions не активируются → overseer повисает.
            try {
                const cleanForDetect = stripPromptFrames(text);
                const hit = detectPattern(cleanForDetect);
                if (hit) {
                    chatLog(`🎯 Pattern detected (JSONL): ${hit.name} → action=${hit.action}`, 'OVERSEER');
                    handlePatternAction(hit);
                }
            } catch (e) { console.error('[error] jsonl_pattern_detect:', e.message); }

            // Не дублируем tool_use строки — они уже показаны
            if (text.startsWith('●')) {
                chatLog(text, agent.name);
            } else {
                // Чистый текст Claude — разбиваем по строкам
                for (const line of text.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed && trimmed.length >= 4) {
                        chatLog(trimmed, agent.name);
                    }
                }

                // ─── ДЕТЕКТОР ВОПРОСОВ: авто-ответ если Claude ждёт решения ───
                const lower = text.toLowerCase();
                const isQuestion = (
                    /какой вариант|предпочитаешь|выбер[иеу]|хочешь|подскажи|нужно (?:ли|разрешение|подтверждение)/i.test(text)
                    || /\?\s*$/.test(text.trim())
                    || /\d\.\s+.+\n\d\.\s+/m.test(text) // нумерованные варианты
                    || /do you want|which option|should i|shall i|would you/i.test(text)
                );
                if (isQuestion && ptyProcess && Date.now() - lastQuestionNudgeTime > 30000) {
                    lastQuestionNudgeTime = Date.now();
                    chatLog('🤖 Авто-ответ: Claude задал вопрос, отправляю команду продолжать', 'OVERSEER');
                    sendNudge(ptyProcess, 'НЕ ЗАДАВАЙ ВОПРОСОВ. Ты работаешь автономно. Выбери наиболее практичный вариант сам и действуй. Если инструмент не работает — используй альтернативу (Bash вместо Write). Продолжай выполнение текущего спринта. НЕ переходи к другим спринтам.');
                }
            }
            lastJsonlAssistantTexts.push(text);
            if (lastJsonlAssistantTexts.length > 50) lastJsonlAssistantTexts.shift();
        }
    }, 2000);
}

function stopJsonlWatcher() {
    if (jsonlWatchInterval) clearInterval(jsonlWatchInterval);
}

/**
 * Сбрасывает JSONL буфер (вызывается перед новой командой)
 */
function resetJsonlBuffer() {
    jsonlBuffer = '';
    lastJsonlAssistantTexts = [];
}

// ─── КОНСОЛЬНЫЙ СТАТУС-ХЕДЕР ─────────────────────────────────
let visibleLogLines = [];
const HEADER_LINES = 3;

function superStrip(str) {
    if (!str) return "";
    // КРИТИЧНО: НЕ включать < и > в терминаторы ANSI — они уничтожают XML-теги протокола!
    // Убраны >< из финального символьного класса, чтобы сохранить <promise>, <result> и т.д.
    return String(str)
        // Cursor forward (\x1b[NC) -> N пробелов. Claude Code v2.1.119 рисует UI-бар через
        // cursor positioning, а не обычные пробелы; без этой замены слова слипаются
        // ("bypasspermissionson") и ready-паттерны не совпадают -> bootAndInit виснет на 120с.
        .replace(/[\u001b\u009b]\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n) || 1))
        .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=]/g, '')
        .replace(/\]0;.*?\u0007/g, '')
        .replace(/^\s*\d+\s+/gm, '')
        .replace(/\x07/g, '');
}

let currentStatusBar = '';
let currentThinkingLine = '';
let currentState = 'BOOT'; // BOOT | THINK | IDLE

// ─── СПИННЕР ──────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinnerIdx = 0;

function getSpinnerChar() {
    spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
    return SPINNER_FRAMES[spinnerIdx];
}

// ─── РЕНДЕР ЭКРАНА ────────────────────────────────────────────
function renderScreen() {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    const logHeight = rows - HEADER_LINES - 1;

    const bar = '═'.repeat(cols);
    const spinner = currentState === 'THINK' ? `\x1b[33m${getSpinnerChar()}\x1b[0m ` : '  ';
    const stateLabel = currentState === 'BOOT' ? '\x1b[90m⏳ Загрузка\x1b[0m'
                     : currentState === 'THINK' ? '\x1b[33m⚡ Работает\x1b[0m'
                     : '\x1b[32m✓ Готов\x1b[0m';
    const model = currentStatusBar || `${agent.name} — ожидание...`;
    const thinking = currentThinkingLine || '';

    let frame = '\x1b[?25l\x1b[1;1H';
    frame += `\x1b[36m${bar}\x1b[0m\x1b[0K\n`;
    const statusText = ` ${spinner}${stateLabel} │ \x1b[97m${model}\x1b[0m${thinking ? ' │ \x1b[90m' + thinking + '\x1b[0m' : ''}`;
    frame += `${statusText}\x1b[0K\n`;
    frame += `\x1b[36m${bar}\x1b[0m\x1b[0K\n`;

    const toShow = visibleLogLines.slice(-logHeight);
    for (const line of toShow) {
        frame += line + '\x1b[0K\n';
    }
    const remaining = logHeight - toShow.length;
    for (let i = 0; i < remaining; i++) {
        frame += '\x1b[0K\n';
    }

    frame += '\x1b[?25h';
    process.stdout.write(frame);
}

// ─── ДЕТЕКЦИЯ АКТИВНОСТИ (универсальная) ──────────────────────
function isThinkingSignal(cleanText, lowerText) {
    if (agent.patterns.thinkingRegex.test(cleanText)) return true;
    return agent.patterns.thinking.some(p => lowerText.includes(p));
}

function isReadySignal(lowerText) {
    return agent.patterns.ready.some(p => lowerText.includes(p));
}

function isIgnored(lowerText) {
    return agent.patterns.ignore.some(p => lowerText.includes(p));
}

// ─── ОБНОВЛЕНИЕ СТАТУСА ИЗ PTY ─────────────────────────────
function updateThinkingStatus(text) {
    const lines = superStrip(text).split('\n');
    let changed = false;

    lines.forEach(line => {
        const cleanLine = line.trim();
        if (!cleanLine) return;

        // 1. Строка состояния модели (формат: [Model (XXK context)] | ━━ XX% ...)
        if (cleanLine.includes('context') && cleanLine.includes('%')) {
            // Если контекст-бар изменился — модель активна (используёт инструменты)
            if (currentStatusBar !== cleanLine) {
                lastThinkingTime = Date.now();
                currentState = 'THINK';
            }
            currentStatusBar = cleanLine;
            changed = true;
        }

        // 2. Строка мышления (через паттерны агента)
        const lower = cleanLine.toLowerCase();
        if (isThinkingSignal(cleanLine, lower)) {
            let action = cleanLine.replace(/[\u2800-\u28FF]/g, '').trim();
            // Убираем паттерны типа "(esc to cancel, Xs)" или "(esc to interrupt)"
            agent.patterns.thinking.forEach(p => {
                const escapeRegex = new RegExp(`\\(${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)]*\\)`, 'gi');
                action = action.replace(escapeRegex, '');
            });
            action = action.replace(/responding/i, '').trim();
            currentThinkingLine = action || '';
            lastThinkingTime = Date.now();
            currentState = 'THINK';
            changed = true;
        }
    });

    if (changed) {
        const fullStatus = `${currentStatusBar} | ${currentThinkingLine}`.replace(/^ \| /, '').replace(/ \| $/, '');
        if (fullStatus.trim()) {
            try {
                fs.writeFileSync(thinkingStatusFile, fullStatus, 'utf8');
            } catch (e) {
                // File may be locked during heavy I/O — skip silently
            }
        }
    }
}

// ─── ЛОГИРОВАНИЕ ──────────────────────────────────────────────
function chatLog(msg, source = 'SYSTEM') {
    const cleanMsg = superStrip(msg).trim();
    if (!cleanMsg || cleanMsg.length < 4) return;
    const lower = cleanMsg.toLowerCase();

    // Фильтр: thinking-строки → в статус
    if (isThinkingSignal(cleanMsg, lower) || lower.includes('context left')) {
        updateThinkingStatus(msg);
        return;
    }

    // Фильтр: игнорируемые строки агента
    if (isIgnored(lower)) return;

    // Фильтр: дедупликация. КРОМЕ state-маркеров с emoji-префиксом — они в loop'е
    // повторяются legitimately (🔁 Resume каждый restart, ⏳ PTY fail #N каждый fail и т.п.).
    // Без этого whitelist'а 90% диагностики теряется и outer loop bugs становятся невидимы.
    // См. инцидент 2026-04-27: 15-сек spam-цикл, маскированный дедупом.
    const isStateMarker = /^(🚀|🔁|💀|⏳|🔄|⚠|🛑|💤|⏰|🎯|💉|🚫|❌|✅|📋|🔍|🔧|🗑|🤖|📝|📂|📡|🎉)/u.test(cleanMsg);
    if (!isStateMarker) {
        const fp = lower.replace(/[^a-zа-я0-9]/g, '');
        if (recentHashes.has(fp)) return;
        recentHashes.add(fp);
        if (recentHashes.size > 100) {
            const first = recentHashes.values().next().value;
            recentHashes.delete(first);
        }
    }

    const time = new Date().toLocaleTimeString('ru-RU');
    const formatted = `[${time}] [${source}] ${cleanMsg}`;

    visibleLogLines.push(formatted);
    if (visibleLogLines.length > 200) visibleLogLines = visibleLogLines.slice(-200);

    try {
        fs.appendFileSync(liveConsoleLog, formatted + '\n', 'utf8');
        fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [${source}] ${cleanMsg}\n`, 'utf8');
    } catch (e) { console.error('[error] chat_log_write:', e.message); }

    renderScreen();
}

function sendCommand(ptyProc, cmd) {
    const cleanCmd = cmd.trim();
    lastSentCmd = cleanCmd;
    logicalBuffer = '';
    lastThinkingTime = 0;
    resetJsonlBuffer(); // Сброс JSONL буфера перед новой командой

    const time = new Date().toLocaleTimeString('ru-RU');
    const formatted = `[${time}] [OVERSEER] >> ${cleanCmd}`;

    visibleLogLines.push(formatted);
    if (visibleLogLines.length > 200) visibleLogLines = visibleLogLines.slice(-200);

    fs.appendFileSync(liveConsoleLog, formatted + '\n', 'utf8');
    renderScreen();
    writePromptToPty(ptyProc, cleanCmd);
}

/**
 * Отправляет текст в Claude Code TUI и сабмитит его.
 *
 * Claude Code v2.1.119+ при длинном тексте (визуальный wrap в input)
 * трактует одиночный \r как line-break внутри multiline input, а не как
 * submit — промпт набирается, но не отправляется модели. Оборачиваем в
 * bracketed paste (ESC[200~ ... ESC[201~): Claude принимает текст одним
 * блоком без интерпретации управляющих символов; последующий \r после
 * короткой задержки интерпретируется как submit.
 *
 * Также заменяем \n на пробелы — внутри bracketed paste \n тоже
 * считается line-break. Одиночный \r в конце задержкой submit-ит.
 */
function writePromptToPty(ptyProc, cmd) {
    const text = cmd.replace(/\r?\n/g, ' ');
    // Оборачиваем промпт в RALPH_PROMPT-рамки, чтобы pattern detector и extract*
    // могли надёжно отличить инструкции overseer'а от output Claude Code.
    const wrapped = `${PROMPT_BEGIN} ${text} ${PROMPT_END}`;
    try {
        ptyProc.write('\x1b[200~' + wrapped + '\x1b[201~');
    } catch (e) { console.error('[error] pty_write_paste:', e.message); return; }
    setTimeout(() => {
        try { ptyProc.write('\r'); }
        catch (e) { console.error('[error] pty_write_submit:', e.message); }
    }, 400);
}

/**
 * Отправляет nudge-сообщение в PTY БЕЗ сброса буферов.
 * Используется для авто-ответов на вопросы и напоминаний,
 * чтобы не потерять уже накопленный jsonlBuffer с маркерами.
 */
function sendNudge(ptyProc, cmd) {
    const cleanCmd = cmd.trim();
    const time = new Date().toLocaleTimeString('ru-RU');
    const formatted = `[${time}] [OVERSEER] >> ${cleanCmd}`;

    visibleLogLines.push(formatted);
    if (visibleLogLines.length > 200) visibleLogLines = visibleLogLines.slice(-200);

    fs.appendFileSync(liveConsoleLog, formatted + '\n', 'utf8');
    renderScreen();
    writePromptToPty(ptyProc, cleanCmd);
}

/**
 * Извлекает ВСЕ результаты задач из JSONL буфера (для batch-сбора после спринта).
 * Возвращает массив { status, task_id, brief, summary } или пустой массив.
 */
function extractAllResults(text) {
    const source = stripPromptFrames(jsonlBuffer || text);
    const cleaned = source
        .replace(/\*\*/g, '')
        .replace(/[║╔╗╚╝═╠╣╬╦╩─│┌┐└┘├┤┬┴┼▐▌▀▄█░▒▓]/g, '')
        .replace(/^ +| +$/gm, '');

    const results = [];
    // Ищем ВСЕ блоки RALPH_RESULT...RALPH_END
    const blockRegex = /RALPH_RESULT[\s\S]*?RALPH_END/g;
    let match;
    while ((match = blockRegex.exec(cleaned)) !== null) {
        const block = match[0];
        const taskMatch = block.match(/TASK:\s*(.+)/i);
        const briefMatch = block.match(/BRIEF:\s*(.*?)(?=\n|SUMMARY:|STATUS:|RALPH_END)/i);
        const summaryMatch = block.match(/SUMMARY:\s*([\s\S]*?)(?=STATUS:|RALPH_END)/i);
        const statusMatch = block.match(/STATUS:\s*(DONE|FAIL)/i);
        if (statusMatch) {
            let summary = summaryMatch ? summaryMatch[1].trim() : '';
            summary = summary.replace(/\n{2,}/g, '\n').replace(/^\s*\n/gm, '').trim();
            // Защита от копирования шаблона промпта без реальной работы
            const placeholders = ['здесь напиши', 'что конкретно сделал', 'опиши что сделал', '<ЗАПОЛНИ', 'описание того, что ты сделал', 'техническое описание (какие файлы', 'что сделано с точки зрения пользователя (1 предложение'];
            const brief = briefMatch ? briefMatch[1].trim() : '';
            const allText = (brief + ' ' + summary).toLowerCase();
            const isPlaceholder = placeholders.some(ph => allText.includes(ph.toLowerCase()));
            if (isPlaceholder) continue; // Пропускаем шаблон, ждём реальный отчёт
            if (summary.length < 10) summary = 'Задача выполнена.';
            results.push({
                status: statusMatch[1].toUpperCase(),
                task_id: taskMatch ? taskMatch[1].trim() : 'unknown',
                brief: brief,
                summary: summary
            });
        }
    }
    return results;
}

/**
 * Извлекает результат задачи из JSONL буфера (чистый текст, без PTY-мусора)
 */
function extractResult(text) {
    // Используем ТОЛЬКО JSONL буфер — PTY logicalBuffer содержит эхо промптов с шаблоном RALPH_RESULT
    const source = stripPromptFrames(jsonlBuffer || text);

    // ─── Текстовый протокол RALPH_RESULT ───
    // Убираем markdown bold (**) и box-drawing символы (║╔╗╚╝═ и т.д.)
    // Claude иногда оформляет RALPH_RESULT в "красивую рамку", ломая парсинг
    const cleaned = source
        .replace(/\*\*/g, '')
        .replace(/[║╔╗╚╝═╠╣╬╦╩─│┌┐└┘├┤┬┴┼▐▌▀▄█░▒▓]/g, '')
        .replace(/^ +| +$/gm, '');

    // Приоритет 1: полный блок с RALPH_END
    const blockMatch = cleaned.match(/RALPH_RESULT[\s\S]*?RALPH_END/);
    // Приоритет 2: блок без RALPH_END, но с STATUS: DONE (модель забыла закрыть)
    const partialMatch = !blockMatch && cleaned.match(/RALPH_RESULT[\s\S]*?STATUS:\s*(DONE|FAIL)/i);
    const block = blockMatch ? blockMatch[0] : (partialMatch ? partialMatch[0] : null);

    if (block) {
        const taskMatch = block.match(/TASK:\s*(.+)/i);
        const briefMatch = block.match(/BRIEF:\s*(.*?)(?=\n|SUMMARY:|STATUS:|RALPH_END)/i);
        const summaryMatch = block.match(/SUMMARY:\s*([\s\S]*?)(?=STATUS:|RALPH_END)/i);
        const statusMatch = block.match(/STATUS:\s*(DONE|FAIL)/i);

        if (statusMatch) {
            let summary = summaryMatch ? summaryMatch[1].trim() : "";
            // Убираем пустые строки и лишние пробелы после очистки box-символов
            summary = summary.replace(/\n{2,}/g, '\n').replace(/^\s*\n/gm, '').trim();
            // Защита от копирования шаблона без реальной работы
            const placeholders = ['здесь напиши', 'что конкретно сделал', 'опиши что сделал', '<ЗАПОЛНИ', 'описание того, что ты сделал'];
            const isPlaceholder = placeholders.some(ph => summary.toLowerCase().includes(ph.toLowerCase()));
            if (isPlaceholder) {
                return "FORMAT_ERROR"; // Заставит overseer переспросить
            }
            if (summary.length < 10) {
                // Fallback: берём весь текст между RALPH_RESULT и STATUS (кроме TASK:/ROLE: строк)
                const fallbackMatch = block.match(/RALPH_RESULT[\s\S]*?(?=STATUS:)/i);
                if (fallbackMatch) {
                    summary = fallbackMatch[0]
                        .replace(/RALPH_RESULT/i, '')
                        .replace(/^.*TASK:.*$/gmi, '')
                        .replace(/^.*ROLE:.*$/gmi, '')
                        .replace(/\n{2,}/g, '\n')
                        .trim();
                }
                if (summary.length < 10) summary = "Задача выполнена (отчёт в нестандартном формате).";
            }
            const brief = briefMatch ? briefMatch[1].trim() : '';
            return {
                status: statusMatch[1].toUpperCase(),
                task_id: taskMatch ? taskMatch[1].trim() : "unknown",
                brief: brief,
                summary: summary
            };
        }
    }

    // ─── Legacy: XML-парсинг ───
    const promiseMatch = source.match(/<promise>(DONE|FAIL)<\/promise>/i);
    if (promiseMatch) {
        const taskIdMatch = source.match(/<task_id>(.*?)<\/task_id>/i);
        let summary = '';
        let brief = '';

        // Вариант 1: <summary>...</summary>
        const summaryMatch = source.match(/<summary>([\s\S]*?)(?:<\/summary>|$)/i);
        if (summaryMatch) summary = summaryMatch[1].trim();

        // Вариант 2: <report>{"summary": "...", ...}</report> (Claude иногда выводит JSON в report)
        if (!summary || summary.length < 10) {
            const reportMatch = source.match(/<report>\s*(\{[\s\S]*?\})\s*(?:<\/report>|$)/i);
            if (reportMatch) {
                try {
                    const rj = JSON.parse(reportMatch[1]);
                    summary = rj.summary || rj.result || '';
                    brief = rj.brief || '';
                } catch (e) {
                    // Не JSON — берём как текст
                    summary = reportMatch[1].replace(/[{}]/g, '').trim();
                }
            }
        }

        if (!summary || summary.length < 10) summary = "Описание не найдено.";

        return {
            status: promiseMatch[1].toUpperCase(),
            task_id: taskIdMatch ? taskIdMatch[1].trim() : "unknown",
            brief: brief,
            summary: summary
        };
    }

    return null;
}

/**
 * Проверяет готовность инициализации из JSONL буфера
 */
function extractInitReady(text) {
    const source = stripPromptFrames(jsonlBuffer || text);
    if (source.includes("RALPH_READY")) return "READY";
    if (source.includes("<promise>DONE</promise>")) return "READY";
    if (/\bDONE\b/.test(source)) return "READY";
    return null;
}

try {
    process.stdout.write('\x1b[2J\x1b[1;1H');
    renderScreen();

    const headerInterval = setInterval(() => {
        if (stopRequested) { clearInterval(headerInterval); return; }
        renderScreen();
    }, 500);

    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    /**
     * Убивает текущий PTY процесс и всё дерево дочерних процессов (MCP серверы и т.д.)
     */
    function killAgent() {
        stopJsonlWatcher();
        if (currentLivePauseInterval) { clearInterval(currentLivePauseInterval); currentLivePauseInterval = null; }
        if (ptyProcess) {
            const pid = ptyProcess.pid;
            try { ptyProcess.kill(); } catch (e) { console.error('[error] kill_pty_process:', e.message); }
            // Убиваем дерево дочерних процессов (MCP серверы, npx и т.д.)
            if (pid) {
                try {
                    require('child_process').execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', timeout: 5000 });
                } catch (e) { console.error('[error] kill_child_tree:', e.message); } // Процесс мог уже завершиться
            }
            ptyProcess = null;
        }
    }

    /**
     * Грейсфул остановка: отправляет Escape + /exit в Claude Code,
     * ждёт завершения, затем убивает процесс
     */
    async function gracefulStop() {
        chatLog('🛑 Получен сигнал остановки. Завершаю работу...', 'OVERSEER');
        stopRequested = true;

        if (ptyProcess) {
            try {
                // Отправляем Escape чтобы прервать текущую генерацию
                ptyProcess.write('\x1b');
                await delay(500);
                // Отправляем /exit чтобы Claude Code завершился корректно
                ptyProcess.write('/exit\r');

                // Даём Claude Code до 3 секунд на завершение
                for (let i = 0; i < 3; i++) {
                    await delay(1000);
                    if (!ptyProcess) break; // Уже завершился через onExit
                }
            } catch (e) { console.error('[error] graceful_stop:', e.message); }

            // Если ещё жив — принудительно убиваем
            killAgent();
        }

        // Убираем файл .ralph-stop
        if (fs.existsSync(stopFile)) {
            try { fs.unlinkSync(stopFile); } catch (e) { console.error('[error] cleanup_stop_file:', e.message); }
        }

        clearStatus();
        chatLog('✅ Ralph 2.0 остановлен.', 'OVERSEER');
    }

    /**
     * Спавнит новый PTY процесс агента
     */
    function spawnAgent(resumeSessionId = null) {
        // Resume existing session or create new
        // ─── PRE-RESUME GUARDS ───
        // Resume крупной/старой сессии = риск ConPTY DLL crash на Windows.
        // Перед resume проверяем 2 защиты:
        //   1. Размер JSONL > 3MB → contextual cap близок, на boot высокая вероятность DLL crash
        //   2. mtime JSONL > 24 часа → сессия "холодная", может быть corrupted
        // В обоих случаях принудительно делаем fresh start без resume + clearSprintSession.
        // См. инциденты 2026-04-29 (sprint 36, 6.4MB JSONL → loop) и 2026-05-02 (sprint 39 → fast death).
        const RESUME_MAX_JSONL_BYTES = 3 * 1024 * 1024; // 3 MB
        const RESUME_MAX_AGE_HOURS = 24;
        if (resumeSessionId) {
            const candidatePath = path.join(claudeProjectsDir, projectSlug(workspaceDirResolved), `${resumeSessionId}.jsonl`);
            try {
                if (fs.existsSync(candidatePath)) {
                    const st = fs.statSync(candidatePath);
                    const ageHours = (Date.now() - st.mtimeMs) / 3600000;
                    if (st.size > RESUME_MAX_JSONL_BYTES) {
                        chatLog(`⚠️ Resume blocked: JSONL ${(st.size / 1024 / 1024).toFixed(1)}MB > ${RESUME_MAX_JSONL_BYTES / 1024 / 1024}MB → force fresh (избегаем ConPTY DLL crash)`, 'OVERSEER');
                        resumeSessionId = null;
                    } else if (ageHours > RESUME_MAX_AGE_HOURS) {
                        chatLog(`⚠️ Resume blocked: JSONL возраст ${ageHours.toFixed(1)}ч > ${RESUME_MAX_AGE_HOURS}ч → force fresh (stale session)`, 'OVERSEER');
                        resumeSessionId = null;
                    }
                }
            } catch (e) { console.error('[error] pre_resume_guards:', e.message); }
        }

        if (resumeSessionId) {
            sessionId = resumeSessionId;
            chatLog(`🔄 Resume session: ${sessionId}`, 'OVERSEER');
        } else {
            sessionId = crypto.randomUUID();
        }
        jsonlPath = path.join(claudeProjectsDir, projectSlug(workspaceDirResolved), `${sessionId}.jsonl`);
        // При resume — читаем с конца существующего JSONL
        jsonlReadPos = 0;
        if (resumeSessionId && fs.existsSync(jsonlPath)) {
            jsonlReadPos = fs.statSync(jsonlPath).size;
        }

        const ptyArgs = resumeSessionId
            ? [...agent.args.filter(a => a !== '--session-id'), '--resume', sessionId]
            : [...agent.args, '--session-id', sessionId];
        chatLog(`📋 Session ID: ${sessionId}${resumeSessionId ? ' (resume)' : ''}`, 'OVERSEER');
        chatLog(`📂 JSONL: ${jsonlPath}`, 'OVERSEER');

        // Track Ralph sessions for the collect-results dialog
        try {
            const sessFile = path.join(runnerDir, 'ralph_sessions.txt');
            fs.appendFileSync(sessFile, `${sessionId}\t${new Date().toISOString()}\n`, 'utf8');
        } catch (e) { console.error('[error] track_session:', e.message); }

        // Сброс состояния
        logicalBuffer = '';
        bootStepsDone = new Set();
        lastThinkingTime = 0;
        currentState = 'BOOT';
        stopRequested = false;
        resetJsonlBuffer();

        // Workspace CLAUDE.md: направляет Claude к файлам проекта
        const wsClaude = path.join(workspaceDir, 'CLAUDE.md');
        if (!fs.existsSync(wsClaude)) {
            fs.writeFileSync(wsClaude, `# Ralph Workspace\n\nПроект расположен в: ${projectDir}\nВсе файлы проекта находятся по абсолютным путям в этой директории.\nРаботай с файлами проекта используя абсолютные пути.\n`, 'utf8');
        }

        ptyProcess = pty.spawn(agent.command, ptyArgs, {
            name: 'xterm-color',
            ...agent.pty,
            cwd: workspaceDir,
            env: { ...process.env, RALPH_NODE_HEAP: '8192', ...agent.env },
        });

        // ─── LIVE PAUSE: замораживает Claude Code mid-task через PTY pause ───
        let livePaused = false;
        if (currentLivePauseInterval) { clearInterval(currentLivePauseInterval); currentLivePauseInterval = null; }
        const livePauseInterval = setInterval(() => {
            if (!ptyProcess) return;
            const shouldPause = fs.existsSync(pauseFile);
            if (shouldPause && !livePaused) {
                livePaused = true;
                ptyProcess.pause();
                updateStatus({ paused: true });
                chatLog('⏸️ Пауза (процесс заморожен)', 'OVERSEER');
            } else if (!shouldPause && livePaused) {
                livePaused = false;
                ptyProcess.resume();
                updateStatus({ paused: false });
                chatLog('▶️ Продолжение (процесс разморожен)', 'OVERSEER');
            }
        }, 1000);
        currentLivePauseInterval = livePauseInterval;

        // Очистка интервала при завершении
        ptyProcess.onExit(() => { clearInterval(livePauseInterval); currentLivePauseInterval = null; });

        // Диагностика: логируем ВЕСЬ сырой PTY вывод в crash.log первые 30 секунд
        const spawnTime = Date.now();
        ptyProcess.onData((data) => {
            if (Date.now() - spawnTime < 30000) {
                try { fs.appendFileSync(crashLog, `[PTY-RAW ${Date.now() - spawnTime}ms] ${data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '.')}\n`, 'utf8'); } catch(e) { console.error('[error] pty_raw_log:', e.message); }
            }
            const clean = superStrip(data);
            const lower = clean.toLowerCase();

            // Pattern Detector — реагируем на API limit / network / auth / context overflow.
            // Используем sliding window 4KB чтобы не ре-матчить старые сообщения и не перегружать regex.
            patternBuffer += clean;
            if (patternBuffer.length > 4096) patternBuffer = patternBuffer.slice(-4096);
            try {
                const hit = detectPattern(patternBuffer);
                if (hit) {
                    chatLog(`🎯 Pattern detected: ${hit.name} → action=${hit.action}`, 'OVERSEER');
                    enforcerLogAppend(`pattern ${hit.name} action=${hit.action}`);
                    handlePatternAction(hit);
                    patternBuffer = ''; // сбрасываем чтобы не сматчить тот же текст ещё раз
                }
            } catch (e) { console.error('[error] pattern_detect:', e.message); }

            // Boot sequence: автоматическое прохождение диалогов загрузки
            if (agent.bootSequence) {
                for (let i = 0; i < agent.bootSequence.length; i++) {
                    if (bootStepsDone.has(i)) continue;
                    const step = agent.bootSequence[i];
                    if (lower.includes(step.wait)) {
                        bootStepsDone.add(i);
                        chatLog(`🔄 Boot: ${step.desc}`, 'OVERSEER');
                        setTimeout(() => {
                            if (ptyProcess) ptyProcess.write(step.send);
                        }, step.delay || 500);
                        break;
                    }
                }
            }

            // Обновляем статус-бар (контекст, thinking spinners)
            updateThinkingStatus(data);

            // Детекция активности — только для thinking/idle состояния
            let hasActivity = isThinkingSignal(clean, lower);
            if (!hasActivity) {
                for (const line of clean.split('\n')) {
                    if (agent.patterns.toolSuccess.test(line.trim())) { hasActivity = true; break; }
                }
            }
            if (hasActivity) {
                lastThinkingTime = Date.now();
                currentState = 'THINK';
            } else if (lastThinkingTime > 0 && Date.now() - lastThinkingTime > 60000) {
                currentState = 'IDLE';
                currentThinkingLine = '';
                try { fs.writeFileSync(thinkingStatusFile, '', 'utf8'); } catch (e) { console.error('[error] clear_thinking_status:', e.message); }
            }

            // PTY буфер — только для ready-детекции при загрузке
            logicalBuffer += clean;
            if (logicalBuffer.length > 200000) logicalBuffer = logicalBuffer.slice(-200000);

            // Во время загрузки показываем PTY вывод (JSONL ещё не существует)
            const isBooting = !jsonlWatchInterval && logicalBuffer.length < 3000;
            if (isBooting) {
                data.split(/\r?\n/).forEach(l => {
                    const stripped = superStrip(l).trim();
                    if (stripped && stripped.length >= 4) chatLog(stripped, agent.name);
                });
            }
        });

        const thisPtyPid = ptyProcess.pid; // capture pid before potential nullification
        ptyProcess.onExit(({ exitCode, signal }) => {
            const msg = `⚠️ ${agent.name} PTY завершился (code=${exitCode}, signal=${signal})`;
            chatLog(msg, 'OVERSEER');
            try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [EXIT] ${msg}\n`, 'utf8'); } catch(e) { console.error('[error] exit_log_write:', e.message); }
            // Убиваем дочерние процессы (MCP серверы), которые остались после крэша
            if (thisPtyPid) {
                try { require('child_process').execSync(`taskkill /f /t /pid ${thisPtyPid}`, { stdio: 'ignore', timeout: 5000 }); } catch (e) { console.error('[error] kill_orphan_children:', e.message); }
            }
            // Раньше: stopRequested=true и overseer выходит. Теперь: НЕ выходим — даём mainLoop'у
            // и waitForModel'у узнать через ptyDeadFlag и сделать auto-restart с resume.
            // Spurious-onExit фильтр: node-pty иногда выдаёт ложный onExit в первые ~5s
            // после spawn. Реальный crash через 5+ секунд — устанавливаем флаг как обычно.
            const ageMs = Date.now() - spawnTime;
            if (ageMs < 5000) {
                chatLog(`⚠️ Spurious onExit через ${ageMs}ms после spawn — игнорирую (вероятно ConPTY init dance)`, 'OVERSEER');
                // Spurious = PTY реально жив. НЕ nullify ptyProcess и НЕ останавливать watcher,
                // иначе sendCommand на null PTY молча fail'ит и JSONL чтение прекращается.
                // См. инцидент 2026-04-27.
                return;
            }
            // Fast death (<30s после spawn) при resume = session corrupted, JSONL state damaged.
            // Считаем подряд такие смерти — на 2-й auto-reset session_id (clearSprintSession +
            // null sessionId → fresh restart без resume). См. инцидент 2026-04-27: resume на
            // одну и ту же d5203837 → DLL crash через 2 сек → loop с растущим backoff.
            // Порог поднят с 15s до 30s 2026-05-02 — реальный boot+nudge+ConPTY crash на больших
            // сессиях занимает 15-20s, граница 15s давала граничные кейсы где счётчик сбрасывался
            // и auto-reset никогда не наступал (см. инцидент Domovoy sprint 38, fail #18+).
            if (ageMs < 30000) {
                consecutiveFastResumeDeaths++;
                chatLog(`⚠️ Быстрая смерть PTY через ${Math.round(ageMs/1000)}s (подряд: ${consecutiveFastResumeDeaths})`, 'OVERSEER');
            } else {
                consecutiveFastResumeDeaths = 0;
            }
            ptyDeadFlag = true;
            ptyProcess = null;
            // Edge case: если PTY умер между BEGIN и END рамки — patternBuffer содержит
            // незакрытый промпт, lazy regex его не вырежет → текст инструкции попадёт в detectPattern.
            // Сбрасываем буфер при смерти PTY.
            patternBuffer = '';
            stopJsonlWatcher();
        });

        return ptyProcess;
    }

    /**
     * Ожидает загрузку агента и отправляет init-команду
     * Возвращает true если инициализация прошла успешно
     */
    async function bootAndInit(isResume = false) {
        chatLog(`⏳ Ожидание загрузки ${agent.name}${isResume ? ' (resume — может быть медленнее)' : ''}...`, 'OVERSEER');
        // Boot-loop с учётом паузы: пока .ralph-pause активен, PTY заморожен и паттерн
        // не появится — тикать таймер нельзя. Пауза вычитается из elapsed.
        // Timeout увеличен до 300s: resume большой сессии (JSONL > 1MB) может занимать 120-180s.
        const BOOT_TIMEOUT_SEC = 300;
        let initialReady = false;
        const bootStart = Date.now();
        let totalPausedMs = 0;
        let lastLogAt = bootStart;
        while (true) {
            if (stopRequested) { chatLog('❌ PTY процесс завершился во время загрузки.', 'OVERSEER'); return false; }
            if (fs.existsSync(pauseFile)) {
                const pauseStart = Date.now();
                while (fs.existsSync(pauseFile) && !stopRequested && !fs.existsSync(stopFile) && !ptyDeadFlag) {
                    await delay(2000);
                }
                totalPausedMs += Date.now() - pauseStart;
                continue;
            }
            const elapsedSec = Math.floor((Date.now() - bootStart - totalPausedMs) / 1000);
            if (elapsedSec >= BOOT_TIMEOUT_SEC) break;
            const low = logicalBuffer.toLowerCase();
            if (agent.patterns.ready.some(p => low.includes(p))) { initialReady = true; break; }
            // Progress-log каждые 30с — пользователь видит что boot идёт
            if (Date.now() - lastLogAt >= 30000) {
                chatLog(`⏳ Boot: ${elapsedSec}s / ${BOOT_TIMEOUT_SEC}s (ждём '${agent.patterns.ready[0]}')...`, 'OVERSEER');
                lastLogAt = Date.now();
            }
            await delay(1000);
        }
        if (!initialReady) { chatLog(`❌ Агент не загрузился за ${BOOT_TIMEOUT_SEC} секунд.`, 'OVERSEER'); return false; }

        chatLog('⏳ Boot OK, ждём 3с стабилизации...', 'OVERSEER');
        await delay(3000);
        chatLog('⏳ Стабилизация завершена, запускаю JSONL watcher...', 'OVERSEER');
        logicalBuffer = '';

        // Запускаем JSONL watcher после boot
        startJsonlWatcher();
        chatLog('📡 JSONL watcher запущен', 'OVERSEER');

        // При resume пропускаем инициализацию — сессия уже знает контекст
        if (isResume) {
            chatLog("✅ Сессия возобновлена (resume), пропускаем инициализацию.", "OVERSEER");
            await delay(3000);
            logicalBuffer = '';

            // Phase-aware nudge: читаем, в какой фазе спринта Claude был прерван,
            // и даём инструкцию соответствующую именно этой фазе.
            let phase = 'executing';
            let sprintNum = null;
            let sprintTitle = null;
            try {
                if (fs.existsSync(statusFile)) {
                    const st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
                    if (st.phase) phase = st.phase;
                    if (st.sprint) sprintNum = st.sprint;
                    if (st.sprintTitle) sprintTitle = st.sprintTitle;
                }
            } catch (e) { console.error('[error] read_status_for_resume:', e.message); }

            const sprintInfo = sprintNum
                ? `спринта ${sprintNum}${sprintTitle ? ` "${sprintTitle}"` : ''}`
                : 'текущего спринта';
            let nudgeText;
            switch (phase) {
                case 'auditing':
                    nudgeText = `Ты был прерван во время аудита ${sprintInfo}. Если ты ещё не вызывал /ralph-auditor — вызови его сейчас через Skill tool. Если уже выводил отчёт — завершай аудит. ОБЯЗАТЕЛЬНО последним сообщением выведи РОВНО ОДНО слово на отдельной строке: RALPH_AUDIT_OK или RALPH_AUDIT_FIX. Ничего другого не пиши после маркера.`;
                    break;
                case 'collecting_reports':
                    nudgeText = `Ты был прерван на этапе сбора отчётов по задачам ${sprintInfo}. Overseer сейчас переспросит у тебя отчёты по каждой задаче — отвечай СТРОГО в формате блока:\n\nRALPH_RESULT\nTASK: <id>\nBRIEF: ...\nSUMMARY: ...\nSTATUS: DONE\nRALPH_END\n\nНичего другого не делай — ни писать код, ни вызывать скиллы. Жди вопросы и отвечай в указанном формате.`;
                    break;
                case 'committing':
                    nudgeText = `Ты был прерван в момент, когда overseer собирался сделать git commit после закрытия ${sprintInfo}. Ничего не пиши и не делай — overseer сам довершит commit и перейдёт к следующему спринту.`;
                    break;
                case 'executing':
                default:
                    nudgeText = `Ты был прерван во время выполнения задач ${sprintInfo}. Прочитай spec.md соответствующего спринта в папке specs/, определи какие задачи уже выполнены (по наличию файлов в репо и коммитов) и продолжай с того места. НЕ ставь [x] в tasks.md — это сделает overseer. Когда закончишь все задачи спринта — выведи на отдельной строке: RALPH_SPRINT_DONE`;
            }
            chatLog(`🔁 Resume: фаза "${phase}"${sprintNum ? `, спринт ${sprintNum}` : ''}`, 'OVERSEER');
            sendNudge(ptyProcess, nudgeText);
            // НЕ сбрасываем consecutivePtyFails здесь — bootAndInit return true означает только
            // что PTY стартанул, НЕ что Claude обработал nudge. PTY может умереть через 5 сек
            // (DLL crash), и без Claude активности backoff должен экспоненциально расти.
            // Сброс перенесён в waitForModel — когда jsonlBuffer реально получил данные от Claude.
            // См. инцидент 2026-04-27: 15-сек loop потому что counter сбрасывался в каждом resume.
            return true;
        }

        const initCmd = `ДЕЙСТВУЙ КАК СИСТЕМНЫЙ АГЕНТ. Прочитай файлы PRD.md, ${agent.rulesFile}, planning.md, tasks.md. ВАЖНО ПРО ИСТОРИЮ ВЫПОЛНЕНИЯ: НЕ читай execution_index.md и execution_history.md на старте. Они нужны ТОЛЬКО при работе со спринтом, и только если архитектор проставил зависимости. Алгоритм: когда возьмёшься за конкретный спринт — открой spec.md этого спринта. Если в spec.md есть секция "## Связанные прошлые задачи" или поля "**ЗАВИСИМОСТИ:** [refs: N.M, ...]" в задачах — там перечислены конкретные прошлые задачи, релевантные для этого спринта. Открывай их так: grep -nE "^### .* Задача N\\.M$" execution_history.md (вернёт строку начала блока), затем Read execution_history.md offset:<строка> limit:20. Если в spec.md нет ни секции, ни refs — это greenfield-спринт, история не нужна, не читай ни индекс, ни лог. КРИТИЧЕСКИЕ ПРАВИЛА АВТОНОМНОЙ РАБОТЫ: 1) Ты работаешь ПОЛНОСТЬЮ автономно. НИКОГДА не задавай вопросов, не предлагай варианты на выбор, не жди ответа пользователя. Всегда выбирай решение сам и действуй. 2) Если инструмент не работает (нет прав, ошибка) — используй альтернативу (Bash вместо Write, curl вместо WebFetch и т.д.) без вопросов. 3) Скиллы находятся в D:/MyProjects/skills/ (симлинк из ~/.claude/skills). Для записи скиллов используй путь D:/MyProjects/skills/. 4) Перед тяжёлыми npm/pnpm командами: export NODE_OPTIONS="--max-old-space-size=8192". 5) АБСОЛЮТНО ЗАПРЕЩЕНО: git stash, git checkout --, git restore, git reset. Эти команды УНИЧТОЖАЮТ uncommitted код и tasks.md. Если нужно проверить "было ли сломано до моих изменений" — используй git diff или git log, НЕ откатывай код. Для pnpm install используй --no-frozen-lockfile. 6) После каждого выполненного спринта делай git add и git commit с описанием выполненных задач. 7) При любом препятствии — обходи его сам, не останавливайся. Никаких лишних слов. Когда прочитаешь, выведи одно слово: RALPH_READY`;

        // Замер токенов: фиксируем размер initCmd и baseline jsonlBuffer перед отправкой
        const initStartedAt = Date.now();
        const initPromptChars = initCmd.length;
        const initJsonlBaseline = jsonlBuffer.length;

        sendCommand(ptyProcess, initCmd);
        let initRes = await waitForModel(extractInitReady, 900);
        let initRetries = 0;
        const MAX_INIT_RETRIES = 3;
        while (initRes !== "READY" && !stopRequested && initRetries < MAX_INIT_RETRIES) {
            initRetries++;
            const secSinceThinking = (Date.now() - lastThinkingTime) / 1000;
            if (secSinceThinking < 120) {
                chatLog(`⏳ Claude ещё активен (${Math.round(secSinceThinking)}s назад). Ждём без прерывания...`, "OVERSEER");
                initRes = await waitForModel(extractInitReady, 600);
                continue;
            }
            chatLog(`⚠️ ${agent.name} не ответил RALPH_READY. Повторяю запрос (попытка ${initRetries}/${MAX_INIT_RETRIES})...`, "OVERSEER");
            sendNudge(ptyProcess, "Ты закончил? Выведи одно слово: RALPH_READY");
            initRes = await waitForModel(extractInitReady, 300);
        }
        if (stopRequested) { chatLog("❌ PTY завершился до загрузки контекста.", "OVERSEER"); return false; }
        if (initRes !== "READY") { chatLog("❌ Не удалось инициализировать агента.", "OVERSEER"); return false; }

        // Замер токенов: считаем response от Claude (что прибыло в jsonlBuffer после sendCommand)
        // и оцениваем суммарную стоимость старта сессии. Формула tokens ≈ chars/3.5 — грубая оценка
        // для смеси русского/английского/markdown. Точная цифра видна в /usage внутри Claude Code.
        const initElapsedMs = Date.now() - initStartedAt;
        const initResponseChars = Math.max(0, jsonlBuffer.length - initJsonlBaseline);
        const promptTokens = Math.round(initPromptChars / 3.5);
        const responseTokens = Math.round(initResponseChars / 3.5);
        const totalTokens = promptTokens + responseTokens;
        chatLog(`📊 Init: prompt ~${promptTokens}t + response ~${responseTokens}t = ~${totalTokens}t (за ${Math.round(initElapsedMs/1000)}s)`, "OVERSEER");

        // Сохраняем замер в .ralph-runner/init_tokens.jsonl для анализа динамики экономии
        try {
            const tokenLogPath = path.join(runnerDir, 'init_tokens.jsonl');
            const entry = {
                timestamp: new Date().toISOString(),
                isResume: !!isResume,
                promptChars: initPromptChars,
                responseChars: initResponseChars,
                promptTokens,
                responseTokens,
                totalTokens,
                elapsedMs: initElapsedMs,
                sessionId: sessionId || null,
                retries: initRetries
            };
            fs.appendFileSync(tokenLogPath, JSON.stringify(entry) + '\n', 'utf8');
        } catch (e) { console.error('[warn] init_tokens log skipped:', e.message); }

        chatLog("✅ Контекст проекта загружен.", "OVERSEER");
        await delay(2000);
        logicalBuffer = '';
        // Сброс счётчиков retry budget — Claude Code успешно стартовал
        lastSuccessfulReady = Date.now();
        consecutivePtyFails = 0;
        return true;
    }

    /**
     * Перезапуск агента: kill → spawn → boot → init
     * Возвращает true если перезапуск успешен
     */
    async function restartAgent(reason, resumeSessionId = null) {
        chatLog(`🔄 Перезапуск ${agent.name}: ${reason}`, 'OVERSEER');
        killAgent();
        await delay(3000);
        spawnAgent(resumeSessionId);
        return await bootAndInit(!!resumeSessionId);
    }

    async function waitForModel(conditionFn, timeoutSec = 1800) {
        const start = Date.now();
        let totalPausedMs = 0; // суммарное время, проведённое под .ralph-pause — вычитается из elapsed
        await delay(2000);

        const FORMAT_ERROR_SILENCE_SEC = 600;
        let lastDataTime = Date.now();
        let lastJsonlLen = 0;

        while (!stopRequested) {
            const now = Date.now();
            if (now - start - totalPausedMs > timeoutSec * 1000) { chatLog(`⏰ waitForModel: таймаут (${timeoutSec}s)`, 'OVERSEER'); return null; }
            if (fs.existsSync(stopFile)) { chatLog('🛑 waitForModel: обнаружен .ralph-stop', 'OVERSEER'); stopRequested = true; return null; }

            // ─── PTY мёртв (crash, kill, лимит API при старте) — auto-restart с resume ───
            if (ptyDeadFlag) {
                ptyDeadFlag = false;
                // КРИТИЧНО: PTY мог умереть СРАЗУ ПОСЛЕ того как Claude вывел маркер
                // (RALPH_SPRINT_DONE / RALPH_AUDIT_OK / RALPH_RESULT). Маркер уже в jsonlBuffer
                // через JSONL watcher (он читает Anthropic-side stream, минуя PTY). Без этой
                // проверки overseer уйдёт в restart, Claude после resume увидит свой ответ
                // и снова напишет тот же маркер → снова PTY death → бесконечный loop.
                // См. инцидент 2026-04-29 спринт 36 Domovoy: 6 рестартов с RALPH_SPRINT_DONE
                // в каждом JSONL, но overseer его не видел потому что PTY_DEAD-проверка
                // была раньше conditionFn-проверки.
                const resBeforeRestart = conditionFn(jsonlBuffer);
                if (resBeforeRestart) {
                    chatLog(`✅ Маркер найден в JSONL до auto-restart — спринт закрыт, restart не нужен`, 'OVERSEER');
                    resetJsonlBuffer();
                    return resBeforeRestart;
                }
                chatLog('💀 PTY мёртв — пробую auto-restart с resume.', 'OVERSEER');
                return 'PTY_DEAD';
            }

            // ─── Pattern Detector pending action — обрабатываем СНАЧАЛА ───
            if (pendingRecoveryAction) {
                const act = pendingRecoveryAction;
                pendingRecoveryAction = null; // claim — иначе зациклимся
                try {
                    if (act.kind === 'sleep_until') {
                        chatLog(`💤 Adaptive sleep до ${new Date(act.untilMs).toLocaleTimeString()}: ${act.label}`, 'OVERSEER');
                        const reason = await sleepInterruptible(act.untilMs, act.label);
                        chatLog(`⏰ Sleep завершился: ${reason}`, 'OVERSEER');
                        clearRetryState();
                        if (reason === 'stop') { stopRequested = true; return null; }
                        // КРИТИЧНО: пока overseer спал, Claude Code мог продолжить работу и
                        // выдать маркер (например RALPH_SPRINT_DONE). Прежде чем возвращать
                        // PATTERN_RECOVERY (= caller сделает restart и потеряет работу),
                        // проверяем буфер на результат. Если уже есть — отдаём его.
                        const resAfterSleep = conditionFn(jsonlBuffer);
                        if (resAfterSleep) {
                            chatLog(`✅ Результат уже в буфере после sleep — пропускаем restart`, 'OVERSEER');
                            resetJsonlBuffer();
                            return resAfterSleep;
                        }
                        // После сна возвращаем 'PATTERN_RECOVERY' — caller'у понятно что нужен resume
                        return 'PATTERN_RECOVERY';
                    } else if (act.kind === 'inject_command') {
                        if (ptyProcess) { try { ptyProcess.write(act.text); } catch {} }
                        chatLog(`💉 Injected: ${act.label}`, 'OVERSEER');
                        clearRetryState();
                        await delay(5000);
                        // продолжаем цикл — Claude обработает /compact и продолжит
                    } else if (act.kind === 'session_reset') {
                        // Catch-22 fallback: /compact уже не помог — fresh session без resume.
                        // mainLoop при PATTERN_RECOVERY вызовет restartAgent с null sessionId →
                        // spawnAgent создаст новую через crypto.randomUUID(), Claude стартанёт
                        // с пустого контекста. Правило 0 init-промпта проверит файлы по диску.
                        chatLog(`🔄 ${act.label}`, 'OVERSEER');
                        if (act.sprintNum) {
                            try {
                                clearSprintSession(act.sprintNum);
                                chatLog(`🗑️ Очищен sessionId спринта ${act.sprintNum} в sprint_sessions.json`, 'OVERSEER');
                            } catch (e) { console.error('[error] clear_session_for_reset:', e.message); }
                        }
                        sessionId = null; // следующий spawnAgent создаст новую UUID
                        clearRetryState();
                        return 'PATTERN_RECOVERY';
                    } else if (act.kind === 'stop_manual') {
                        chatLog(`🛑 ${act.label} — overseer переходит в dormant. Проверьте Claude Code.`, 'OVERSEER');
                        updateStatus({ phase: 'dormant', dormant_reason: act.label });
                        return 'DORMANT';
                    }
                } catch (e) { console.error('[error] handle_pending_recovery:', e.message); }
            }

            // Pause-aware: пока .ralph-pause существует, PTY заморожен через ptyProcess.pause().
            // Замораживаем и наш timeout: блокируемся в inner-loop до снятия паузы,
            // затем прибавляем длительность паузы к totalPausedMs, чтобы elapsed считался
            // только по активному времени. Иначе 3600s timeout тикает под паузой и после
            // возобновления Overseer ложно решает, что спринт завис → resume без причины.
            if (fs.existsSync(pauseFile)) {
                const pauseStart = Date.now();
                while (fs.existsSync(pauseFile) && !stopRequested && !fs.existsSync(stopFile) && !ptyDeadFlag) {
                    await delay(2000);
                }
                totalPausedMs += Date.now() - pauseStart;
                lastDataTime = Date.now();
                continue;
            }

            // Отслеживаем активность (JSONL рост + PTY thinking)
            if (jsonlBuffer.length !== lastJsonlLen) {
                lastJsonlLen = jsonlBuffer.length;
                lastDataTime = now;
                // Verified Claude activity — теперь безопасно сбросить PTY-fail counter.
                // Перенесено сюда из bootAndInit, чтобы фейк-успех (PTY стартанул но Claude
                // мёртв через 5 сек DLL crash) не сбрасывал backoff и не создавал spam-loop.
                if (consecutivePtyFails > 0) {
                    chatLog(`✅ Claude отозвался — сбрасываю PTY fail counter (был ${consecutivePtyFails})`, 'OVERSEER');
                    consecutivePtyFails = 0;
                    lastSuccessfulReady = Date.now();
                }
            }
            if (lastThinkingTime > lastDataTime) {
                lastDataTime = lastThinkingTime;
            }

            // Проверяем буфер на результат
            const res = conditionFn(jsonlBuffer);
            const elapsed = Math.round((now - start) / 1000);
            if (res) {
                chatLog(`✅ waitForModel: результат найден после ${elapsed}s`, 'OVERSEER');
                resetJsonlBuffer();
                return res;
            }

            // FORMAT_ERROR: 5 минут полной тишины
            const silenceSeconds = (now - lastDataTime) / 1000;
            if (silenceSeconds > FORMAT_ERROR_SILENCE_SEC) {
                return "FORMAT_ERROR";
            }

            await delay(3000);
        }
        return null;
    }

    /**
     * Авто-обнаружение команд тестирования по конфигурационным файлам проекта
     */
    function detectTestCommands() {
        const commands = [];

        // package.json — npm/yarn/pnpm
        const pkgPath = path.join(projectDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg.scripts) {
                    if (pkg.scripts.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
                        commands.push({ cmd: 'npm test', desc: `package.json scripts.test: ${pkg.scripts.test}` });
                    }
                    if (pkg.scripts['test:unit']) commands.push({ cmd: 'npm run test:unit', desc: `unit tests` });
                    if (pkg.scripts['test:e2e']) commands.push({ cmd: 'npm run test:e2e', desc: `e2e tests` });
                    if (pkg.scripts['test:integration']) commands.push({ cmd: 'npm run test:integration', desc: `integration tests` });
                    if (pkg.scripts.lint) commands.push({ cmd: 'npm run lint', desc: `linter` });
                    if (pkg.scripts.typecheck) commands.push({ cmd: 'npm run typecheck', desc: `type checking` });
                }
            } catch (e) { console.error('[error] detect_test_commands:', e.message); }
        }

        // Cargo.toml — Rust
        const cargoPath = path.join(projectDir, 'Cargo.toml');
        if (fs.existsSync(cargoPath)) {
            commands.push({ cmd: 'cargo test', desc: 'Rust cargo test' });
            commands.push({ cmd: 'cargo clippy', desc: 'Rust linter' });
        }

        // pyproject.toml / setup.py — Python
        const pyprojectPath = path.join(projectDir, 'pyproject.toml');
        const setupPyPath = path.join(projectDir, 'setup.py');
        if (fs.existsSync(pyprojectPath)) {
            try {
                const content = fs.readFileSync(pyprojectPath, 'utf8');
                if (content.includes('pytest')) commands.push({ cmd: 'pytest', desc: 'Python pytest' });
                else commands.push({ cmd: 'python -m pytest', desc: 'Python pytest (fallback)' });
            } catch (e) {
                commands.push({ cmd: 'python -m pytest', desc: 'Python pytest' });
            }
        } else if (fs.existsSync(setupPyPath)) {
            commands.push({ cmd: 'python -m pytest', desc: 'Python pytest' });
        }

        // Go
        const goModPath = path.join(projectDir, 'go.mod');
        if (fs.existsSync(goModPath)) {
            commands.push({ cmd: 'go test ./...', desc: 'Go tests' });
        }

        return commands;
    }

    // Кэшируем обнаруженные тестовые команды при старте
    const detectedTestCommands = detectTestCommands();
    if (detectedTestCommands.length > 0) {
        chatLog(`🧪 Обнаружены тестовые команды: ${detectedTestCommands.map(c => c.cmd).join(', ')}`, 'OVERSEER');
        // Сохраняем в status.json для доступа из веб-дашборда
        writeStatus(true, { testCommands: detectedTestCommands });
    }

    // ─── СПРИНТ-АУДИТ: определение границ спринта ───────────────
    function getSprintNumber(taskId) {
        return taskId.split('.')[0];
    }

    function getSprintTasks(sprintNum) {
        const walk = (dir) => {
            let r = [];
            if (!fs.existsSync(dir)) return [];
            fs.readdirSync(dir).forEach(f => {
                const p = path.join(dir, f);
                if (fs.statSync(p).isDirectory()) r = r.concat(walk(p));
                else if (f.endsWith('spec.md')) r.push(p);
            });
            return r;
        };
        const specs = walk(specsDir).sort();
        const tasks = [];
        for (const s of specs) {
            const content = fs.readFileSync(s, 'utf8');
            const re = /^-\s+\[([ x])\]\s+[\s\S]*?\{\{TASK:(\d+\.\d+)\}\}/gm;
            let m;
            while ((m = re.exec(content)) !== null) {
                if (m[2].split('.')[0] === sprintNum) {
                    tasks.push({ id: m[2], done: m[1] === 'x', file: s });
                }
            }
        }
        return tasks;
    }

    function isSprintComplete(sprintNum) {
        const tasks = getSprintTasks(sprintNum);
        return tasks.length > 0 && tasks.every(t => t.done);
    }

    function getSprintTitle(sprintNum) {
        const tasksFile = path.join(projectDir, 'tasks.md');
        if (!fs.existsSync(tasksFile)) return `Sprint ${sprintNum}`;
        try {
            const content = fs.readFileSync(tasksFile, 'utf8');
            // [^\n]+ ограничивает захват ОДНОЙ строкой markdown header,
            // ^ и m-flag — header должен быть в начале строки (не цитата в TASK).
            const match = content.match(new RegExp(`^##\\s*(?:Sprint|Спринт)\\s*${sprintNum}[:\\s]+([^\\n]+)`, 'mi'));
            return match ? match[1].trim() : `Sprint ${sprintNum}`;
        } catch (e) { return `Sprint ${sprintNum}`; }
    }

    function extractAuditResult(text) {
        const source = stripPromptFrames(jsonlBuffer || text);
        // Маркер на отдельной строке, допускаем окружающие пробелы / звёздочки markdown.
        // Regex учитывает, что аудитор иногда выводит **RALPH_AUDIT_FIX_HEAVY** или с trailing space.
        // FIX_HEAVY проверяем ПЕРЕД FIX (FIX_HEAVY содержит подстроку FIX).
        const norm = source.replace(/\*\*/g, ''); // убираем markdown bold
        if (/^\s*RALPH_AUDIT_OK\s*$/m.test(norm)) return 'OK';
        if (/^\s*RALPH_AUDIT_FIX_HEAVY\s*$/m.test(norm)) return 'FIX_HEAVY';
        if (/^\s*RALPH_AUDIT_FIX\s*$/m.test(norm)) return 'FIX';
        return null;
    }

    /**
     * Возвращает cache_read_input_tokens последнего assistant-сообщения из JSONL.
     * Используется для оценки текущего размера контекста и решения о force restart
     * при переходе в фазу fix (защита от роста к 1M-cap и ConPTY DLL crash).
     * Возвращает 0 если JSONL не доступен или нет assistant-записей.
     */
    function getLatestCacheReadTokens() {
        try {
            if (!jsonlPath || !fs.existsSync(jsonlPath)) return 0;
            const content = fs.readFileSync(jsonlPath, 'utf8');
            const lines = content.split('\n');
            // Идём с конца — последний assistant с usage.cache_read_input_tokens
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line) continue;
                try {
                    const obj = JSON.parse(line);
                    if (obj.type === 'assistant' && obj.message?.usage?.cache_read_input_tokens) {
                        return obj.message.usage.cache_read_input_tokens;
                    }
                } catch {}
            }
            return 0;
        } catch (e) { return 0; }
    }

    /**
     * Запускает полноценный аудит спринта.
     * Возвращает 'OK' | 'FIX' | null
     */
    async function auditSprint(sprintNum, attempt = 1) {
        const sprintTitle = getSprintTitle(sprintNum);
        const attemptLabel = attempt > 1 ? ` (повторный аудит #${attempt})` : '';
        chatLog(`🔍 Аудит спринта ${sprintNum}: ${sprintTitle}${attemptLabel}...`, 'OVERSEER');

        const tasks = getSprintTasks(sprintNum);
        const taskList = tasks.map(t => `  ${t.id}: ${t.done ? '✅' : '⬜'}`).join(' | ');

        // Собираем список spec-файлов спринта для подсказки аудитору
        const sprintPrefix = sprintNum.toString().padStart(3, '0');
        let specFiles = [];
        try {
            const dirs = fs.readdirSync(specsDir).filter(d => d.startsWith(sprintPrefix + '-'));
            for (const d of dirs) {
                const sf = path.join(specsDir, d, 'spec.md');
                if (fs.existsSync(sf)) specFiles.push(`specs/${d}/spec.md`);
            }
        } catch (e) { console.error('[error] read_spec_files:', e.message); }

        const auditPrompt = `Вызови скилл /ralph-auditor (через Skill tool) для аудита спринта ${sprintNum} ("${sprintTitle}").${attemptLabel}

Контекст для аудитора:
- ЗАДАЧИ СПРИНТА: ${taskList}
- SPEC-ФАЙЛЫ: ${specFiles.join(', ') || 'не найдены'}
- Это пост-имплементационный аудит (код уже написан)
- Аудитируй ТОЛЬКО спринт ${sprintNum}, не трогай другие

КРИТИЧНО — КУДА ДОБАВЛЯТЬ ДОРАБОТКИ:
Если аудит нашёл проблемы — добавь задачи-доработки В ТОТ ЖЕ спринт ${sprintNum}.
НЕ создавай новый спринт. Добавь подзадачи с номерами ${sprintNum}.N+1 (где N — последняя существующая подзадача).
Пример: если последняя задача ${sprintNum}.4, добавь ${sprintNum}.5, ${sprintNum}.6 и т.д.
Новые задачи должны быть с пометкой [ ] (не выполнены).
НЕ вызывай /task-architect — добавь задачи напрямую в tasks.md через Edit tool.
После добавления задач — вызови /ralph-spec-creator для генерации спецификаций.

АБСОЛЮТНОЕ ТРЕБОВАНИЕ — БЕЗ ЭТОГО АУДИТ СЧИТАЕТСЯ ПРОВАЛЕННЫМ:
После ПОЛНОГО завершения аудита ты ОБЯЗАН вывести РОВНО ОДНО из ТРЁХ слов-маркеров:

RALPH_AUDIT_OK         — всё в порядке, доработки не нужны

RALPH_AUDIT_FIX        — найдены ЛЁГКИЕ доработки, продолжаем в этой же сессии

RALPH_AUDIT_FIX_HEAVY  — найдены КРУПНЫЕ доработки, нужен fresh restart сессии

Критерии выбора FIX vs FIX_HEAVY:
- ≤3 простых задач (опечатки, добавить тест, мелкие правки, переименование) → FIX
- ≥4 задач, ИЛИ хотя бы одна архитектурная (рефакторинг модуля, миграция БД, новый сервис), ИЛИ суммарно ≥500 строк изменений → FIX_HEAVY
- Если сомневаешься — выбирай FIX_HEAVY (overhead restart дешевле чем DLL crash при большом контексте)

Маркер должен быть на ОТДЕЛЬНОЙ строке, без дополнительного текста.
Без этого маркера overseer не сможет определить результат аудита и засчитает таймаут.
Выведи маркер ПОСЛЕДНИМ сообщением, после всех отчётов и логов.`;

        logicalBuffer = '';
        jsonlBuffer = '';
        sendCommand(ptyProcess, auditPrompt);

        const auditResult = await waitForModel(extractAuditResult, 900);

        if (auditResult === 'FIX') {
            chatLog(`🔧 Аудит спринта ${sprintNum}: найдены ЛЁГКИЕ доработки (продолжаем в той же сессии).`, 'OVERSEER');
            return 'FIX';
        } else if (auditResult === 'FIX_HEAVY') {
            chatLog(`🔧 Аудит спринта ${sprintNum}: найдены КРУПНЫЕ доработки (нужен fresh restart перед fix-циклом).`, 'OVERSEER');
            return 'FIX_HEAVY';
        } else if (auditResult === 'OK') {
            chatLog(`✅ Аудит спринта ${sprintNum}: всё в порядке.`, 'OVERSEER');
            return 'OK';
        } else if (auditResult === null) {
            chatLog(`⚠️ Аудит спринта ${sprintNum}: не получен ответ (таймаут). Пропускаем.`, 'OVERSEER');
            return null;
        } else {
            // Защита от silent failures: если extractAuditResult вернул что-то новое,
            // что mainLoop не обрабатывает — явно логируем и считаем как null, чтобы
            // не пройти вперёд по неизвестному пути. См. инцидент 2026-05-02 sprint 38/39:
            // 'FIX_HEAVY' не был добавлен в этот switch → проваливался в else → null →
            // mainLoop пропускал regenerate spec и шёл собирать отчёты за невыполненные задачи.
            chatLog(`⚠️ Аудит спринта ${sprintNum}: extractAuditResult вернул неожиданное значение ${JSON.stringify(auditResult)}. Считаю null, проверьте код.`, 'OVERSEER');
            return null;
        }
    }

    // Трекинг аудитов: спринт → количество попыток
    const sprintAuditAttempts = {};
    const MAX_AUDIT_ATTEMPTS = 5; // Максимум 5 циклов аудита на спринт

    function findNextTask() {
        const walk = (dir) => {
            let r = [];
            if (!fs.existsSync(dir)) return [];
            fs.readdirSync(dir).forEach(f => {
                const p = path.join(dir, f);
                if (fs.statSync(p).isDirectory()) r = r.concat(walk(p));
                else if (f.endsWith('spec.md')) r.push(p);
            });
            return r;
        };
        const specs = walk(specsDir).sort();
        for (const s of specs) {
            const content = fs.readFileSync(s, 'utf8');
            const match = content.match(/^-\s+\[\s*\]\s+([\s\S]*?\{\{TASK:([\d.]+)\}\}[\s\S]*?)(?=\n-\s+\[|\n##|$)/m);
            if (match) return { file: s, text: match[1].trim(), id: match[2] };
        }
        return null;
    }

    // ─── SPRINT-BATCH MODE ─────────────────────────────────────

    /**
     * Находит следующий невыполненный спринт.
     * Возвращает { sprintNum, tasks, title, undoneTasks } или null
     */
    function findNextSprint() {
        const task = findNextTask();
        if (!task) return null;

        const sprintNum = getSprintNumber(task.id);
        const tasks = getSprintTasks(sprintNum);
        const title = getSprintTitle(sprintNum);
        const undoneTasks = tasks.filter(t => !t.done);

        return { sprintNum, tasks, title, undoneTasks };
    }

    /**
     * Отмечает задачу как выполненную в spec.md и tasks.md
     */
    function markTaskDone(task) {
        // Atomic file write with retry
        function safeWriteFile(filePath, updateFn, maxRetries = 3) {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const updated = updateFn(content);
                    if (updated !== null) {
                        const tmpPath = filePath + '.tmp';
                        fs.writeFileSync(tmpPath, updated, 'utf8');
                        fs.renameSync(tmpPath, filePath);
                    }
                    return true;
                } catch (e) {
                    if (attempt < maxRetries - 1) {
                        const d = 100 * (attempt + 1);
                        // Non-busy sleep: yields event loop unlike while(Date.now())
                        const sab = new SharedArrayBuffer(4);
                        Atomics.wait(new Int32Array(sab), 0, 0, d);
                    } else {
                        console.error(`safeWriteFile failed for ${filePath}: ${e.message}`);
                        return false;
                    }
                }
            }
        }

        const markFn = (content) => {
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(`{{TASK:${task.id}}}`) && lines[i].includes('[ ]')) {
                    lines[i] = lines[i].replace('[ ]', '[x]');
                    return lines.join('\n');
                }
            }
            return null;
        };

        // Mark in spec.md
        if (task.file) safeWriteFile(task.file, markFn);

        // Mark in tasks.md
        const tasksFile = path.join(projectDir, 'tasks.md');
        if (fs.existsSync(tasksFile)) safeWriteFile(tasksFile, markFn);
    }

    /**
     * Детектор завершения спринта
     */
    function extractSprintDone(text) {
        let source = stripPromptFrames(jsonlBuffer || text);
        // Защита от orphan BEGIN: если PTY crash случился между записью BEGIN и END
        // маркеров — рамка незакрыта, stripPromptFrames non-greedy regex не вырежет.
        // RALPH_SPRINT_DONE из инструкции (правило 2 + ВАЖНО блок) останется в source →
        // false positive 'DONE'. Insurance: всё после orphan BEGIN отрезаем.
        // См. инцидент 2026-04-27.
        const orphanBegin = source.indexOf('<<<RALPH_PROMPT_BEGIN>>>');
        if (orphanBegin >= 0) source = source.substring(0, orphanBegin);
        // Строгая проверка: маркер на отдельной строке (не внутри цитаты промпта)
        if (/^RALPH_SPRINT_DONE\s*$/m.test(source)) return 'DONE';
        return null;
    }

    // ─── SPRINT SESSION TRACKING ───────────────────────────────
    const sprintSessionsFile = path.join(runnerDir, 'sprint_sessions.json');

    function loadSprintSessions() {
        try {
            if (fs.existsSync(sprintSessionsFile)) {
                return JSON.parse(fs.readFileSync(sprintSessionsFile, 'utf8'));
            }
        } catch (e) { console.error('[error] load_sprint_sessions:', e.message); }
        return {};
    }

    function saveSprintSession(sprintNum, sid) {
        const sessions = loadSprintSessions();
        sessions[sprintNum] = { sessionId: sid, updatedAt: new Date().toISOString() };
        // Atomic write: tmp + rename для защиты от прерывания записи
        const tmpFile = sprintSessionsFile + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(sessions, null, 2), 'utf8');
        fs.renameSync(tmpFile, sprintSessionsFile);
    }

    function getSprintSessionId(sprintNum) {
        const sessions = loadSprintSessions();
        return sessions[sprintNum]?.sessionId || null;
    }

    function clearSprintSession(sprintNum) {
        const sessions = loadSprintSessions();
        delete sessions[sprintNum];
        const tmpFile = sprintSessionsFile + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(sessions, null, 2), 'utf8');
        fs.renameSync(tmpFile, sprintSessionsFile);
    }

    const MAX_RESTARTS = 5;
    let sprintRestarts = 0;
    let lastSprintNum = null;

    async function mainLoop() {
        // ─── Проверяем: есть ли незавершённый спринт с сохранённой сессией ───
        const firstSprint = findNextSprint();
        let resumeSid = null;
        if (firstSprint) {
            resumeSid = getSprintSessionId(firstSprint.sprintNum);
            if (resumeSid) {
                // Проверяем что JSONL существует.
                // КРИТИЧНО: используем workspaceDirResolved (real path без junction), потому что
                // Claude Code v2.1.117+ резолвит junction перед вычислением slug'а. spawnAgent тоже
                // использует workspaceDirResolved при создании jsonlPath. Если тут взять plain
                // workspaceDir — slug будет другой → fs.existsSync всегда false → resume всегда
                // сбрасывается, даже если JSONL на диске реально есть.
                const testJsonl = path.join(claudeProjectsDir, projectSlug(workspaceDirResolved), `${resumeSid}.jsonl`);
                if (!fs.existsSync(testJsonl)) {
                    chatLog(`⚠️ JSONL для сессии ${resumeSid} не найден. Начинаю новую сессию.`, 'OVERSEER');
                    resumeSid = null;
                    clearSprintSession(firstSprint.sprintNum);
                }
            }
        }

        // Первый запуск (или resume)
        spawnAgent(resumeSid);
        const bootOk = await bootAndInit(!!resumeSid);
        if (!bootOk) return;

        while (!stopRequested) {
            if (fs.existsSync(stopFile)) break;

            // ─── ПАУЗА: ждём удаления .ralph-pause ───
            while (fs.existsSync(pauseFile) && !stopRequested) {
                chatLog('⏸️ Пауза...', 'OVERSEER');
                updateStatus({ paused: true });
                await delay(2000);
                if (fs.existsSync(stopFile)) { stopRequested = true; break; }
            }
            if (stopRequested) break;
            updateStatus({ paused: false });

            // ─── НАЙТИ СЛЕДУЮЩИЙ СПРИНТ ───
            const sprint = findNextSprint();
            if (!sprint) {
                chatLog("🎉 ПРОЕКТ ВЫПОЛНЕН!", 'OVERSEER');

                // Генерация launch.json если его нет
                const launchFile = path.join(projectDir, 'launch.json');
                if (!fs.existsSync(launchFile)) {
                    chatLog("🚀 Генерирую launch.json...", 'OVERSEER');
                    logicalBuffer = '';
                    sendCommand(ptyProcess, 'Проект завершён. Создай файл launch.json в корне проекта с инструкцией запуска. Формат: {"type":"web|open|command|node","command":"...","cwd":".","description":"..."}. Проанализируй проект и выбери правильный тип и команду. После создания выведи: RALPH_READY');
                    const launchRes = await waitForModel(extractInitReady, 120);
                    if (!launchRes || !fs.existsSync(launchFile)) {
                        chatLog("⚠️ Claude не создал launch.json, создаю автоматически...", 'OVERSEER');
                        let launchConfig;
                        if (fs.existsSync(path.join(projectDir, 'index.html'))) {
                            launchConfig = { type: 'web', command: 'npx http-server -p 8090 -o', cwd: '.', description: 'Открыть в браузере' };
                        } else if (fs.existsSync(path.join(projectDir, 'package.json'))) {
                            try {
                                const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
                                if (pkg.scripts && pkg.scripts.start) {
                                    launchConfig = { type: 'command', command: 'npm start', cwd: '.', description: 'Запуск через npm start' };
                                }
                            } catch (e) { console.error('[error] parse_package_json:', e.message); }
                        } else if (fs.existsSync(path.join(projectDir, 'main.py'))) {
                            launchConfig = { type: 'command', command: 'python main.py', cwd: '.', description: 'Запуск Python' };
                        }
                        if (launchConfig) {
                            fs.writeFileSync(launchFile, JSON.stringify(launchConfig, null, 2), 'utf8');
                            chatLog("✅ launch.json создан автоматически.", 'OVERSEER');
                        }
                    } else {
                        chatLog("✅ launch.json создан Claude.", 'OVERSEER');
                    }
                }

                break;
            }

            const { sprintNum, tasks: sprintTasks, title: sprintTitle, undoneTasks } = sprint;

            // Сброс счётчика перезапусков при переходе на новый спринт
            if (lastSprintNum !== sprintNum) {
                sprintRestarts = 0;
                lastSprintNum = sprintNum;
            }

            // ─── ПРОВЕРКА: нужно ли resume для этого спринта ───
            const savedSid = getSprintSessionId(sprintNum);
            if (savedSid && savedSid !== sessionId) {
                // Спринт привязан к другой сессии — нужен resume
                chatLog(`🔄 Спринт ${sprintNum} привязан к сессии ${savedSid}. Resume...`, 'OVERSEER');
                const resumed = await restartAgent(`resume спринта ${sprintNum}`, savedSid);
                if (!resumed) {
                    chatLog(`⚠️ Resume не удался. Начинаю новую сессию для спринта ${sprintNum}.`, 'OVERSEER');
                    clearSprintSession(sprintNum);
                    const freshStart = await restartAgent(`новая сессия для спринта ${sprintNum}`);
                    if (!freshStart) { chatLog('❌ Перезапуск не удался. Остановка.', 'OVERSEER'); break; }
                }
            }

            // ─── СОХРАНЯЕМ ПРИВЯЗКУ СПРИНТ → СЕССИЯ ───
            if (!savedSid) {
                saveSprintSession(sprintNum, sessionId);
            }

            chatLog(`🚀 Спринт ${sprintNum}: ${sprintTitle} (${undoneTasks.length} задач)`, 'OVERSEER');
            updateStatus({ sprint: sprintNum, sprintTitle, tasksTotal: sprintTasks.length, tasksDone: sprintTasks.length - undoneTasks.length, phase: 'executing' });

            // ─── ФОРМИРУЕМ ПРОМПТ ───
            const testHint = detectedTestCommands.length > 0
                ? `\nТЕСТИРОВАНИЕ: В проекте обнаружены тестовые команды: ${detectedTestCommands.map(c => `${c.cmd} (${c.desc})`).join('; ')}. После реализации запусти релевантные тесты.`
                : '';

            // Референсы
            const sprintPrefix = sprintNum.toString().padStart(3, '0');
            let refsHint = '';
            try {
                const dirs = fs.readdirSync(specsDir).filter(d => d.startsWith(sprintPrefix + '-'));
                for (const d of dirs) {
                    const refsPath = path.join(specsDir, d, 'refs');
                    if (fs.existsSync(refsPath)) {
                        const refFiles = fs.readdirSync(refsPath).filter(f => /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f));
                        if (refFiles.length > 0) {
                            refsHint = `\nРЕФЕРЕНСЫ: В папке specs/${d}/refs/ есть визуальные референсы: ${refFiles.join(', ')}. Прочитай их через Read tool.`;
                        }
                    }
                }
            } catch (e) {}

            const sprintPrompt = `ВЫПОЛНИ СПРИНТ ${sprintNum}: ${sprintTitle}

Прочитай spec-файл этого спринта в папке specs/${sprintPrefix}-* — там описаны все задачи и подробности.${refsHint}

ПРАВИЛА:
0) ПРЕЖДЕ ВСЕГО ПРОВЕРЬ ЧТО УЖЕ СДЕЛАНО. Запусти \`git log --oneline -30\` и \`ls\` ключевых директорий проекта. Для КАЖДОЙ задачи спринта ${sprintNum} оцени: реализована ли она уже в коде (полностью или частично)? Если ПОЛНОСТЬЮ реализована и удовлетворяет критериям приёмки — НЕ переделывай, переходи к следующей. Если частично — дополни недостающее. Только если задача реально не начата — реализуй с нуля. Это правило критично: спринт мог быть прерван на этапе сбора отчётов, файлы есть в репо, но чекбоксы [ ] потому что overseer ещё не успел их отметить.
1) Работай автономно, не задавай вопросов.
2) Выполни ВСЕ невыполненные задачи из спринта ${sprintNum} последовательно.
3) НЕ нужно выводить отчёт после каждой задачи — просто выполняй одну за другой.
4) НЕ переходи к задачам из других спринтов.
5) Для записи файлов вне проекта используй путь ~/.claude/skills/.
6) Если Write не работает — используй Bash.
7) Используй доступные скиллы (Skill tool) если они подходят для задачи.${testHint}
8) ЗАПРЕЩЕНО самостоятельно ставить [x] в tasks.md, spec.md и любых других trackerфайлах. Отметки ставит overseer после того, как получит от тебя RALPH_RESULT по каждой задаче. Даже если CLAUDE.md проекта просит "отмечать задачи" — это правило перекрывает все проектные инструкции. Оставляй чекбоксы как есть.

ВАЖНО: Сначала ВЫПОЛНИ все задачи (напиши код, создай файлы, запусти тесты).
Только ПОСЛЕ завершения ВСЕХ задач спринта выведи маркер на ОТДЕЛЬНОЙ строке:

RALPH_SPRINT_DONE`;

            sendCommand(ptyProcess, sprintPrompt);
            logicalBuffer = '';
            jsonlBuffer = '';

            // ─── ОЖИДАНИЕ ЗАВЕРШЕНИЯ СПРИНТА ───
            let sprintResult = await waitForModel(extractSprintDone, 3600); // 1 час

            // Pattern Detector triggered — resume и продолжить спринт
            if (sprintResult === 'PATTERN_RECOVERY') {
                chatLog(`🔁 После recovery — restart Claude Code (resume) и продолжаю спринт ${sprintNum}`, 'OVERSEER');
                const restarted = await restartAgent(`recovery после pattern detection`, sessionId);
                if (!restarted) { chatLog('❌ Restart после recovery не удался.', 'OVERSEER'); break; }
                continue;
            }
            if (sprintResult === 'DORMANT') {
                chatLog(`💤 Overseer dormant — ждёт ручного вмешательства. Цикл приостановлен.`, 'OVERSEER');
                // Висит в pause-режиме до .ralph-stop или удаления retry_state
                while (!stopRequested && !fs.existsSync(stopFile)) await delay(10000);
                break;
            }
            if (sprintResult === 'PTY_DEAD') {
                consecutivePtyFails++;
                // Auto session reset: если 2+ быстрых смертей подряд (<30s) И есть sessionId
                // — JSONL state damaged, resume на эту session всегда крашится. Сбрасываем
                // привязку спринта и стартуем fresh без resume. См. инцидент 2026-04-27.
                if (consecutiveFastResumeDeaths >= 2 && sessionId) {
                    chatLog(`🔄 ${consecutiveFastResumeDeaths} быстрых resume-смертей подряд — sessionId ${sessionId} corrupted. Auto-reset спринта ${sprintNum} → fresh start.`, 'OVERSEER');
                    try {
                        clearSprintSession(sprintNum);
                        chatLog(`🗑️ Очищен sessionId спринта ${sprintNum} в sprint_sessions.json`, 'OVERSEER');
                    } catch (e) { console.error('[error] auto_reset_clear_session:', e.message); }
                    sessionId = null;
                    consecutiveFastResumeDeaths = 0;
                    consecutivePtyFails = 0; // fresh start — счётчики начинают с нуля
                    const restarted = await restartAgent(`auto session reset (resume corrupted)`, null);
                    if (!restarted) { chatLog(`⚠️ Auto-reset restart не удался — попробую снова в следующем цикле.`, 'OVERSEER'); continue; }
                    continue;
                }
                // Страховка: если consecutiveFastResumeDeaths не сработал (PTY умирал на границе
                // порога), но накопилось 5+ PTY fail'ов подряд — force fresh независимо от ageMs.
                // См. инцидент 2026-05-01 Domovoy sprint 38 fail #18: PTY умирал на 15-16s,
                // ageMs=15000 не попадал в `< 15000` (было), счётчик сбрасывался → auto-reset
                // не наступал → 18 fail'ов в loop'е без вмешательства.
                if (consecutivePtyFails >= 5 && sessionId) {
                    chatLog(`🔄 ${consecutivePtyFails} PTY fail'ов подряд при resume — force fresh start независимо от ageMs.`, 'OVERSEER');
                    try {
                        clearSprintSession(sprintNum);
                        chatLog(`🗑️ Очищен sessionId спринта ${sprintNum} в sprint_sessions.json`, 'OVERSEER');
                    } catch (e) { console.error('[error] force_fresh_clear_session:', e.message); }
                    sessionId = null;
                    consecutiveFastResumeDeaths = 0;
                    consecutivePtyFails = 0;
                    const restarted = await restartAgent(`force fresh after 5 consecutive PTY fails`, null);
                    if (!restarted) { chatLog(`⚠️ Force-fresh restart не удался — попробую снова в следующем цикле.`, 'OVERSEER'); continue; }
                    continue;
                }
                // Retry budget: если за последние 24 часа не было ни одного RALPH_READY → dormant
                const hoursSinceLastReady = (Date.now() - lastSuccessfulReady) / 3600000;
                if (hoursSinceLastReady >= 24) {
                    chatLog(`💤 Claude Code недоступен ${hoursSinceLastReady.toFixed(1)}ч (>24ч). Dormant. Проверьте подписку/сеть.`, 'OVERSEER');
                    updateStatus({ phase: 'dormant', dormant_reason: 'Claude Code unavailable >24h' });
                    while (!stopRequested && !fs.existsSync(stopFile)) await delay(10000);
                    break;
                }
                // Exponential backoff С ПЕРВОГО fail'а — иначе DLL crash при boot'е
                // создаёт мгновенный restart loop, который сжигает API-лимит за минуты.
                // 30s/60s/120s/240s/.../3600s (cap 1ч).
                const backoffSec = Math.min(3600, 30 * Math.pow(2, consecutivePtyFails - 1));
                chatLog(`⏳ PTY fail #${consecutivePtyFails} — sleep ${backoffSec}s перед restart`, 'OVERSEER');
                // sleepInterruptible exits early с 'wake' если retryStateFile отсутствует
                // (механизм для wake-up через POST /api/wake). PTY backoff не использует
                // этот mechanism, поэтому создаём stub-state чтобы sleep не выходил мгновенно.
                // См. инцидент 2026-04-27: 15-сек spam-цикл из-за нулевого backoff.
                saveRetryState({ kind: 'pty_backoff', untilMs: Date.now() + backoffSec * 1000, label: `PTY backoff (fail #${consecutivePtyFails})`, started_at: new Date().toISOString() });
                const reason = await sleepInterruptible(Date.now() + backoffSec * 1000, `PTY backoff (fail #${consecutivePtyFails})`);
                clearRetryState();
                if (reason === 'stop') { stopRequested = true; break; }
                const restarted = await restartAgent(`PTY died, auto-restart #${consecutivePtyFails}`, sessionId || null);
                if (!restarted) { chatLog(`⚠️ Auto-restart не удался — попробую снова в следующем цикле.`, 'OVERSEER'); continue; }
                continue;
            }

            // Retry если нет маркера
            let retries = 0;
            while (!sprintResult && retries < 3 && !stopRequested) {
                retries++;
                const secSinceThinking = (Date.now() - lastThinkingTime) / 1000;
                if (secSinceThinking < 120) {
                    chatLog(`⏳ Спринт ${sprintNum}: Claude ещё активен. Ждём...`, 'OVERSEER');
                    sprintResult = await waitForModel(extractSprintDone, 600);
                    if (sprintResult === 'PATTERN_RECOVERY') {
                        const r = await restartAgent(`recovery (retry loop)`, sessionId);
                        if (!r) break;
                        sprintResult = null; continue;
                    }
                    continue;
                }
                // Если pause активна — не шлём nudge (PTY заморожен, nudge уйдёт в буфер
                // и при снятии паузы выплюнется весь разом). Ждём снятия.
                while (fs.existsSync(pauseFile) && !stopRequested && !fs.existsSync(stopFile)) {
                    await delay(2000);
                }
                if (stopRequested || fs.existsSync(stopFile)) break;
                chatLog(`⚠️ Спринт ${sprintNum}: нет маркера. Напоминание (${retries}/3)...`, 'OVERSEER');
                sendNudge(ptyProcess, `Ты закончил все задачи спринта ${sprintNum}? Если да, выведи маркер на отдельной строке:\n\nRALPH_SPRINT_DONE`);
                sprintResult = await waitForModel(extractSprintDone, 300);
            }

            if (stopRequested) break;

            if (!sprintResult) {
                // Спринт не завершён — перезапуск с resume
                sprintRestarts++;
                if (sprintRestarts > MAX_RESTARTS) {
                    chatLog(`❌ Превышен лимит перезапусков (${MAX_RESTARTS}). Остановка.`, 'OVERSEER');
                    clearSprintSession(sprintNum); // clean stale session to avoid repeated resume failures
                    break;
                }
                chatLog(`⚠️ Спринт ${sprintNum}: не завершён. Перезапуск ${sprintRestarts}/${MAX_RESTARTS} (resume)...`, 'OVERSEER');
                // Resume той же сессии — Claude продолжит с сохранённым контекстом
                const restarted = await restartAgent(`resume спринта ${sprintNum}`, sessionId);
                if (!restarted) {
                    chatLog(`❌ Resume не удался. Остановка.`, 'OVERSEER');
                    break;
                }
                continue; // Вернёмся в цикл — findNextSprint вернёт тот же спринт
            }

            // ─── СПРИНТ ЗАВЕРШЁН (Claude вывел RALPH_SPRINT_DONE) ───
            chatLog(`✅ Спринт ${sprintNum}: Claude отчитался о завершении. Перехожу к аудиту/сбору отчётов.`, 'OVERSEER');
            // ВАЖНО: задачи НЕ помечаются [x] здесь. Это делает markTaskCollected() ПОСЛЕ
            // получения RALPH_RESULT и сохранения results/<id>.json. Гарантирует что
            // ложно-зелёный спринт (помеченный без отчётов) невозможен — даже если batch-сбор
            // упадёт по таймауту, задачи останутся [ ] и при resume Claude вернётся доделать.

            // ─── EARLY STOP CHECK ───
            // Если .ralph-stop появился пока мы были в waitForModel (RALPH_SPRINT_DONE),
            // НЕ запускаем дорогой аудит / batch-collect — выходим сразу. Иначе тратим
            // токены на промпты которые Claude всё равно не обработает.
            if (stopRequested || fs.existsSync(stopFile)) { stopRequested = true; break; }

            // ─── АУДИТ ───
            const attempts = sprintAuditAttempts[sprintNum] || 0;
            if (attempts < MAX_AUDIT_ATTEMPTS) {
                sprintAuditAttempts[sprintNum] = attempts + 1;
                chatLog(`📋 Аудит спринта ${sprintNum} (попытка ${attempts + 1}/${MAX_AUDIT_ATTEMPTS})...`, 'OVERSEER');
                updateStatus({ phase: 'auditing' });
                const auditResult = await auditSprint(sprintNum, attempts + 1);
                if (auditResult === 'FIX' || auditResult === 'FIX_HEAVY') {
                    // ─── COLLECT-FROM-CURRENT-SESSION: опрос текущей сессии перед restart ───
                    // ВАЖНО: отчёты по выполненной работе должны браться у ТОЙ сессии Claude,
                    // которая её делала. После fresh restart на FIX_HEAVY новая сессия не помнит
                    // деталей реализации, ей придётся reverse-engineer через git diff/log.
                    // Опрашиваем ТЕКУЩУЮ сессию ПЕРЕД restart по всем задачам, которые в spec
                    // ещё не имеют RALPH_RESULT файла.
                    //
                    // Это работает для обоих случаев: FIX и FIX_HEAVY. Для FIX страховка от
                    // последующего краха в той же сессии. Для FIX_HEAVY — критично, иначе
                    // отчёты будут от другого "автора".
                    try {
                        const tasksWithoutReport = getSprintTasks(sprintNum).filter(t => {
                            const safeId = t.id.replace(/\./g, '_');
                            return !fs.existsSync(path.join(resultsDir, `${safeId}.json`));
                        });
                        if (tasksWithoutReport.length > 0) {
                            chatLog(`💾 Pre-fix collect: опрашиваю текущую сессию по ${tasksWithoutReport.length} задач без RALPH_RESULT...`, 'OVERSEER');
                            // Batch-промпт: список задач которые НУЖНО отчитать. Claude САМ решает
                            // про какие выводить RALPH_RESULT (которые он сделал), про какие пропустить
                            // (не сделал в этой сессии). Это защищает от "Claude делает задачу под
                            // видом отчёта" — он отчитывается только за уже сделанное.
                            const taskList = tasksWithoutReport.map(t => `  - ${t.id}`).join('\n');
                            resetJsonlBuffer();
                            sendCommand(ptyProcess, `Аудитор нашёл доработки. Перед перезапуском сессии — отчитайся ТОЛЬКО за те задачи спринта ${sprintNum}, которые ты УЖЕ выполнил в этой сессии (или закоммитил ранее и точно знаешь что они сделаны). Для каждой такой задачи выведи блок:\n\nRALPH_RESULT\nTASK: <id>\nBRIEF: что сделано\nSUMMARY: техническое описание\nSTATUS: DONE\nRALPH_END\n\nЕсли задача НЕ сделана — НЕ выводи блок для неё (пропусти молча). Список задач которые без отчёта:\n\n${taskList}\n\nВыведи отчёты подряд без markdown-обёрток.`);
                            const extractBatch = () => {
                                const results = extractAllResults(jsonlBuffer);
                                // Считаем "достаточно": когда нет новых блоков 30s или их >= ожидаемое
                                if (results.length >= tasksWithoutReport.length) return results;
                                return null;
                            };
                            let batchResults = await waitForModel(extractBatch, 240);
                            if (batchResults === 'FORMAT_ERROR' || batchResults === null) {
                                batchResults = extractAllResults(jsonlBuffer);
                            }
                            if (Array.isArray(batchResults) && batchResults.length > 0) {
                                if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, "# История проекта\n\n", 'utf8');
                                // Whitelist — Claude может ответить task_id из чужой задачи.
                                // См. инцидент 2026-05-02 sprint 39: file 39_7.json содержал task_id 39.6.
                                const preFix_requestedIds = new Set(tasksWithoutReport.map(t => t.id));
                                let collected = 0;
                                for (const r of batchResults) {
                                    if (r.status !== 'DONE') continue;
                                    const taskId = r.task_id;
                                    if (!preFix_requestedIds.has(taskId)) {
                                        chatLog(`⚠️ Pre-fix: игнорирую RALPH_RESULT с task_id=${taskId} — не в запросе`, 'OVERSEER');
                                        continue;
                                    }
                                    const safeId = taskId.replace(/\./g, '_');
                                    fs.writeFileSync(path.join(resultsDir, `${safeId}.json`), JSON.stringify({
                                        status: 'READY',
                                        task_id: taskId,
                                        brief: r.brief || '',
                                        summary: r.summary || 'Задача выполнена.'
                                    }, null, 2), 'utf8');
                                    try { markTaskCollected(taskId, sessionId); } catch (e) { console.error('[error] mark_collected_pre_fix:', e.message); }
                                    let briefLine = r.brief || `Task ${taskId}`;
                                    if (briefLine.length > 150) briefLine = briefLine.slice(0, 147) + '...';
                                    fs.appendFileSync(historyFile, `### [${new Date().toLocaleString()}] Задача ${taskId}\n${briefLine}\n\n<details><summary>Подробности</summary>\n\n${r.summary}\n\n</details>\n\n---\n\n`, 'utf8');
                                    chatLog(`✅ pre-fix ${taskId}: ${(r.brief || '').slice(0, 80)}`, 'OVERSEER');
                                    collected++;
                                }
                                chatLog(`💾 Pre-fix собрано ${collected} отчётов из ${tasksWithoutReport.length}`, 'OVERSEER');
                                // Промежуточный wip-commit — страховка от потери при крахе fresh-сессии
                                try {
                                    require('child_process').execSync('git add -A', { cwd: projectDir, timeout: 60000 });
                                    require('child_process').execSync(`git commit -m "wip(sprint-${sprintNum}): partial progress before audit-fix" --no-verify`, { cwd: projectDir, timeout: 60000 });
                                    chatLog(`💾 Промежуточный wip-коммит спринта ${sprintNum}`, 'OVERSEER');
                                } catch (commitErr) {
                                    chatLog(`ℹ️ Промежуточный коммит пропущен (возможно нечего): ${commitErr.message?.slice(0, 80)}`, 'OVERSEER');
                                }
                            } else {
                                chatLog(`⚠️ Pre-fix: текущая сессия не вернула отчётов — продолжаем, новая сессия попробует позже`, 'OVERSEER');
                            }
                        }
                    } catch (e) {
                        chatLog(`⚠️ Pre-fix collect упал: ${e.message?.slice(0, 100)} — продолжаю`, 'OVERSEER');
                    }

                    // Аудитор добавил задачи в tasks.md — но spec.md файлы остались старые,
                    // task_state.json тоже stale. Регенерируем spec для текущего спринта и
                    // обновляем task_state, чтобы следующая итерация увидела новые задачи.
                    try {
                        const sprintPrefix = sprintNum.toString().padStart(3, '0');
                        // Match BOTH single (NNN-Title) AND chunked (NNN — без дефиса, содержит подпапки M-Title).
                        // См. инцидент 2026-04-27: при MAX_TASKS_PER_CHUNK=4 spec-converter создавал chunked
                        // structure NNN/M-Title/, и cleanup с фильтром 'NNN-' их не удалял → накапливалось до 6
                        // вложенных подпапок. Сейчас MAX=999 (chunking off), но защита от наследия осталась.
                        const dirs = fs.readdirSync(specsDir).filter(d =>
                            d === sprintPrefix || d.startsWith(sprintPrefix + '-')
                        );
                        for (const d of dirs) {
                            const fullPath = path.join(specsDir, d);
                            try { fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 3 }); chatLog(`🗑️ Удалён старый spec: ${d}`, 'OVERSEER'); }
                            catch (e) { chatLog(`⚠️ Не удалось удалить ${d}: ${e.message}`, 'OVERSEER'); }
                        }
                        const converterPath = path.join(__dirname, 'spec-converter-fixed.ps1');
                        if (fs.existsSync(converterPath)) {
                            chatLog(`🔧 Перегенерирую spec.md для спринта ${sprintNum}...`, 'OVERSEER');
                            require('child_process').execSync(
                                `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${converterPath}"`,
                                { cwd: projectDir, timeout: 60000, stdio: 'pipe' }
                            );
                            chatLog(`✅ spec.md спринта ${sprintNum} перегенерирован`, 'OVERSEER');
                        } else {
                            chatLog(`⚠️ spec-converter не найден: ${converterPath}`, 'OVERSEER');
                        }
                        // Перечитываем task_state из обновлённого tasks.md
                        importTaskStateFromMd();
                        chatLog(`🔄 task_state.json обновлён из tasks.md`, 'OVERSEER');
                    } catch (e) {
                        chatLog(`⚠️ Авто-регенерация spec/task_state не удалась: ${e.message?.slice(0, 100)}`, 'OVERSEER');
                    }
                    // Проверяем что аудитор действительно добавил задачи
                    const postAuditSprint = findNextSprint();
                    if (postAuditSprint && postAuditSprint.sprintNum === sprintNum && postAuditSprint.undoneTasks.length > 0) {
                        chatLog(`🔄 Аудитор добавил ${postAuditSprint.undoneTasks.length} доработок в спринт ${sprintNum}. Продолжаю выполнение...`, 'OVERSEER');
                    } else {
                        chatLog(`⚠️ Аудитор сказал FIX, но невыполненных задач в спринте ${sprintNum} не найдено (возможно spec не создан). Продолжаю...`, 'OVERSEER');
                    }

                    // ─── Force fresh restart перед fix-цикл ───
                    // Триггеры для restart перед началом fix-задач:
                    //   1. Аудитор сказал FIX_HEAVY (≥4 задач или архитектурная переписка) — agent оценил
                    //   2. cache_read_input_tokens последнего ответа > 400K — страховка от ConPTY DLL crash
                    //      и от приближения к 1M context cap
                    // На FIX (без HEAVY) и cache <= 400K — продолжаем в той же сессии (экономим overhead).
                    const cacheReadTokens = getLatestCacheReadTokens();
                    const CONTEXT_RESTART_THRESHOLD = 400000;
                    const needsRestart = (auditResult === 'FIX_HEAVY') || (cacheReadTokens > CONTEXT_RESTART_THRESHOLD);
                    if (needsRestart) {
                        const reason = auditResult === 'FIX_HEAVY'
                            ? `аудитор пометил доработки как HEAVY`
                            : `контекст ${Math.round(cacheReadTokens / 1000)}K > ${CONTEXT_RESTART_THRESHOLD / 1000}K cap`;
                        chatLog(`🔄 Fresh restart перед fix-циклом: ${reason}`, 'OVERSEER');
                        try {
                            clearSprintSession(sprintNum);
                            chatLog(`🗑️ Очищен sessionId спринта ${sprintNum} → fresh start`, 'OVERSEER');
                        } catch (e) { console.error('[error] clear_session_for_fix_restart:', e.message); }
                        sessionId = null;
                        consecutiveFastResumeDeaths = 0;
                        consecutivePtyFails = 0;
                        const restarted = await restartAgent(`fresh restart перед fix-циклом (${reason})`, null);
                        if (!restarted) { chatLog(`⚠️ Fresh restart не удался — попробую снова в следующем цикле.`, 'OVERSEER'); continue; }
                    }
                    continue; // Вернёмся — findNextSprint найдёт новые невыполненные задачи (или следующий спринт)
                }
            }

            // ─── BATCH-СБОР ОТЧЁТОВ (один промпт на все задачи) ───
            // Защита от "Claude делает задачу под видом отчёта": срабатывает на нижнем уровне.
            // - batchResults обрабатываются с `if (r.status !== 'DONE') continue` — Claude может
            //   ответить STATUS: PENDING для невыполненной, и markCollected не вызовется → задача
            //   останется [ ] → finalUncollected проверка после batch → continue → следующая
            //   итерация sprintLoop найдёт её через findNextSprint → executing.
            // - Раньше тут был блок "если есть [ ] в task_state — return к executing", но он
            //   создавал бесконечный loop: task_state.done == false для ВСЕХ задач до batch
            //   (markCollected вызывается только после получения RALPH_RESULT), поэтому условие
            //   срабатывало даже на корректном AUDIT_OK → loop. См. инцидент 2026-05-02 ночью.
            const allTasks = getSprintTasks(sprintNum);
            // Фильтруем задачи, для которых уже есть результат
            const tasksNeedingReport = allTasks.filter(t => {
                const safeId = t.id.replace(/\./g, '_');
                return !fs.existsSync(path.join(resultsDir, `${safeId}.json`));
            });

            if (tasksNeedingReport.length > 0) {
                // EARLY STOP — не отправляем длинный batch-промпт если уже остановили
                if (stopRequested || fs.existsSync(stopFile)) { stopRequested = true; break; }

                chatLog(`📝 Сбор отчётов: ${tasksNeedingReport.length} задач спринта ${sprintNum} (batch)...`, 'OVERSEER');
                updateStatus({ phase: 'collecting_reports' });

                // Формируем один промпт для всех задач
                const taskExamples = tasksNeedingReport.map(t =>
                    `RALPH_RESULT\nTASK: ${t.id}\nBRIEF: что сделано с точки зрения пользователя (1 предложение без имён файлов)\nSUMMARY: техническое описание (какие файлы создал/изменил)\nSTATUS: DONE\nRALPH_END`
                ).join('\n\n');

                const batchPrompt = `Ты выполнил спринт ${sprintNum}. Выведи отчёт по КАЖДОЙ задаче. Выведи ВСЕ отчёты подряд без markdown-блоков:\n\n${taskExamples}`;

                sendCommand(ptyProcess, batchPrompt);
                logicalBuffer = '';
                jsonlBuffer = '';

                // Ждём пока в буфере появится нужное количество RALPH_RESULT блоков
                const expectedCount = tasksNeedingReport.length;
                const extractBatchResults = () => {
                    const results = extractAllResults(jsonlBuffer);
                    if (results.length >= expectedCount) return results;
                    return null; // ещё не все
                };

                let batchResults = await waitForModel(extractBatchResults, 300);

                // FORMAT_ERROR или таймаут — проверяем, может часть отчётов уже есть
                if (batchResults === 'FORMAT_ERROR' || batchResults === null) {
                    const partial = extractAllResults(jsonlBuffer);
                    if (partial.length > 0) {
                        chatLog(`⚠️ Batch-таймаут, но ${partial.length} отчётов уже получено`, 'OVERSEER');
                        batchResults = partial;
                    }
                }

                if (batchResults && Array.isArray(batchResults)) {
                    // Сохраняем каждый результат
                    if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, "# История проекта\n\n", 'utf8');
                    // Whitelist task_id'ов которые мы запрашивали — защита от
                    // RALPH_RESULT с task_id из чужого спринта/задачи.
                    // См. инцидент 2026-05-02 (Sprint 39 loop): Claude в fallback-сессии
                    // ответил task_id=39.6 на запрос за 39.7 → файл 39_7.json сохранил
                    // под task_id 39.6 → markCollected(39.6) → 39.7 осталась [ ] → loop.
                    const requestedTaskIds = new Set(tasksNeedingReport.map(t => t.id));
                    for (const r of batchResults) {
                        if (r.status !== 'DONE') continue;
                        const taskId = r.task_id;
                        if (!requestedTaskIds.has(taskId)) {
                            chatLog(`⚠️ Игнорирую RALPH_RESULT с task_id=${taskId} — не входит в запрос (${tasksNeedingReport.map(t => t.id).slice(0, 5).join(', ')}...). Возможно Claude перепутал задачу.`, 'OVERSEER');
                            continue;
                        }
                        const safeId = taskId.replace(/\./g, '_');
                        fs.writeFileSync(path.join(resultsDir, `${safeId}.json`), JSON.stringify({
                            status: 'READY',
                            task_id: taskId,
                            brief: r.brief || '',
                            summary: r.summary || 'Задача выполнена.'
                        }, null, 2), 'utf8');

                        // Только теперь — ставим [x] в tasks.md/spec.md (через canonical task_state).
                        try { markTaskCollected(taskId, sessionId); } catch (e) { console.error('[error] mark_collected:', e.message); }

                        let briefLine = r.brief || r.summary?.split(/\.\s/)[0] || `Task ${taskId}`;
                        if (briefLine.length > 150) briefLine = briefLine.slice(0, 147) + '...';
                        fs.appendFileSync(historyFile, `### [${new Date().toLocaleString()}] Задача ${taskId}\n${briefLine}\n\n<details><summary>Подробности</summary>\n\n${r.summary}\n\n</details>\n\n---\n\n`, 'utf8');
                        chatLog(`✅ ${taskId}: ${(r.brief || '').slice(0, 80)}`, 'OVERSEER');
                    }
                    chatLog(`📝 Получено ${batchResults.length}/${expectedCount} отчётов`, 'OVERSEER');

                    // Fallback: если не все задачи вернулись — дособираем по одной
                    const collectedIds = new Set(batchResults.map(r => r.task_id));
                    const missingTasks = tasksNeedingReport.filter(t => !collectedIds.has(t.id));
                    for (const t of missingTasks) {
                        if (stopRequested) break;
                        resetJsonlBuffer();
                        chatLog(`📝 [${t.id}] Дособираю отчёт (не вошёл в batch)...`, 'OVERSEER');
                        sendCommand(ptyProcess, `Ты выполнил задачу ${t.id} в рамках спринта ${sprintNum}. Напиши краткий отчёт:\n\nRALPH_RESULT\nTASK: ${t.id}\nBRIEF: что сделано\nSUMMARY: техническое описание\nSTATUS: DONE\nRALPH_END`);
                        const fallbackResult = await waitForModel(extractResult, 120);
                        // КРИТИЧНО: проверяем что Claude отчитался именно за t.id
                        // (а не за другую задачу, которую он "вспомнил"). Без этой проверки
                        // получался файл results/<t.id>.json с содержимым task_id != t.id.
                        if (fallbackResult && fallbackResult.status === 'DONE' && fallbackResult.task_id !== t.id) {
                            chatLog(`⚠️ Fallback ${t.id}: Claude отчитался task_id=${fallbackResult.task_id} вместо ${t.id} — игнорирую, оставляю задачу [ ]`, 'OVERSEER');
                            continue;
                        }
                        if (fallbackResult && fallbackResult.status === 'DONE') {
                            const safeId = t.id.replace(/\./g, '_');
                            fs.writeFileSync(path.join(resultsDir, `${safeId}.json`), JSON.stringify({
                                status: 'READY',
                                task_id: fallbackResult.task_id || t.id,
                                brief: fallbackResult.brief || '',
                                summary: fallbackResult.summary || 'Задача выполнена.'
                            }, null, 2), 'utf8');
                            try { markTaskCollected(fallbackResult.task_id || t.id, sessionId); } catch (e) { console.error('[error] mark_collected_fallback:', e.message); }
                            let briefLine = fallbackResult.brief || `Task ${t.id}`;
                            if (briefLine.length > 150) briefLine = briefLine.slice(0, 147) + '...';
                            fs.appendFileSync(historyFile, `### [${new Date().toLocaleString()}] Задача ${t.id}\n${briefLine}\n\n<details><summary>Подробности</summary>\n\n${fallbackResult.summary}\n\n</details>\n\n---\n\n`, 'utf8');
                            chatLog(`✅ ${t.id}: ${(fallbackResult.brief || '').slice(0, 80)}`, 'OVERSEER');
                        } else {
                            chatLog(`⚠️ ${t.id}: не удалось получить отчёт`, 'OVERSEER');
                        }
                    }
                } else {
                    chatLog(`⚠️ Batch-сбор отчётов не удался. НЕ закрываю спринт — оставляю для resume.`, 'OVERSEER');
                }
            } else {
                chatLog(`✅ Все отчёты спринта ${sprintNum} уже собраны`, 'OVERSEER');
            }

            // ─── ПРОВЕРКА: все ли отчёты собраны? ───
            // Если есть задачи без results/<id>.json — спринт не закрываем, не коммитим, не рестартуем.
            // Continue → mainLoop вернётся, findNextSprint опять найдёт этот же спринт (т.к.
            // markTaskCollected не вызван для задач без отчёта → они остались [ ]) → resume сессии.
            const finalUncollected = getSprintTasks(sprintNum).filter(t => {
                const safeId = t.id.replace(/\./g, '_');
                return !fs.existsSync(path.join(resultsDir, `${safeId}.json`));
            });
            if (finalUncollected.length > 0) {
                chatLog(`⏸️ Спринт ${sprintNum}: ${finalUncollected.length} задач без отчётов (${finalUncollected.map(t => t.id).join(', ')}). Не закрываю — следующий цикл попробует resume.`, 'OVERSEER');
                // Не делаем commit, не вызываем clearSprintSession — sprint_sessions.json
                // сохранит привязку, и следующий проход mainLoop сделает resume для дозбора отчётов.
                continue;
            }

            // ─── КОММИТ ───
            chatLog(`📦 Спринт ${sprintNum} закрыт. Коммитим...`, 'OVERSEER');
            updateStatus({ phase: 'committing' });
            try {
                const { execSync } = require('child_process');
                execSync('git add -A', { cwd: projectDir, timeout: 60000 });
                // Проверяем есть ли что коммитить — иначе git commit вернёт error
                // "nothing to commit, working tree clean" и старая логика трактовала это
                // как сбой → restart Claude → loop. См. инцидент 2026-05-02 sprint 39:
                // 12 рестартов на одной задаче 39.7 потому что Claude в новой сессии
                // ничего не менял, commit падал, restart, повтор.
                const stagedDiff = execSync('git diff --cached --stat', { cwd: projectDir, timeout: 30000, encoding: 'utf8' }).trim();
                if (!stagedDiff) {
                    chatLog(`ℹ️ Нечего коммитить (working tree clean) — спринт ${sprintNum} уже в репо. Закрываю без commit.`, 'OVERSEER');
                } else {
                    execSync(`git commit -m "Sprint ${sprintNum}: ${sprintTitle}" --no-verify`, { cwd: projectDir, timeout: 60000 });
                    chatLog(`💾 Коммит спринта ${sprintNum} создан.`, 'OVERSEER');
                }
            } catch (commitErr) {
                chatLog(`⚠️ Не удалось закоммитить: ${commitErr.message?.slice(0, 100)}`, 'OVERSEER');
            }

            // ─── CLEANUP ───
            try { fs.unlinkSync(path.join(projectDir, 'current_sprint.md')); } catch {}
            clearSprintSession(sprintNum); // Очищаем привязку сессии — спринт закрыт

            // ─── ПЕРЕЗАПУСК ДЛЯ СЛЕДУЮЩЕГО СПРИНТА ───
            chatLog(`🧠 Спринт ${sprintNum} полностью закрыт. Перезапуск для сброса контекста...`, 'OVERSEER');
            const restarted = await restartAgent(`сброс контекста после спринта ${sprintNum}`);
            if (!restarted) {
                chatLog(`❌ Не удалось перезапустить. Остановка.`, 'OVERSEER');
                break;
            }
            chatLog(`✅ Claude Code перезапущен. Продолжаю со свежим контекстом.`, 'OVERSEER');
        }
    }
    mainLoop().then(async () => {
        if (fs.existsSync(stopFile)) {
            await gracefulStop();
        } else {
            killAgent();
            clearStatus();
        }
        process.exit(0);
    }).catch((err) => {
        try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [MAINLOOP] catch: ${err.stack || err}\n`, 'utf8'); } catch(e) { console.error('[error] mainloop_crash_log:', e.message); }
        killAgent();
        clearStatus();
        process.exit(1);
    });
} catch (err) {
    fs.appendFileSync(crashLog, `FATAL: ${err.stack}\n`);
}
