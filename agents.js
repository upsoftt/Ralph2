/**
 * Профили CLI-агентов для Ralph 4.0 Overseer
 *
 * Переключение агента: process.argv[3] или RALPH_AGENT env
 * Дефолт: claude
 */

// Резолвим полный путь к claude.exe (node-pty требует абсолютный путь)
function findClaude() {
    if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
    const { execSync } = require('child_process');
    try {
        const p = execSync('where claude', { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0].trim();
        if (p) return p;
    } catch (e) {}
    // Fallback: стандартный путь Windows
    const home = process.env.USERPROFILE || process.env.HOME;
    const fallback = require('path').join(home, '.local', 'bin', 'claude.exe');
    if (require('fs').existsSync(fallback)) return fallback;
    return 'claude'; // Последняя надежда
}

const AGENTS = {
    claude: {
        name: 'Claude Code',
        command: findClaude(),
        args: ['--dangerously-skip-permissions', '--model', process.env.RALPH_MODEL || 'sonnet'],
        pty: { cols: 140, rows: 100, useConpty: true },
        env: { FORCE_COLOR: '1', CLAUDE_CODE_GIT_BASH_PATH: 'D:\\Program Files\\Git\\bin\\bash.exe' },
        // Шаги автоматической загрузки (выполняются последовательно при boot)
        bootSequence: [
            { wait: 'yes, i accept', send: '\x1b[B\r', delay: 500, desc: 'Accept bypass permissions' },
            { wait: 'yes, i trust this folder', send: '\r', delay: 500, desc: 'Trust project folder' },
        ],
        patterns: {
            // Индикаторы активной работы модели (lowercase)
            thinking: ['esc to interrupt'],
            // Индикаторы готовности к вводу (lowercase)
            ready: ['bypass permissions on'],
            // Строки для игнорирования в логах (lowercase)
            ignore: ['voice mode', 'mcp server'],
            // Regex: Braille-спиннеры (U+2800-28FF) + Dingbats ✶✻✷✸ (U+2700-27BF) — Claude Code статус-символы
            thinkingRegex: /[\u2800-\u28FF\u2700-\u27BF]/,
            // Regex для успешного выполнения инструмента
            toolSuccess: /^(✓|success:)/i,
        },
        rulesFile: 'CLAUDE.md',
    },

    gemini: {
        bootSequence: [],
        name: 'Gemini CLI',
        command: 'node',
        args: ['C:\\Users\\upsof\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js', '-y'],
        pty: { cols: 140, rows: 100, useConpty: true },
        env: { FORCE_COLOR: '1' },
        patterns: {
            thinking: ['esc to cancel', 'responding'],
            ready: ['type your message', 'yolo mode'],
            ignore: ['waiting for auth'],
            thinkingRegex: /[\u2800-\u28FF]/,
            toolSuccess: /^success:/i,
        },
        rulesFile: 'GEMINI.md',
    },
};

const DEFAULT_AGENT = 'claude';

function getAgent(name) {
    const key = (name || '').toLowerCase();
    if (AGENTS[key]) return { key, ...AGENTS[key] };
    return { key: DEFAULT_AGENT, ...AGENTS[DEFAULT_AGENT] };
}

module.exports = { AGENTS, DEFAULT_AGENT, getAgent };
