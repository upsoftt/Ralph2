# Product Requirements Document — Ralph 2.0

## 1. Общее видение (Vision)

Ralph 2.0 — **автономный AI-оркестратор задач** с веб-дашбордом. Запускает Claude Code (или Gemini CLI) через PTY-терминал, последовательно скармливает задачи из spec-файлов и отслеживает прогресс в реальном времени. Пользователь видит живую консоль AI, управляет выполнением (Play/Pause/Stop) и получает отчёты — всё через браузер.

**Ключевое отличие от v1:** Ralph 2.0 — консолидированный проект. Веб-сервер, overseer и агенты живут в одном репозитории. Overseer написан на Node.js (node-pty), а не Python. Используется JSONL dual-channel протокол вместо stdin-инъекций.

## 2. Целевая аудитория

Разработчик-одиночка (или небольшая команда), использующий AI-ассистентов (Claude Code, Gemini CLI) для автоматизации рутинных задач разработки. Хочет:
- Запускать AI на проект и уйти — Ralph выполнит задачи автономно
- Видеть прогресс в реальном времени через браузер
- Управлять несколькими проектами параллельно
- Иметь историю выполнения и отчёты

## 3. Архитектура

### 3.1. Компоненты

| Компонент | Технология | Файл | Описание |
|-----------|------------|------|----------|
| Web Server + Dashboard | Python 3.11, http.server | `ralph-tracker-web.py` | Монолит ~2200 строк. HTML/CSS/JS встроены в Python-строку. Порт 8767 |
| Overseer | Node.js, node-pty | `ralph-overseer.js` | Управляет PTY-процессом AI CLI. JSONL dual-channel протокол |
| Agent Profiles | Node.js | `agents.js` | Конфигурация CLI-агентов (Claude, Gemini). Boot sequence, patterns |
| System Tray | Python, pystray | `ralph-tray.py` | Иконка в трее Windows (опционально) |
| Spec Converter | PowerShell | `spec-converter-fixed.ps1` | Генерирует spec-файлы из tasks.md |
| TrayConsole Client | Python | `trayconsole_client.py` | Интеграция с TrayConsole (Named Pipes, heartbeat) |

### 3.2. Потоки данных

```
[Dashboard (Browser)]
     ↕ HTTP API (port 8767)
[Web Server (Python)]
     ↕ subprocess + файлы (status.json, live_console_4.log)
[Overseer (Node.js + node-pty)]
     ↕ PTY stdin/stdout + JSONL
[Claude Code / Gemini CLI]
     ↕ файловая система проекта
[Проект пользователя]
```

### 3.3. Файловый IPC

- `status.json` — текущее состояние overseer (running, paused, heartbeat, задача, прогресс)
- `live_console_4.log` — живой лог PTY-вывода для стриминга в дашборд
- `.ralph-stop` — файл-сигнал для остановки (overseer проверяет каждую секунду)
- `.ralph-pause` — файл-сигнал для паузы (overseer паузит PTY-процесс)
- `busy_state.json` — состояние "занятости" сервера (для блокировки параллельных операций)
- `launch_state.json` — состояние запущенных проектных процессов (dev-серверы и т.д.)
- `results/*.json` — результаты выполнения задач (по одному файлу на задачу)

## 4. Ключевые функции

### 4.1. Трёхколоночный дашборд
- **Колонка 1 (проекты):** Компактный список проектов с прогресс-барами, кнопками Play/Pause/Stop
- **Колонка 2 (задачи):** Спринты с чекбоксами, группировка "В работе" / "Выполнено"
- **Колонка 3 (детали):** Описание задачи + живая консоль AI
- Все разделители перетаскиваемые (resizable), размеры сохраняются в localStorage

### 4.2. Управление выполнением
- **Play** — запускает overseer для выбранного проекта
- **Pause** — замораживает PTY-процесс AI mid-task (мгновенная пауза через `ptyProcess.pause()`)
- **Stop** — корректная остановка: overseer дожидает текущую задачу и выходит
- **Action Lock** — блокировка кнопок с индикатором загрузки во время операций
- Heartbeat-мониторинг: если overseer не обновляет heartbeat >15 сек — процесс считается мёртвым

### 4.3. Протокол RALPH_RESULT
Overseer ищет в JSONL-выводе Claude Code маркер `RALPH_RESULT`:
```
RALPH_RESULT:DONE:Описание выполненного
```
После обнаружения: сохраняет результат, отмечает задачу [x] в spec.md И tasks.md, переходит к следующей.

