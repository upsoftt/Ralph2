# Задачи: Ralph 2.0 — Audit Fixes

## Спринт 1: Критические баги и race conditions
**[Role: Backend Architect]**

- [x] {{TASK:1.1}} Исправить LAUNCHED_PROCESSES для работы с массивом процессов
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph-tracker-web.py` значение `LAUNCHED_PROCESSES[pid]` может быть как `Popen`, так и `list[Popen]` (при multi-step launch, строка 352: `.append(proc)`). Несколько мест вызывают `.poll()` без проверки типа.
  - **Конкретные места для исправления:**
    - **Строка 550** (`/api/launch-info`): `LAUNCHED_PROCESSES[pid].poll()` — вызывает `.poll()` на списке → `AttributeError`, молча проглатывается. **Исправить:** добавить `isinstance(v, list)` проверку, аналогично строке 436-438 где это уже сделано правильно.
    - **Строка 150** (`_save_launch_state`): итерирует `LAUNCHED_PROCESSES.items()` и вызывает `proc.poll()` — если значение список, упадёт. **Исправить:** обработать оба типа.
  - **НЕ затронуты (уже безопасны):** строка 436-438 (`update_status` — уже `isinstance` проверка), строки 156-165 (`_restore_launch_state` — работает с `_PidHandle`).
  - **Дополнительно:** daemon-поток `run_steps` (строка 355) модифицирует `LAUNCHED_PROCESSES` одновременно с main-потоком. Сервер использует `HTTPServer` (не `ThreadingHTTPServer`), но daemon-поток создаётся вручную. Обернуть доступ к `LAUNCHED_PROCESSES` в существующий `_file_lock` или создать отдельный `_launch_lock`.
  - **Критерии приёмки:** Запустить проект с multi-step launch.json. `launch_state.json` корректно сохраняет оба PID. `/api/launch-info` возвращает `running: true` для multi-step проекта. Перезапуск сервера — оба процесса видны.

- [x] {{TASK:1.2}} ~~Исправить heartbeat чтобы не перезаписывал paused флаг~~
  **СТАТУС: ИСПРАВЛЕНО.** Heartbeat корректно использует read-modify-write: читает status.json, обновляет только поле `heartbeat`, сохраняет обратно.

- [x] {{TASK:1.3}} Добавить лимит Content-Length на HTTP-запросы
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph-tracker-web.py` метод `do_POST` (строка 579) читает `self.rfile.read(clen)` без проверки верхнего предела. Запрос с `Content-Length: 2000000000` вызовет `MemoryError`. Других HTTP-методов с чтением тела нет (только `do_GET` и `do_POST`).
  - **Как сделать:** Добавить проверку `if clen > 1_000_000: self.send_error(413); return` перед `self.rfile.read(clen)`.
  - **Критерии приёмки:** Сервер возвращает 413 при Content-Length > 1MB.

- [x] {{TASK:1.4}} Устранить race condition при записи в spec.md и tasks.md
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Два процесса (web-сервер и overseer) одновременно пишут в `spec.md` и `tasks.md` одного проекта без координации. Web-сервер использует `_file_lock` для spec.md (строка 752), но пишет tasks.md **вне** лока (строки 778-784). Overseer (`ralph-overseer.js`, строки 1202, 1213) пишет в оба файла без какой-либо блокировки.
  - **Как сделать:**
    1. В web-сервере: перенести запись tasks.md (строки 778-784) ВНУТРЬ блока `with _file_lock` (строка 752).
    2. В overseer: использовать file-level лок (например, `lockfile` npm-пакет или `.lock`-файл) при записи spec.md и tasks.md.
    3. Альтернативный подход: overseer пишет результат в `results/*.json`, а web-сервер единолично обновляет spec.md/tasks.md при следующем запросе (single writer pattern).
  - **Ограничения:** Не усложнять протокол — overseer и web-сервер уже координируются через файлы. Минимальное решение — расширить _file_lock в Python на обе записи и добавить retry-with-backoff в overseer.
  - **Критерии приёмки:** Запустить overseer на проект. Одновременно toggle задачу через UI. Оба изменения сохраняются в spec.md и tasks.md без потери данных.

## Спринт 2: Безопасность и XSS
**[Role: Security Engineer]**

- [x] {{TASK:2.1}} Экранировать пользовательские данные во всех HTML-контекстах
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В встроенном JS множество мест где пользовательские данные вставляются без экранирования:
    - **onclick/oncontextmenu (9 мест, строки 1595-1624):** `p.id` вставляется в `onclick="stopRun('${p.id}')"` и аналогичные — без экранирования. Crafted ID `test')+alert(1)+fetch("x` выходит из строки.
    - **onclick с spec name (строки 1712, 1718, 1722, 1727, 1969):** `s` (имя спека) вставляется без экранирования. `t.text` экранируется только `replace(/'/g, "\\'")` — недостаточно.
    - **innerHTML (строки 1505, 1545):** `customModalMsg.innerHTML = msg` — прямая инъекция если `msg` содержит пользовательские данные.
  - **Как сделать:**
    1. Создать `escAttr(s)` — экранирует `'`, `"`, `\`, `<`, `>`, `&` для атрибутных контекстов.
    2. Заменить все `'${p.id}'` → `'${escAttr(p.id)}'` в onclick/oncontextmenu (9 мест).
    3. Заменить все `'${s}'` → `'${escAttr(s)}'` и `t.text.replace(...)` → `escAttr(t.text)` в onclick (5 мест).
    4. Заменить `innerHTML = msg` на `textContent = msg` или пропускать через `esc()` (строки 1505, 1545).
  - **Критерии приёмки:** Проект с ID `test'"><script>alert(1)</script>` рендерится без XSS. Spec с именем `'; alert(1); '` — аналогично. Все кнопки и контекстное меню работают.

