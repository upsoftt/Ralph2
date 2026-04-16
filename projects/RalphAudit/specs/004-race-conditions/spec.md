# Спринт 4: Race conditions

## Команда запуска для Ralph Runner
`claude -p "Прочитай этот файл (specs/004-race-conditions/spec.md). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам. ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>." `

## Ссылки на контекст
- [Планирование](../../planning.md)

## Tasks

- [x] {{TASK:4.1}} Добавить threading.Lock для записи в spec.md / tasks.md
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Создать `_file_lock = _threading.Lock()`. Обернуть запись в spec.md и tasks.md через `with _file_lock:` в: `/api/toggle-task`, `/api/add-subtask`, `/api/save-task-description`.
  - **Ограничения:** Lock не защитит от гонки с Claude Code subprocess — это known limitation (Claude работает в отдельном процессе).
  - **Критерии приёмки:** Два одновременных toggle-task к одному spec.md не теряют данные.

## Completion
- [ ] Все задачи выполнены
