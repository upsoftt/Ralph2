# Спринт 1: Критические баги — процессы и состояния

## Команда запуска для Ralph Runner
`claude -p "Прочитай этот файл (specs/001-kriticheskiye-bagi-processy-i-sostoyaniya/spec.md). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам. ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>." `

## Ссылки на контекст
- [Планирование](../../planning.md)

## Tasks

- [x] {{TASK:1.1}} Заменить os.kill(pid, 0) на Windows-safe проверку процесса
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph-tracker-web.py` заменить все `os.kill(pid, 0)` (строки 115, 128, 355) на проверку через `ctypes.windll.kernel32.OpenProcess`.
  - **Как сделать:** Создать функцию `_is_process_alive(pid)`:
    ```python
    import ctypes
    def _is_process_alive(pid):
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if handle:
            ctypes.windll.kernel32.CloseHandle(handle)
            return True
        return False
    ```
  - Заменить в `_PidHandle.poll()` (строка 128), `_restore_launch_state()` (строка 115), `update_status()` (строка 355).
  - **Ограничения:** Не использовать `os.kill` на Windows — он посылает сигналы, а не проверяет.
  - **Критерии приёмки:** Запущенный через Launch проект остаётся "running" после перезапуска сервера. Нет побочных эффектов (убийства процессов).

- [x] {{TASK:1.2}} Исправить восстановление busy_state — очищать при старте
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph-tracker-web.py` функция `_restore_busy_state()` (строки 86-95) — при старте удалять `busy_state.json` и устанавливать `BUSY_PROJECTS = {}`.
  - **Как сделать:** Заменить тело функции: `if BUSY_STATE_FILE.exists(): BUSY_STATE_FILE.unlink()`. Все фоновые операции (idea_worker, gen_launch) живут только в памяти — при рестарте они потеряны, нет смысла восстанавливать статус.
  - **Ограничения:** `_save_busy_state()` оставить — нужен для отображения busy между refresh-циклами.
  - **Критерии приёмки:** После рестарта сервера ни один проект не застревает в "busy". Кнопка запуска доступна.

- [x] {{TASK:1.3}} Реализовать паузу в overseer
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph4/ralph-overseer.js` добавить проверку `.ralph-pause` в mainLoop перед выдачей следующей задачи.
  - **Как сделать:** После `if (fs.existsSync(stopFile)) break;` добавить цикл ожидания:
    ```javascript
    while (fs.existsSync(path.join(projectDir, '.ralph-pause'))) {
        chatLog('⏸️ Пауза...', 'OVERSEER');
        writeStatus(true, { paused: true });
        await delay(5000);
    }
    writeStatus(true, { paused: false });
    ```
  - **Ограничения:** Пауза не прерывает текущую задачу — только не выдаёт следующую.
  - **Критерии приёмки:** Кнопка "Пауза" в UI → overseer прекращает брать задачи → статус "Пауза" в дашборде → повторное нажатие → продолжает.

- [x] {{TASK:1.4}} Guard-check в /api/clear-stream и синхронизация подсчёта задач
  **ПОДРОБНОСТИ:**
  - **Что сделать:**
    1. Строка 601: добавить `if not project: self.send_json({"success": False}); return`.
    2. Строки 486-487: заменить regex `\{\{TASK` на парсинг `## Tasks` секции (как в `update_status`). Вынести общую логику в функцию `_count_tasks_in_file(filepath)`.
  - **Критерии приёмки:** `/api/clear-stream` без проекта не падает. Кнопка "Запустить" синхронна с процентом в шапке.

## Completion
- [ ] Все задачи выполнены
