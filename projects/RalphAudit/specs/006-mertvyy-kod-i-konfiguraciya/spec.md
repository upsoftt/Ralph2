# Спринт 6: Мёртвый код и конфигурация

## Команда запуска для Ralph Runner
`claude -p "Прочитай этот файл (specs/006-mertvyy-kod-i-konfiguraciya/spec.md). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам. ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>." `

## Ссылки на контекст
- [Планирование](../../planning.md)

## Tasks

- [x] {{TASK:6.1}} Удалить мёртвый код Ralph 2/3/5
  **ПОДРОБНОСТИ:**
  - **Что сделать:**
    1. Строка ~999: убрать `"live_console.log"`, `"live_console_3.log"`, `"live_console_5.log"` из reset-full.
    2. Строка 3: docstring → `"Ralph Progress Tracker 4.0"`.
    3. Строки 69/72: унифицировать дефолтный ACTIVE_PROJECT_ID.
  - **Критерии приёмки:** `grep -r "console_3\|console_5\|Ralph 2" ralph-tracker-web.py` → пусто.

- [x] {{TASK:6.2}} Вынести путь claude.exe в конфигурацию
  **ПОДРОБНОСТИ:**
  - **Что сделать:**
    1. `ralph4/agents.js`: `command: process.env.CLAUDE_EXE || 'claude'`.
    2. `ralph-tracker-web.py` (строки 870, 955): `claude_exe = shutil.which('claude') or r"C:\Users\upsof\.local\bin\claude.exe"`.
  - **Критерии приёмки:** Работает если claude в PATH; работает с fallback.

- [x] {{TASK:6.3}} Завершать процесс после uncaughtException
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph4/ralph-overseer.js` строка 73-75: добавить `clearStatus(); process.exit(1);` после логирования.
  - **Критерии приёмки:** uncaughtException → overseer завершается → status.json = `{running: false}`.

- [x] {{TASK:6.4}} Нормализовать разделители путей в projects.json
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В записях "dictator-2-2-" и "wbsupport" заменить смешанные `D:/...\\...` на единообразные `D:\\...\\...`.
  - **Критерии приёмки:** Все пути в projects.json используют один стиль разделителей.

## Completion
- [ ] Все задачи выполнены
