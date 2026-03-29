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
    } catch (e) {}
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
                try { fs.unlinkSync(path.join(logsBackupDir, backups.shift())); } catch (e) {}
            }
        }
    }
} catch (e) {}

fs.writeFileSync(liveConsoleLog, '', 'utf8');
fs.writeFileSync(thinkingStatusFile, '', 'utf8');

// --- STATUS TRACKING ---
function writeStatus(running, extra = {}) {
    try {
        fs.writeFileSync(statusFile, JSON.stringify({
            running,
            pid: process.pid,
            version: 'v4',
            agent: agentName,
            started: new Date().toISOString(),
            heartbeat: new Date().toISOString(),
            ...extra
        }, null, 2), 'utf8');
    } catch (e) {}
}

// Уровень 3: Heartbeat — обновляем timestamp каждые 5 секунд
setInterval(() => {
    try {
        if (fs.existsSync(statusFile)) {
            const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            if (data.running) {
                data.heartbeat = new Date().toISOString();
                fs.writeFileSync(statusFile, JSON.stringify(data, null, 2), 'utf8');
            }
        }
    } catch (e) {}
}, 5000);

function clearStatus() {
    try {
        fs.writeFileSync(statusFile, JSON.stringify({ running: false, version: 'v4' }), 'utf8');
    } catch (e) {}
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
            } catch (e) {} // Если tasklist не сработал — считаем что процесс мёртв
        }
    } catch (e) {}
}

