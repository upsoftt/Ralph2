# Ralph 2.0 — Правила для агента

## Технический стек
- **Веб-сервер:** Python 3.11, http.server (HTTPServer + BaseHTTPRequestHandler)
- **Overseer:** Node.js, node-pty, JSONL dual-channel
- **Трей:** Python, pystray, PIL, ctypes (WinAPI)
- **Фронтенд:** Vanilla JS, встроенный в Python-строку (single-file)
- **Платформа:** Windows 10

## Критические правила
1. Всегда читай PRD.md перед началом работы.
2. Отмечай выполненные задачи в spec.md И tasks.md крестиком [x].
3. Весь код — Windows-only. Используй Windows API через ctypes, не Unix-сигналы.
4. `os.kill(pid, 0)` на Windows **УБИВАЕТ** процесс — использовать `ctypes.windll.kernel32.OpenProcess` для проверки.
5. Файл `ralph-tracker-web.py` — monolith (~2200 строк). HTML/CSS/JS встроены в Python-строки.
6. Кодировка файлов: UTF-8. `projects.json` может иметь BOM — читать через `utf-8-sig`.
7. Порт веб-сервера: 8767.
8. Overseer использует ТОЛЬКО `jsonlBuffer` для извлечения результатов (НЕ `logicalBuffer` — он содержит PTY-эхо промптов).
9. При обнаружении RALPH_RESULT — отмечать [x] в ОБОИХ файлах: spec.md и tasks.md.
10. Дубликаты spec-папок проверяются по НОМЕРУ спринта (префикс `NNN-`), не по полному имени.

## Структура проекта
```
Ralph2\
├── ralph-tracker-web.py       # Веб-сервер + 3-колоночный дашборд (монолит)
├── ralph-overseer.js          # Overseer — управление Claude Code через PTY
├── agents.js                  # Конфигурация агентов (Claude, Gemini)
├── ralph-tray.py              # Системный трей (опциональный, pystray)
├── spec-converter-fixed.ps1   # Генерация spec-файлов из tasks.md
├── trayconsole.json           # Манифест TrayConsole
├── trayconsole_client.py      # Клиент TrayConsole (Named Pipes)
├── projects.json              # Список проектов
├── tasks.md                   # План исправлений (audit fixes)
├── specs/                     # Спецификации для Ralph Runner
├── favicon.svg                # Иконка (синее яблоко)
└── RalphTray.exe              # Скомпилированный трей
```

## Файловый IPC протокол
- `status.json` — состояние overseer (running, paused, heartbeat)
- `live_console_4.log` — живой лог PTY для стриминга
- `.ralph-stop` / `.ralph-pause` — файлы-сигналы
- `busy_state.json` — блокировка параллельных операций
- `launch_state.json` — состояние запущенных dev-серверов
- `results/*.json` — результаты выполнения задач