- [x] {{TASK:2.2}} Инвертировать логику /api/reset-full
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Endpoint `/api/reset-full` (строки 709-735) удаляет все файлы кроме keeplist (`prd.md`, `gemini.md`, `planning.md`, `tasks.md`, `ralph_history.txt`, `.ralph-runner`, `specs`, `.gemini`, `node_modules`, `.git`). Не в keeplist: `.gitignore`, `package.json`, `package-lock.json`, `tsconfig.json`, `requirements.txt`, `.env`, `docker-compose.yml`, `README.md`, `Dockerfile`, `src/` — всё это **удаляется**.
  - **Как сделать:** Инвертировать логику: удалять ТОЛЬКО `.ralph-runner/results/` и сбрасывать галочки в `specs/*/spec.md`. Исходный код проекта НЕ трогать. Переименовать endpoint в `/api/reset-ralph`.
  - **Ограничения:** Обновить JS-код: строка 1890 (`fetch('/api/reset-full'...)`), текст подтверждения (строки 1887-1892).
  - **Критерии приёмки:** После reset: `.ralph-runner/results/` очищена, spec.md галочки сброшены, `src/`, `package.json`, `.gitignore` — нетронуты.

- [x] {{TASK:2.3}} Устранить command injection через shell=True
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Несколько мест в `ralph-tracker-web.py` используют `subprocess.run(cmd, shell=True)` с данными из HTTP-запросов или непроверенными путями:
    - **Строка 328:** `cmd` из launch.json `command` поля передаётся в `subprocess.run(cmd, shell=True)`. Если launch.json содержит `"command": "echo foo & del /s /q C:\\"`, это будет выполнено.
    - **Строка 798:** PowerShell команда собирается через f-string с путями, которые могут содержать спецсимволы.
    - **Строки 195, 212, 675:** `taskkill` команды с PID — менее опасны (PID — число), но shell=True всё равно лишний.
  - **Как сделать:**
    1. **Строка 328:** launch.json `command` — это пользовательский конфиг, выполняется by design. Добавить проверку: команда должна быть строкой, не содержать `&`, `|`, `&&`, `||`, `;`, `` ` `` вне кавычек. Или использовать `shell=False` с `shlex.split()`.
    2. **Строка 798:** Передавать аргументы как список: `['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(path), ...]` вместо f-string. Убрать `shell=True`.
    3. **Строки 195, 212, 675:** Заменить `shell=True` на список аргументов: `['taskkill', '/F', '/PID', str(pid)]`.
  - **Критерии приёмки:** Все subprocess-вызовы используют `shell=False` (кроме launch.json `command` если пользователь явно настроил shell-команду). PowerShell вызывается через список аргументов.

## Спринт 3: Надёжность и error handling
**[Role: Backend Architect]**

- [x] {{TASK:3.1}} Заменить bare except pass на логирование ошибок
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph-tracker-web.py` 36 мест с `except: pass`. В `ralph-overseer.js` 29 мест с `catch(e) {}`. Итого 65 мест где ошибки молча проглатываются.
  - **Приоритет (критические пути, исправить первыми):**
    - **Python строки 101, 112, 154, 165:** JSON-парсинг/запись state-файлов — silent fail = потеря состояния
    - **Python строка 527:** чтение audit report — неверный результат аудита в UI
    - **Python строка 606:** проверка запущенного процесса — может запустить дубликат
    - **JS строки 97, 103:** heartbeat/status — ложное обнаружение "мёртвого" процесса
    - **JS строка 121:** liveness check — дубликат процесса
  - **Как сделать:** Заменить каждый `except: pass` на `except Exception as e: print(f"[error] {context}: {e}")`. В JS: `catch(e) { console.error('context:', e.message); }`. НЕ менять логику.
  - **Исключения (оставить `except: pass`):** Tee.write() строка 44, Tee.flush() строка 48 — ошибка в логировании не должна ломать основной поток. В JS: строки 134, 138, 142, 146, 151 — crash logging (рекурсивная ошибка).
  - **Критерии приёмки:** Повредить `projects.json` (невалидный JSON) → ошибка видна в консоли. Повредить `status.json` → ошибка видна в crash.log.

- [x] {{TASK:3.2}} Исправить socket leak в ralph-tray.py is_port_listening
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph-tray.py` функция `is_port_listening()` (строки 50-58) создаёт socket, но в exception-пути `close()` не вызывается. Функция вызывается **каждую секунду** в `monitor_loop` → за 8 часов можно утечь ~28800 сокетов при сетевых проблемах.
  - **Как сделать:** Обернуть в `try/finally: s.close()` или использовать контекстный менеджер.
  - **Критерии приёмки:** Функция корректно закрывает сокет в обоих путях.

- [x] {{TASK:3.3}} Удалить мёртвый код после рефакторинга
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Удалить:
    - Функцию `togglePanel` (пустая, deprecated, строка ~1903) — 0 вызовов в проекте.
    - Неиспользуемую переменную `cmd_str` (строка ~680) — присваивается, но нигде не используется.
  - ~~CSS-класс `.card`~~ — **не существует** в текущем коде (есть только `.bg-picker-card`, `.modal-card`). Ссылки на `live_console_3/5.log` — уже удалены.
  - **Критерии приёмки:** `grep -c "togglePanel\|cmd_str" ralph-tracker-web.py` возвращает 0.