// Очищаем .ralph-stop если остался от прошлого раза
if (fs.existsSync(stopFile)) { try { fs.unlinkSync(stopFile); } catch (e) {} }

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
let jsonlPath = path.join(claudeProjectsDir, projectSlug(projectDir), `${sessionId}.jsonl`);
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
                    sendCommand(ptyProcess, 'НЕ ЗАДАВАЙ ВОПРОСОВ. Ты работаешь автономно. Выбери наиболее практичный вариант сам и действуй. Если инструмент не работает — используй альтернативу (Bash вместо Write). Продолжай выполнение задачи.');
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
    } catch (e) {}

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
    // КРИТИЧНО: PTY интерпретирует \n как Enter → заменяем на пробелы
    ptyProc.write(cleanCmd.replace(/\n/g, ' ') + '\r');
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
        if (ptyProcess) {
            const pid = ptyProcess.pid;
            try { ptyProcess.kill(); } catch (e) {}
            // Убиваем дерево дочерних процессов (MCP серверы, npx и т.д.)
            if (pid) {
                try {
                    require('child_process').execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', timeout: 5000 });
                } catch (e) {} // Процесс мог уже завершиться
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
                await delay(1000);
                // Отправляем /exit чтобы Claude Code завершился корректно
                ptyProcess.write('/exit\r');

                // Даём Claude Code до 10 секунд на завершение
                for (let i = 0; i < 10; i++) {
                    await delay(1000);
                    if (!ptyProcess) break; // Уже завершился через onExit
                }
            } catch (e) {}

            // Если ещё жив — принудительно убиваем
            killAgent();
        }

        // Убираем файл .ralph-stop
        if (fs.existsSync(stopFile)) {
            try { fs.unlinkSync(stopFile); } catch (e) {}
        }

        clearStatus();
        chatLog('✅ Ralph 2.0 остановлен.', 'OVERSEER');
    }

    /**
     * Спавнит новый PTY процесс агента
     */
    function spawnAgent() {
        // Новый session ID для каждого запуска
        sessionId = crypto.randomUUID();
        jsonlPath = path.join(claudeProjectsDir, projectSlug(projectDir), `${sessionId}.jsonl`);
        jsonlReadPos = 0;

        const ptyArgs = [...agent.args, '--session-id', sessionId];
        chatLog(`📋 Session ID: ${sessionId}`, 'OVERSEER');
        chatLog(`📂 JSONL: ${jsonlPath}`, 'OVERSEER');

        // Сброс состояния
        logicalBuffer = '';
        bootStepsDone = new Set();
        lastThinkingTime = 0;
        currentState = 'BOOT';
        stopRequested = false;
        resetJsonlBuffer();

        ptyProcess = pty.spawn(agent.command, ptyArgs, {
            name: 'xterm-color',
            ...agent.pty,
            cwd: projectDir,
            env: { ...process.env, RALPH_NODE_HEAP: '8192', ...agent.env },
        });

        // ─── LIVE PAUSE: замораживает Claude Code mid-task через PTY pause ───
        let livePaused = false;
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

        // Очистка интервала при завершении
        ptyProcess.onExit(() => { clearInterval(livePauseInterval); });

        // Диагностика: логируем ВЕСЬ сырой PTY вывод в crash.log первые 30 секунд
        const spawnTime = Date.now();
        ptyProcess.onData((data) => {
            if (Date.now() - spawnTime < 30000) {
                try { fs.appendFileSync(crashLog, `[PTY-RAW ${Date.now() - spawnTime}ms] ${data.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '.')}\n`, 'utf8'); } catch(e) {}
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
                            ptyProcess.write(step.send);
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
                try { fs.writeFileSync(thinkingStatusFile, '', 'utf8'); } catch (e) {}
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

        ptyProcess.onExit(({ exitCode, signal }) => {
            const msg = `⚠️ ${agent.name} PTY завершился (code=${exitCode}, signal=${signal})`;
            chatLog(msg, 'OVERSEER');
            try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [EXIT] ${msg}\n`, 'utf8'); } catch(e) {}
            // Убиваем дочерние процессы (MCP серверы), которые остались после крэша
            const pid = ptyProcess ? ptyProcess.pid : null;
            if (pid) {
                try { require('child_process').execSync(`taskkill /f /t /pid ${pid}`, { stdio: 'ignore', timeout: 5000 }); } catch (e) {}
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
    async function bootAndInit() {
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
            sendCommand(ptyProcess, "Ты закончил? Выведи одно слово: RALPH_READY");
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
    async function restartAgent(reason) {
        chatLog(`🔄 Перезапуск ${agent.name}: ${reason}`, 'OVERSEER');
        killAgent();
        await delay(3000);
        spawnAgent();
        return await bootAndInit();
    }

    async function waitForModel(conditionFn, timeoutSec = 1800) {
        const start = Date.now();
        await delay(2000);

        const FORMAT_ERROR_SILENCE_SEC = 300;
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
            } catch (e) {}
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
        if (source.includes('RALPH_AUDIT_OK')) return 'OK';
        if (source.includes('RALPH_AUDIT_FIX')) return 'FIX';
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
        } catch (e) {}

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

ПОСЛЕ завершения аудита — выведи РОВНО ОДНО из двух:
- RALPH_AUDIT_OK — если аудитор не нашёл проблем
- RALPH_AUDIT_FIX — если аудитор нашёл и добавил задачи-доработки в спринт ${sprintNum}`;

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

    const MAX_RESTARTS = 5;
    let totalRestarts = 0;

    async function mainLoop() {
        // Первый запуск
        spawnAgent();
        const bootOk = await bootAndInit();
        if (!bootOk) return;

        while (!stopRequested) {
            if (fs.existsSync(stopFile)) break;

            // ─── ПАУЗА: ждём удаления .ralph-pause ───
            while (fs.existsSync(pauseFile) && !stopRequested) {
                chatLog('⏸️ Пауза...', 'OVERSEER');
                writeStatus(true, { paused: true });
                await delay(5000);
                if (fs.existsSync(stopFile)) { stopRequested = true; break; }
            }
            if (stopRequested) break;
            writeStatus(true, { paused: false });

            const task = findNextTask();
            if (!task) {
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
                            } catch (e) {}
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

            chatLog(`🚀 Задача ${task.id}: ${task.text.split('\n')[0]}`, 'OVERSEER');
            const testHint = detectedTestCommands.length > 0
                ? ` ТЕСТИРОВАНИЕ: В проекте обнаружены тестовые команды: ${detectedTestCommands.map(c => `${c.cmd} (${c.desc})`).join('; ')}. После реализации запусти релевантные тесты для проверки.`
                : '';
            // Относительный путь spec-файла для контекста
            const specRelPath = path.relative(projectDir, task.file).replace(/\\/g, '/');
            // Проверяем наличие референсных изображений
            const specDirPath = path.dirname(task.file);
            const refsPath = path.join(specDirPath, 'refs');
            let refsHint = '';
            try {
                if (fs.existsSync(refsPath)) {
                    const refFiles = fs.readdirSync(refsPath).filter(f => /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f));
                    if (refFiles.length > 0) {
                        const refsRelPath = path.relative(projectDir, refsPath).replace(/\\/g, '/');
                        refsHint = `\nРЕФЕРЕНСЫ: В папке ${refsRelPath}/ есть визуальные референсы: ${refFiles.join(', ')}. Прочитай их через Read tool для понимания визуального контекста задачи.`;
                    }
                }
            } catch (e) {}
            const prompt = `ВЫПОЛНИ ЗАДАЧУ ${task.id}: ${task.text}\n\nКОНТЕКСТ: Спецификация задачи в файле ${specRelPath}. Прочитай его для полного описания.${refsHint}\n\nПРАВИЛА:\n1) Работай автономно, не задавай вопросов.\n2) Для записи файлов вне проекта используй путь D:/MyProjects/skills/.\n3) Если Write не работает — используй Bash.\n4) Используй доступные скиллы (Skill tool) если они подходят для задачи — профильные агенты, TDD, debugging, brainstorming и другие.${testHint}\n\nВАЖНО: Сначала ВЫПОЛНИ задачу (напиши код, создай файлы, запусти тесты). Только ПОСЛЕ завершения работы выведи отчёт.\nЕсли ты выведешь отчёт без реальной работы — задача будет назначена повторно.\n\nФормат отчёта:\nRALPH_RESULT\nTASK: ${task.id}\nBRIEF: <1 предложение простым языком: что сделано с точки зрения пользователя, БЕЗ имён файлов/классов/функций>\nSUMMARY: <техническое описание: какие файлы создал/изменил, что конкретно сделал>\nSTATUS: DONE\nRALPH_END`;

            sendCommand(ptyProcess, prompt);
            // Очищаем буферы чтобы шаблон RALPH_RESULT из промпта не попал в парсер
            logicalBuffer = '';
            jsonlBuffer = '';

            let result = await waitForModel(extractResult, 1800);

            // Если модель закончила работу, но не вывела отчёт — напомнить (до 3 попыток)
            let retries = 0;
            while (result === "FORMAT_ERROR" && retries < 3 && !stopRequested) {
                retries++;
                const secSinceThinking = (Date.now() - lastThinkingTime) / 1000;
                if (secSinceThinking < 120) {
                    chatLog(`⏳ Задача ${task.id}: Claude ещё активен (${Math.round(secSinceThinking)}s назад). Ждём...`, 'OVERSEER');
                    result = await waitForModel(extractResult, 600);
                    continue;
                }
                chatLog(`⚠️ Задача ${task.id}: модель не вывела отчёт. Напоминание (${retries}/3)...`, 'OVERSEER');
                sendCommand(ptyProcess, `Задача ${task.id} завершена? Выведи отчёт БЕЗ markdown-форматирования. Напиши СВОИМИ СЛОВАМИ что сделал:\n\nRALPH_RESULT\nTASK: ${task.id}\nSUMMARY: опиши что сделал\nSTATUS: DONE\nRALPH_END`);
                result = await waitForModel(extractResult, 300);
            }

            if (result && result.status === "DONE") {
                const safeId = task.id.replace(/\./g, '_');
                fs.writeFileSync(path.join(resultsDir, `${safeId}.json`), JSON.stringify({
                    status: "READY",
                    task_id: result.task_id || task.id,
                    brief: result.brief || '',
                    summary: result.summary || "Задача выполнена."
                }, null, 2), 'utf8');

                // Отмечаем в spec.md
                let specContent = fs.readFileSync(task.file, 'utf8');
                const lines = specContent.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(`{{TASK:${task.id}}}`) && lines[i].includes('[ ]')) {
                        lines[i] = lines[i].replace('[ ]', '[x]'); break;
                    }
                }
                fs.writeFileSync(task.file, lines.join('\n'), 'utf8');
                // Отмечаем в tasks.md
                const tasksFile = path.join(projectDir, 'tasks.md');
                if (fs.existsSync(tasksFile)) {
                    try {
                        const tLines = fs.readFileSync(tasksFile, 'utf8').split('\n');
                        for (let j = 0; j < tLines.length; j++) {
                            if (tLines[j].includes(`{{TASK:${task.id}}}`) && tLines[j].includes('[ ]')) {
                                tLines[j] = tLines[j].replace('[ ]', '[x]'); break;
                            }
                        }
                        fs.writeFileSync(tasksFile, tLines.join('\n'), 'utf8');
                    } catch (e) {}
                }
                if (!fs.existsSync(historyFile)) fs.writeFileSync(historyFile, "# История проекта\n\n", 'utf8');
                const taskTitle = task.text.split('\n')[0].replace(/\{\{TASK:[\d.]+\}\}/g, '').trim();
                // Fallback для brief: первое предложение summary без путей к файлам
                let briefLine = result.brief;
                if (!briefLine && result.summary) {
                    briefLine = result.summary.split(/\.\s/)[0].replace(/`[^`]+`/g, '').replace(/\s{2,}/g, ' ').trim();
                    if (briefLine.length > 150) briefLine = briefLine.slice(0, 147) + '...';
                }
                if (!briefLine) briefLine = taskTitle;
                fs.appendFileSync(historyFile, `### [${new Date().toLocaleString()}] Задача ${task.id}: ${taskTitle}\n${briefLine}\n\n<details><summary>Подробности</summary>\n\n${result.summary}\n\n</details>\n\n---\n\n`, 'utf8');
                chatLog(`✅ ${task.id}: ${briefLine}`, 'OVERSEER');

                // ─── АУДИТ СПРИНТА: проверяем границу ───
                const currentSprint = getSprintNumber(task.id);
                if (isSprintComplete(currentSprint)) {
                    // Считаем попытки аудита этого спринта
                    const attempts = sprintAuditAttempts[currentSprint] || 0;
                    if (attempts < MAX_AUDIT_ATTEMPTS) {
                        sprintAuditAttempts[currentSprint] = attempts + 1;
                        chatLog(`📋 Спринт ${currentSprint} завершён. Аудит (попытка ${attempts + 1}/${MAX_AUDIT_ATTEMPTS})...`, 'OVERSEER');
                        const auditResult = await auditSprint(currentSprint, attempts + 1);
                        if (auditResult === 'FIX') {
                            chatLog(`🔄 Аудитор добавил доработки в спринт ${currentSprint}. Выполняю, затем повторный аудит...`, 'OVERSEER');
                            // НЕ увеличиваем lastCompletedSprint — после выполнения доработок
                            // isSprintComplete снова сработает и запустит повторный аудит
                        } else {
                            // OK или таймаут — спринт закрыт, коммитим
                            chatLog(`📦 Спринт ${currentSprint} закрыт. Коммитим...`, 'OVERSEER');
                            try {
                                const { execSync } = require('child_process');
                                execSync('git add -A', { cwd: projectDir, timeout: 60000 });
                                execSync(`git commit -m "Sprint ${currentSprint}: ${sprintTitle}" --no-verify`, { cwd: projectDir, timeout: 60000 });
                                chatLog(`💾 Коммит спринта ${currentSprint} создан.`, 'OVERSEER');
                            } catch (commitErr) {
                                chatLog(`⚠️ Не удалось закоммитить спринт ${currentSprint}: ${commitErr.message?.slice(0, 100)}`, 'OVERSEER');
                            }
                        }
                    }
                    // Если MAX_AUDIT_ATTEMPTS исчерпан — молча продолжаем
                }

                await delay(3000);
            } else {
                // ─── ПЕРЕЗАПУСК вместо остановки ───
                totalRestarts++;
                if (totalRestarts > MAX_RESTARTS) {
                    chatLog(`❌ Превышен лимит перезапусков (${MAX_RESTARTS}). Остановка.`, 'OVERSEER');
                    break;
                }
                chatLog(`⚠️ Сбой протокола в задаче ${task.id}. Перезапуск ${totalRestarts}/${MAX_RESTARTS}...`, 'OVERSEER');
                const restarted = await restartAgent(`сбой протокола задачи ${task.id}`);
                if (!restarted) {
                    chatLog(`❌ Не удалось перезапустить ${agent.name}. Остановка.`, 'OVERSEER');
                    break;
                }
                // Задача не отмечена как выполненная — findNextTask() вернёт её снова
                chatLog(`🔁 Повторяю задачу ${task.id} после перезапуска.`, 'OVERSEER');
                continue;
            }
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
        try { fs.appendFileSync(crashLog, `[${new Date().toISOString()}] [MAINLOOP] catch: ${err.stack || err}\n`, 'utf8'); } catch(e) {}
        killAgent();
        clearStatus();
        process.exit(1);
    });
} catch (err) {
    fs.appendFileSync(crashLog, `FATAL: ${err.stack}\n`);
}