### 4.4. Живая консоль
- SSE-подобный polling (каждые 3 сек) файла `live_console_4.log`
- Автоскролл, сворачивание/разворачивание по клику на заголовок
- Вертикальный ресайзер между описанием и консолью

### 4.5. Мульти-проектность
- Добавление проектов через UI или скилл `/ralph-add-project`
- Каждый проект — отдельная директория с `tasks.md`, `specs/`, `.ralph-runner/`
- Параллельное выполнение: несколько overseer-ов для разных проектов
- Контекстное меню: рестарт, сброс прогресса, генерация спеков, удаление

### 4.6. Управление задачами в UI
- Inline-редактирование описаний задач
- Добавление подзадач к существующим спринтам
- Добавление идей (новые задачи в отдельный спринт)
- Toggle чекбоксов задач
- Просмотр отчётов выполнения (AI-сгенерированные summary)

### 4.7. Launch System
- Запуск dev-серверов проекта через `launch.json` (аналог VS Code tasks)
- Multi-step launch (несколько процессов)
- Сохранение/восстановление состояния запущенных процессов при перезапуске сервера

### 4.8. Интеграция с TrayConsole
- Named Pipes для heartbeat и команд
- Действие "Открыть дашборд" из трея TrayConsole
- Автозапуск при старте TrayConsole

## 5. Платформа и ограничения

- **Windows 10+ only** — использует WinAPI через ctypes (OpenProcess, SetConsoleCtrlHandler)
- **`os.kill(pid, 0)` УБИВАЕТ процесс на Windows** — используется `OpenProcess` для проверки
- Монолитный файл `ralph-tracker-web.py` (~2200 строк) — HTML/CSS/JS встроены в Python raw-строку
- Vanilla JS без фреймворков
- UTF-8 кодировка, `projects.json` может иметь BOM (`utf-8-sig`)

## 6. API Endpoints

### GET
| Endpoint | Описание |
|----------|----------|
| `/` | Дашборд (HTML) |
| `/api/stream` | Текущее состояние + лог консоли для активного проекта |
| `/api/crash-log` | Лог ошибок overseer |
| `/api/server-log` | Лог веб-сервера |
| `/api/task-report` | Отчёт по конкретной задаче |
| `/api/launch-info` | Информация о launch.json проекта |
| `/api/task-results` | Все результаты задач проекта |

### POST
| Endpoint | Описание |
|----------|----------|
| `/api/project` | Выбрать активный проект |
| `/api/start4` | Запустить overseer (Play) |
| `/api/stop` | Остановить overseer |
| `/api/pause` | Пауза/продолжение |
| `/api/restart` | Перезапустить overseer |
| `/api/restart-server` | Перезапустить веб-сервер |
| `/api/clear-stream` | Очистить консоль |
| `/api/reset-full` | Полный сброс проекта |
| `/api/reset-progress` | Сброс прогресса (галочки) |
| `/api/toggle-task` | Переключить чекбокс задачи |
| `/api/generate-specs` | Сгенерировать spec-файлы |
| `/api/delete-project` | Удалить проект из трекера |
| `/api/save-task-description` | Сохранить описание задачи |
| `/api/add-subtask` | Добавить подзадачу |
| `/api/add-idea` | Добавить идею |
| `/api/launch` | Запустить dev-сервер проекта |
| `/api/generate-launch` | AI-генерация launch.json |
| `/api/launch-stop` | Остановить dev-сервер |
| `/api/open-folder` | Открыть папку в Explorer |
| `/api/show-console` | Показать окно консоли overseer |

## 7. Текущее состояние и известные проблемы

### Audit Fix Plan (tasks.md — 3 спринта, 8 задач)
**Спринт 1: Критические баги** — race conditions в `_save_launch_state`, heartbeat перезаписывает paused, нет лимита Content-Length
**Спринт 2: Безопасность** — XSS в onclick-обработчиках, опасный `/api/reset-full`
**Спринт 3: Надёжность** — ~40 мест `except: pass`/`catch(e){}`, socket leak в tray, мёртвый код

## 8. Метрики успеха

- Все проекты пользователя управляются через единый дашборд
- AI выполняет задачи автономно без ручного вмешательства
- Ошибки overseer логируются и видны в UI (не проглатываются)
- Нет XSS-уязвимостей в динамическом HTML
- Перезапуск сервера не теряет состояние запущенных процессов
