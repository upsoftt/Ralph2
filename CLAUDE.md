# Ralph 2.0 — Правила для агента

## Технический стек
- **Веб-сервер:** Python 3.11, http.server (HTTPServer + BaseHTTPRequestHandler)
- **Overseer:** Node.js, node-pty, JSONL dual-channel
- **Idea Worker:** Node.js, node-pty (`ralph-idea.js` — обработка идей через Claude)
- **Трей:** Python, pystray, PIL, ctypes (WinAPI)
- **Фронтенд:** Vanilla JS, встроенный в Python-строку (single-file)
- **Платформа:** Windows 10

## Критические правила
1. Всегда читай PRD.md перед началом работы.
2. Отмечай выполненные задачи в spec.md И tasks.md крестиком [x].
3. Весь код — Windows-only. Используй Windows API через ctypes, не Unix-сигналы.
4. `os.kill(pid, 0)` на Windows **УБИВАЕТ** процесс — использовать `ctypes.windll.kernel32.OpenProcess` для проверки.
5. Файл `ralph-tracker-web.py` — monolith (~2300 строк). HTML/CSS/JS встроены в Python-строки.
6. Кодировка файлов: UTF-8. `projects.json` может иметь BOM — читать через `utf-8-sig`.
7. Порт веб-сервера: 8767.
8. Overseer использует ТОЛЬКО `jsonlBuffer` для извлечения результатов (НЕ `logicalBuffer` — он содержит PTY-эхо промптов).
9. При обнаружении RALPH_RESULT — отмечать [x] в ОБОИХ файлах: spec.md и tasks.md.
10. Дубликаты spec-папок проверяются по НОМЕРУ спринта (префикс `NNN-`), не по полному имени.
11. Overseer отправляет агенту ОДНУ задачу за раз. Агент должен выполнить только её и вывести RALPH_RESULT, затем overseer назначит следующую.
12. После закрытия спринта (аудит OK + git commit) overseer автоматически перезапускает Claude Code для сброса контекста. Перед перезапуском собирает недостающие результаты задач.

## Структура проекта
```
Ralph2\
├── ralph-tracker-web.py       # Веб-сервер + 3-колоночный дашборд (монолит ~2300 строк)
├── ralph-overseer.js          # Overseer — управление Claude Code через PTY, аудит спринтов
├── ralph-idea.js              # Worker — обработка идей пользователя через Claude PTY
├── agents.js                  # Конфигурация агентов (Claude, Gemini)
├── ralph-tray.py              # Системный трей (опциональный, pystray)
├── spec-converter-fixed.ps1   # Генерация spec-файлов из tasks.md
├── trayconsole.json           # Манифест TrayConsole
├── trayconsole_client.py      # Клиент TrayConsole (Named Pipes)
├── projects.json              # Список проектов (id, name, path, specs_dir)
├── projects/                  # Данные проектов (specs, history, results)
├── tasks.md                   # План исправлений (audit fixes)
├── specs/                     # Спецификации для Ralph Runner (собственные)
├── tracker_state.json         # Состояние трекера (активный проект)
├── favicon.svg                # Иконка (синее яблоко)
├── RalphTray.exe              # Скомпилированный трей
├── SETUP-NEW-PC.md            # Инструкции деплоя на новую машину
├── SETUP-PROMPT.md            # Промпт для настройки нового окружения
├── package.json               # npm-зависимости (node-pty)
└── README.md                  # Описание проекта
```

## Файловый IPC протокол
- `status.json` — состояние overseer (running, paused, heartbeat, задача, прогресс)
- `live_console_4.log` — живой лог PTY для стриминга в дашборд
- `thinking_status.txt` — статус модели (контекст %, thinking line)
- `.ralph-stop` / `.ralph-pause` — файлы-сигналы для остановки/паузы
- `busy_state.json` — блокировка параллельных операций (переживает перезапуск сервера)
- `launch_state.json` — состояние запущенных dev-серверов
- `results/*.json` — результаты выполнения задач (brief + summary)
- `crash.log` — лог ошибок overseer

## Протокол RALPH_RESULT
Overseer ожидает от агента многострочный отчёт:
```
RALPH_RESULT
TASK: 1.1
BRIEF: <что сделано с точки зрения пользователя>
SUMMARY: <техническое описание>
STATUS: DONE
RALPH_END
```
Парсер поддерживает также неполные блоки (без RALPH_END) и legacy XML-форматы.
