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

// Записываем статус: запущен
writeStatus(true);

// Гарантируем очистку статуса при любом выходе + диагностика
process.on('exit', (code) => {
    try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [PROCESS] exit event, code=${code}\n`, 'utf8'); } catch(e) {}
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

    // Фильтр: дедупликация
    const fp = lower.replace(/[^a-zа-я0-9]/g, '');
    if (recentHashes.has(fp)) return;
    recentHashes.add(fp);
    if (recentHashes.size > 100) {
        const first = recentHashes.values().next().value;
        recentHashes.delete(first);
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
    try {
        ptyProc.write('\x1b[200~' + text + '\x1b[201~');
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
    const source = jsonlBuffer || text;
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
    const source = jsonlBuffer || text;

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
    const source = jsonlBuffer || text;
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
                writeStatus(true, { paused: true });
                chatLog('⏸️ Пауза (процесс заморожен)', 'OVERSEER');
            } else if (!shouldPause && livePaused) {
                livePaused = false;
                ptyProcess.resume();
                writeStatus(true, { paused: false });
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
            stopRequested = true;
            stopJsonlWatcher();
        });

        return ptyProcess;
    }

    /**
     * Ожидает загрузку агента и отправляет init-команду
     * Возвращает true если инициализация прошла успешно
     */
    async function bootAndInit(isResume = false) {
        chatLog(`⏳ Ожидание загрузки ${agent.name}...`, 'OVERSEER');
        let initialReady = false;
        for (let i = 0; i < 120; i++) {
            if (stopRequested) { chatLog('❌ PTY процесс завершился во время загрузки.', 'OVERSEER'); return false; }
            const low = logicalBuffer.toLowerCase();
            if (agent.patterns.ready.some(p => low.includes(p))) { initialReady = true; break; }
            await delay(1000);
        }
        if (!initialReady) { chatLog('❌ Агент не загрузился за 120 секунд.', 'OVERSEER'); return false; }

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
            // Nudge: напомнить Claude продолжать работу
            sendNudge(ptyProcess, 'Ты был прерван. Продолжай выполнение текущего спринта. Если уже всё завершил — выведи RALPH_SPRINT_DONE на отдельной строке.');
            return true;
        }

        const initCmd = `ДЕЙСТВУЙ КАК СИСТЕМНЫЙ АГЕНТ. Прочитай файлы PRD.md, ${agent.rulesFile}, planning.md, tasks.md и execution_history.md (если он существует). КРИТИЧЕСКИЕ ПРАВИЛА АВТОНОМНОЙ РАБОТЫ: 1) Ты работаешь ПОЛНОСТЬЮ автономно. НИКОГДА не задавай вопросов, не предлагай варианты на выбор, не жди ответа пользователя. Всегда выбирай решение сам и действуй. 2) Если инструмент не работает (нет прав, ошибка) — используй альтернативу (Bash вместо Write, curl вместо WebFetch и т.д.) без вопросов. 3) Скиллы находятся в D:/MyProjects/skills/ (симлинк из ~/.claude/skills). Для записи скиллов используй путь D:/MyProjects/skills/. 4) Перед тяжёлыми npm/pnpm командами: export NODE_OPTIONS="--max-old-space-size=8192". 5) АБСОЛЮТНО ЗАПРЕЩЕНО: git stash, git checkout --, git restore, git reset. Эти команды УНИЧТОЖАЮТ uncommitted код и tasks.md. Если нужно проверить "было ли сломано до моих изменений" — используй git diff или git log, НЕ откатывай код. Для pnpm install используй --no-frozen-lockfile. 6) После каждого выполненного спринта делай git add и git commit с описанием выполненных задач. 7) При любом препятствии — обходи его сам, не останавливайся. Никаких лишних слов. Когда прочитаешь, выведи одно слово: RALPH_READY`;

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

        chatLog("✅ Контекст проекта загружен.", "OVERSEER");
        await delay(2000);
        logicalBuffer = '';
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
        await delay(2000);

        const FORMAT_ERROR_SILENCE_SEC = 600;
        let lastDataTime = Date.now();
        let lastJsonlLen = 0;

        while (!stopRequested) {
            const now = Date.now();
            if (now - start > timeoutSec * 1000) { chatLog(`⏰ waitForModel: таймаут (${timeoutSec}s)`, 'OVERSEER'); return null; }
            if (fs.existsSync(stopFile)) { chatLog('🛑 waitForModel: обнаружен .ralph-stop', 'OVERSEER'); stopRequested = true; return null; }

            // Отслеживаем активность (JSONL рост + PTY thinking)
            if (jsonlBuffer.length !== lastJsonlLen) {
                lastJsonlLen = jsonlBuffer.length;
                lastDataTime = now;
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
            const match = content.match(new RegExp(`##\\s*(?:Sprint|Спринт)\\s*${sprintNum}[:\\s]+(.+)`, 'i'));
            return match ? match[1].trim() : `Sprint ${sprintNum}`;
        } catch (e) { return `Sprint ${sprintNum}`; }
    }

    function extractAuditResult(text) {
        const source = jsonlBuffer || text;
        // Строгая проверка: маркер на отдельной строке
        if (/^RALPH_AUDIT_OK\s*$/m.test(source)) return 'OK';
        if (/^RALPH_AUDIT_FIX\s*$/m.test(source)) return 'FIX';
        return null;
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
После ПОЛНОГО завершения аудита ты ОБЯЗАН вывести РОВНО ОДНО из двух слов-маркеров:

RALPH_AUDIT_OK

или

RALPH_AUDIT_FIX

Это слово должно быть на ОТДЕЛЬНОЙ строке, без дополнительного текста.
Без этого маркера overseer не сможет определить результат аудита и засчитает таймаут.
Выведи маркер ПОСЛЕДНИМ сообщением, после всех отчётов и логов.`;

        logicalBuffer = '';
        jsonlBuffer = '';
        sendCommand(ptyProcess, auditPrompt);

        const auditResult = await waitForModel(extractAuditResult, 900);

        if (auditResult === 'FIX') {
            chatLog(`🔧 Аудит спринта ${sprintNum}: найдены проблемы, задачи добавлены.`, 'OVERSEER');
            return 'FIX';
        } else if (auditResult === 'OK') {
            chatLog(`✅ Аудит спринта ${sprintNum}: всё в порядке.`, 'OVERSEER');
            return 'OK';
        } else {
            chatLog(`⚠️ Аудит спринта ${sprintNum}: не получен ответ (таймаут). Пропускаем.`, 'OVERSEER');
            return null;
        }
    }

    // Трекинг аудитов: спринт → количество попыток
    const sprintAuditAttempts = {};
    const MAX_AUDIT_ATTEMPTS = 3; // Максимум 3 цикла аудита на спринт

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
     * Создаёт файл current_sprint.md с задачами текущего спринта.
     */
    function createCurrentSprintFile(sprintNum) {
        const title = getSprintTitle(sprintNum);
        const tasksFile = path.join(projectDir, 'tasks.md');

        let sprintSection = '';
        if (fs.existsSync(tasksFile)) {
            const content = fs.readFileSync(tasksFile, 'utf8');
            const sprintRegex = new RegExp(
                `(##\\s*(?:Sprint|Спринт)\\s*${sprintNum}[:\\s][\\s\\S]*?)(?=\\n##\\s*(?:Sprint|Спринт)|$)`,
                'i'
            );
            const match = content.match(sprintRegex);
            if (match) sprintSection = match[1].trim();
        }

        // Find spec file
        const sprintPrefix = sprintNum.toString().padStart(3, '0');
        let specPath = '';
        try {
            const dirs = fs.readdirSync(specsDir).filter(d => d.startsWith(sprintPrefix + '-'));
            if (dirs.length > 0) {
                const sf = path.join(specsDir, dirs[0], 'spec.md');
                if (fs.existsSync(sf)) specPath = `specs/${dirs[0]}/spec.md`;
            }
        } catch (e) {}

        let fileContent = `# Спринт ${sprintNum}: ${title}\n\n`;
        if (sprintSection) {
            fileContent += `${sprintSection}\n\n`;
        }
        if (specPath) {
            fileContent += `## Спецификация\n\nПодробное описание задач: ${specPath}\n`;
        }

        const filePath = path.join(projectDir, 'current_sprint.md');
        fs.writeFileSync(filePath, fileContent, 'utf8');
        return filePath;
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
        const source = jsonlBuffer || text;
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
                // Проверяем что JSONL существует
                const testJsonl = path.join(claudeProjectsDir, projectSlug(workspaceDir), `${resumeSid}.jsonl`);
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
                writeStatus(true, { paused: true });
                await delay(2000);
                if (fs.existsSync(stopFile)) { stopRequested = true; break; }
            }
            if (stopRequested) break;
            writeStatus(true, { paused: false });

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
            writeStatus(true, { sprint: sprintNum, sprintTitle, tasksTotal: sprintTasks.length, tasksDone: sprintTasks.length - undoneTasks.length });

            // ─── СОЗДАЁМ current_sprint.md ───
            createCurrentSprintFile(sprintNum);
            chatLog(`📋 Создан current_sprint.md с ${undoneTasks.length} задачами`, 'OVERSEER');

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

