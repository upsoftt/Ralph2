/**
 * index-generator.js — регенерирует execution_index.md из execution_history.md.
 *
 * Цель: дать агенту дешёвый обзор всех завершённых задач (~5–30KB),
 * чтобы он не читал лог целиком (~250KB+) при поиске прошлых реализаций.
 *
 * Формат записи в логе:
 *   ### [DATE] Задача N.M       (или N.M.K — sub-sub)
 *   <brief — 1+ строк до <details>>
 *   <details><summary>Подробности</summary>
 *   <технические детали>
 *   </details>
 *   ---
 *
 * Формат индекса:
 *   ## Спринт N: <title из tasks.md>
 *   - N.M [L:<line>] — <brief> [files: a.go, b.sql] [keys: FuncOne, FuncTwo]
 *
 * Использование:
 *   const { regenerateIndex } = require('./index-generator');
 *   regenerateIndex('/path/to/project');
 *
 * Из CLI:
 *   node index-generator.js <project-dir>
 */

'use strict';

const fs = require('fs');
const path = require('path');

// FILE_EXT_RE: имя файла должно быть отделено слева пробелом, кавычкой, скобкой,
// слэшем, бэктиком, началом строки или знаками препинания. Это исключает захват
// "v2.0", "18.20", "1.22" из прозы и `info.go` без префикса каталога.
const FILE_EXT_RE = /(?<=^|[\s"'`(\[<{,;])([\w./-]*[a-zA-Z][\w./-]*\.(?:go|sql|md|json|ya?ml|js|ts|tsx|jsx|html|tmpl|templ|css|scss|sh|ps1|py|toml|mod|sum|conf|gradle|swift|kt|rs|cpp|hpp|cs|fs|vue|svelte|astro|rb|php|java|dart|lua|tf|hcl|proto|graphql|prisma|Dockerfile|Makefile))(?=$|[\s"'`)\]>},;:.!?])/g;

// KEY_RE: PascalCase/camelCase (латиница И кириллица) + snake_case ≥ 6 символов.
// Захватывает идентификаторы и БД-имена.
const KEY_RE = /[A-ZА-Я][a-zа-я]+(?:[A-ZА-Я][a-zа-я]*)+|[a-zа-я]+_[a-zа-я_]{4,}/gu;

const KEY_STOPWORDS = new Set([
    'JSON', 'HTTP', 'HTTPS', 'HTML', 'CSS', 'SQL', 'API', 'URL', 'URI', 'UUID',
    'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'TODO', 'FIXME', 'NOTE',
    'TestCase', 'TestSuite', 'TestRun', 'TestRunner', 'TestHelper', 'TestServer',
    'Создан', 'Создана', 'Создано', 'Добавлен', 'Добавлена', 'Добавлено',
    'Реализован', 'Реализована', 'Реализовано',
    // частые имена файлов как "слова" — будут отфильтрованы как basenames в extractKeys
]);

// Распознаёт `### [DATE] Задача N.M` или `### [DATE] Задача N.M.K` (sub-sub).
const TASK_BLOCK_RE = /^###\s*\[[^\]]+\]\s*Задача\s+(\d+)\.(\d+)(?:\.(\d+))?\s*$/;

function parseTasksMd(tasksFile) {
    const sprints = new Map();
    if (!fs.existsSync(tasksFile)) return sprints;
    const content = fs.readFileSync(tasksFile, 'utf8');
    const re = /^##\s*(?:Sprint|Спринт)\s+(\d+)[:\s]+([^\n]+)/gmi;
    let m;
    while ((m = re.exec(content)) !== null) {
        sprints.set(m[1], m[2].trim());
    }
    return sprints;
}

function extractFiles(detailsText) {
    const found = new Set();
    let m;
    FILE_EXT_RE.lastIndex = 0;
    while ((m = FILE_EXT_RE.exec(detailsText)) !== null) {
        let f = m[1] || m[0];
        f = f.trim().replace(/^[\W_]+|[\W_]+$/g, '');
        if (f.length < 4 || f.length > 80) continue;
        const base = path.basename(f);
        if (base.length < 4 || base.length > 60) continue;
        // basename должен содержать хотя бы одну букву (не "1.22.go")
        if (!/[a-zA-Z]/.test(base)) continue;
        found.add(base);
    }
    return Array.from(found).slice(0, 4);
}

function extractKeys(detailsText, fileBasenames) {
    // Готовим набор «токенов от файлов» для исключения дубля key↔file.
    // Например, MyClass.go → файл; MyClass отдельно как key — лишний шум.
    const fileTokens = new Set();
    for (const f of fileBasenames) {
        const stem = f.replace(/\.[^.]+$/, '');
        if (stem.length >= 4) fileTokens.add(stem);
    }
    const counts = new Map();
    let m;
    KEY_RE.lastIndex = 0;
    while ((m = KEY_RE.exec(detailsText)) !== null) {
        const k = m[0];
        if (KEY_STOPWORDS.has(k)) continue;
        if (fileTokens.has(k)) continue;
        if (k.length < 6 || k.length > 40) continue;
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    return Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([k]) => k);
}

// Очищает brief от потенциальной markdown-инъекции
// (одиночная строка из `### Заголовок`, `---`, `<details>` и т.п.).
function sanitizeBrief(s) {
    return s.replace(/[\r\n\t]+/g, ' ').replace(/^[#>`*\-_=]+\s*/g, '').trim();
}

// Безопасно режет строку до N символов, не разрывая суррогатные пары.
function safeTruncate(s, max) {
    if (!s) return '';
    const arr = Array.from(s);
    if (arr.length <= max) return s;
    return arr.slice(0, max - 3).join('') + '...';
}

function parseHistory(historyFile) {
    if (!fs.existsSync(historyFile)) return [];
    const lines = fs.readFileSync(historyFile, 'utf8').split('\n');
    const tasks = [];
    let i = 0;
    while (i < lines.length) {
        const headerMatch = lines[i].match(TASK_BLOCK_RE);
        if (!headerMatch) { i++; continue; }
        const sprintNum = headerMatch[1];
        const subtaskNum = headerMatch[2];
        const subSubNum = headerMatch[3];
        const id = subSubNum ? `${sprintNum}.${subtaskNum}.${subSubNum}` : `${sprintNum}.${subtaskNum}`;
        const lineNum = i + 1;

        // Линейный курсор: brief = строки от заголовка до <details>, ###, ---, или конца.
        let j = i + 1;
        const briefParts = [];
        while (j < lines.length) {
            const l = lines[j];
            const trimmed = l.trim();
            if (trimmed.startsWith('<details') || trimmed === '---' || TASK_BLOCK_RE.test(l)) break;
            if (trimmed) briefParts.push(trimmed);
            j++;
        }
        const brief = sanitizeBrief(briefParts.join(' '));

        // Линейный поиск <details>...</details> с учётом code fence.
        let details = '';
        let inFence = false;
        let detailsStartLine = -1;
        for (let k = j; k < lines.length; k++) {
            const l = lines[k];
            const trimmed = l.trim();
            if (TASK_BLOCK_RE.test(l)) break;
            if (trimmed === '---' && !inFence && detailsStartLine === -1) break;
            if (/^```/.test(trimmed)) inFence = !inFence;
            if (!inFence && trimmed.startsWith('<details')) {
                detailsStartLine = k;
                continue;
            }
            if (!inFence && detailsStartLine !== -1 && trimmed.startsWith('</details>')) {
                details = lines.slice(detailsStartLine + 1, k).join('\n');
                break;
            }
        }

        // Куда прыгать дальше: ближайший из --- или следующий заголовок.
        let nextI = -1;
        for (let k = j; k < lines.length; k++) {
            if (TASK_BLOCK_RE.test(lines[k])) { nextI = k; break; }
            if (lines[k].trim() === '---') { nextI = k + 1; break; }
        }
        if (nextI <= i) nextI = i + 1; // защита от зацикливания

        const files = extractFiles(details);
        const keys = extractKeys(details, files);

        tasks.push({
            id, sprint: sprintNum, subtask: parseInt(subtaskNum, 10),
            subSub: subSubNum ? parseInt(subSubNum, 10) : 0,
            line: lineNum, brief, files, keys,
        });
        i = nextI;
    }

    // Дедуп: если в логе случайно несколько записей с одним id — оставить ПОСЛЕДНЮЮ
    // (свежее всего по line). На практике актуальная реализация всегда последняя.
    const byId = new Map();
    for (const t of tasks) byId.set(t.id, t);
    return Array.from(byId.values()).sort((a, b) => {
        if (a.sprint !== b.sprint) return parseInt(a.sprint, 10) - parseInt(b.sprint, 10);
        if (a.subtask !== b.subtask) return a.subtask - b.subtask;
        return a.subSub - b.subSub;
    });
}

function buildIndex(tasks, sprintTitles) {
    const lines = [
        '# Execution Index',
        '',
        '> Краткий обзор всех завершённых задач для дешёвого поиска прошлых реализаций.',
        '> Чтобы прочитать подробности задачи N.M: используй `Read execution_history.md offset:<L> limit:15`,',
        '> где `<L>` — номер строки из `[L:<line>]` ниже.',
        '> Сам файл `execution_history.md` ЦЕЛИКОМ читать НЕ нужно.',
        '',
    ];
    const bySprint = new Map();
    for (const t of tasks) {
        if (!bySprint.has(t.sprint)) bySprint.set(t.sprint, []);
        bySprint.get(t.sprint).push(t);
    }
    const sprintNums = Array.from(bySprint.keys()).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const sn of sprintNums) {
        const title = sprintTitles.get(sn) || '';
        lines.push(title ? `## Спринт ${sn}: ${title}` : `## Спринт ${sn}`);
        const items = bySprint.get(sn);
        for (const t of items) {
            const briefShort = safeTruncate(t.brief, 100);
            const filesPart = t.files.length ? ` [files: ${t.files.join(', ')}]` : '';
            const keysPart = t.keys.length ? ` [keys: ${t.keys.join(', ')}]` : '';
            lines.push(`- ${t.id} [L:${t.line}] — ${briefShort}${filesPart}${keysPart}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

// Атомарная запись с уникальным tmp-suffix и retry на Windows-EBUSY.
function atomicWrite(targetPath, content, retries = 3) {
    const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    let lastErr;
    try {
        fs.writeFileSync(tmp, content, 'utf8');
        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                fs.renameSync(tmp, targetPath);
                return;
            } catch (e) {
                lastErr = e;
                // EBUSY/EPERM на Windows если target открыт другим процессом — короткая пауза и retry.
                const wait = 50 * (attempt + 1);
                const sab = new SharedArrayBuffer(4);
                Atomics.wait(new Int32Array(sab), 0, 0, wait);
            }
        }
        // Не удалось — попробуем прямую перезапись (менее атомарно, но не теряем индекс).
        fs.writeFileSync(targetPath, content, 'utf8');
    } finally {
        // Удалить tmp если он остался (rename не прошёл, fallback применён).
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    }
    if (lastErr && !fs.existsSync(targetPath)) throw lastErr;
}

function regenerateIndex(projectDir) {
    const historyFile = path.join(projectDir, 'execution_history.md');
    const tasksFile = path.join(projectDir, 'tasks.md');
    const indexFile = path.join(projectDir, 'execution_index.md');
    if (!fs.existsSync(historyFile)) return { written: false, reason: 'no_history' };
    const tasks = parseHistory(historyFile);
    const titles = parseTasksMd(tasksFile);
    const content = buildIndex(tasks, titles);
    atomicWrite(indexFile, content);
    return { written: true, tasks: tasks.length, bytes: Buffer.byteLength(content, 'utf8') };
}

module.exports = { regenerateIndex, parseHistory, buildIndex, extractFiles, extractKeys };

if (require.main === module) {
    const dir = process.argv[2] || process.cwd();
    const res = regenerateIndex(dir);
    console.log(JSON.stringify(res, null, 2));
}