Прочитай файл current_sprint.md в корне проекта — там описаны все задачи этого спринта.
Также прочитай соответствующий spec-файл из папки specs/ для подробных описаний.${refsHint}

ПРАВИЛА:
1) Работай автономно, не задавай вопросов.
2) Выполни ВСЕ невыполненные задачи из спринта ${sprintNum} последовательно.
3) НЕ нужно выводить отчёт после каждой задачи — просто выполняй одну за другой.
4) НЕ переходи к задачам из других спринтов.
5) Для записи файлов вне проекта используй путь ~/.claude/skills/.
6) Если Write не работает — используй Bash.
7) Используй доступные скиллы (Skill tool) если они подходят для задачи.${testHint}

ВАЖНО: Сначала ВЫПОЛНИ все задачи (напиши код, создай файлы, запусти тесты).
Только ПОСЛЕ завершения ВСЕХ задач спринта выведи маркер на ОТДЕЛЬНОЙ строке:

RALPH_SPRINT_DONE`;

            sendCommand(ptyProcess, sprintPrompt);
            logicalBuffer = '';
            jsonlBuffer = '';

            // ─── ОЖИДАНИЕ ЗАВЕРШЕНИЯ СПРИНТА ───
            let sprintResult = await waitForModel(extractSprintDone, 3600); // 1 час

            // Retry если нет маркера
            let retries = 0;
            while (!sprintResult && retries < 3 && !stopRequested) {
                retries++;
                const secSinceThinking = (Date.now() - lastThinkingTime) / 1000;
                if (secSinceThinking < 120) {
                    chatLog(`⏳ Спринт ${sprintNum}: Claude ещё активен. Ждём...`, 'OVERSEER');
                    sprintResult = await waitForModel(extractSprintDone, 600);
                    continue;
                }
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

            // ─── СПРИНТ ЗАВЕРШЁН ───
            chatLog(`✅ Спринт ${sprintNum}: все задачи выполнены!`, 'OVERSEER');

            // Отмечаем все невыполненные задачи как [x]
            for (const t of undoneTasks) {
                markTaskDone(t);
            }
            chatLog(`✅ Отмечено ${undoneTasks.length} задач как выполненные`, 'OVERSEER');

            // ─── АУДИТ ───
            const attempts = sprintAuditAttempts[sprintNum] || 0;
            if (attempts < MAX_AUDIT_ATTEMPTS) {
                sprintAuditAttempts[sprintNum] = attempts + 1;
                chatLog(`📋 Аудит спринта ${sprintNum} (попытка ${attempts + 1}/${MAX_AUDIT_ATTEMPTS})...`, 'OVERSEER');
                const auditResult = await auditSprint(sprintNum, attempts + 1);
                if (auditResult === 'FIX') {
                    // Проверяем что аудитор действительно добавил задачи
                    const postAuditSprint = findNextSprint();
                    if (postAuditSprint && postAuditSprint.sprintNum === sprintNum && postAuditSprint.undoneTasks.length > 0) {
                        chatLog(`🔄 Аудитор добавил ${postAuditSprint.undoneTasks.length} доработок в спринт ${sprintNum}. Продолжаю выполнение...`, 'OVERSEER');
                    } else {
                        chatLog(`⚠️ Аудитор сказал FIX, но невыполненных задач в спринте ${sprintNum} не найдено (возможно spec не создан). Продолжаю...`, 'OVERSEER');
                    }
                    continue; // Вернёмся — findNextSprint найдёт новые невыполненные задачи (или следующий спринт)
                }
            }

            // ─── BATCH-СБОР ОТЧЁТОВ (один промпт на все задачи) ───
            const allTasks = getSprintTasks(sprintNum);
            // Фильтруем задачи, для которых уже есть результат
            const tasksNeedingReport = allTasks.filter(t => {
                const safeId = t.id.replace(/\./g, '_');
                return !fs.existsSync(path.join(resultsDir, `${safeId}.json`));
            });

            if (tasksNeedingReport.length > 0) {
                chatLog(`📝 Сбор отчётов: ${tasksNeedingReport.length} задач спринта ${sprintNum} (batch)...`, 'OVERSEER');

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
                    for (const r of batchResults) {
                        if (r.status !== 'DONE') continue;
                        const taskId = r.task_id;
                        const safeId = taskId.replace(/\./g, '_');
                        fs.writeFileSync(path.join(resultsDir, `${safeId}.json`), JSON.stringify({
                            status: 'READY',
                            task_id: taskId,
                            brief: r.brief || '',
                            summary: r.summary || 'Задача выполнена.'
                        }, null, 2), 'utf8');

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
                        if (fallbackResult && fallbackResult.status === 'DONE') {
                            const safeId = t.id.replace(/\./g, '_');
                            fs.writeFileSync(path.join(resultsDir, `${safeId}.json`), JSON.stringify({
                                status: 'READY',
                                task_id: fallbackResult.task_id || t.id,
                                brief: fallbackResult.brief || '',
                                summary: fallbackResult.summary || 'Задача выполнена.'
                            }, null, 2), 'utf8');
                            let briefLine = fallbackResult.brief || `Task ${t.id}`;
                            if (briefLine.length > 150) briefLine = briefLine.slice(0, 147) + '...';
                            fs.appendFileSync(historyFile, `### [${new Date().toLocaleString()}] Задача ${t.id}\n${briefLine}\n\n<details><summary>Подробности</summary>\n\n${fallbackResult.summary}\n\n</details>\n\n---\n\n`, 'utf8');
                            chatLog(`✅ ${t.id}: ${(fallbackResult.brief || '').slice(0, 80)}`, 'OVERSEER');
                        } else {
                            chatLog(`⚠️ ${t.id}: не удалось получить отчёт`, 'OVERSEER');
                        }
                    }
                } else {
                    chatLog(`⚠️ Batch-сбор отчётов не удался. Пропускаю.`, 'OVERSEER');
                }
            } else {
                chatLog(`✅ Все отчёты спринта ${sprintNum} уже собраны`, 'OVERSEER');
            }

            // ─── КОММИТ ───
            chatLog(`📦 Спринт ${sprintNum} закрыт. Коммитим...`, 'OVERSEER');
            try {
                const { execSync } = require('child_process');
                execSync('git add -A', { cwd: projectDir, timeout: 60000 });
                execSync(`git commit -m "Sprint ${sprintNum}: ${sprintTitle}" --no-verify`, { cwd: projectDir, timeout: 60000 });
                chatLog(`💾 Коммит спринта ${sprintNum} создан.`, 'OVERSEER');
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
