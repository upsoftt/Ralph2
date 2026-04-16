# Спринт 2: Потеря данных — JSONL парсер

## Команда запуска для Ralph Runner
`claude -p "Прочитай этот файл (specs/002-poterya-dannyh-jsonl-parser/spec.md). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам. ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>." `

## Ссылки на контекст
- [Планирование](../../planning.md)

## Tasks

- [x] {{TASK:2.1}} Исправить потерю обрезанных строк в JSONL парсере
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph4/ralph-overseer.js` `readNewJsonlMessages()` (строки 109-146) — не сдвигать `jsonlReadPos` за последнюю полную строку.
  - **Как сделать:**
    ```javascript
    const prevPos = jsonlReadPos;
    // ... чтение буфера ...
    const lastNl = newData.lastIndexOf('\n');
    if (lastNl === -1) {
        jsonlReadPos = prevPos; // Откат — нет полных строк
        return [];
    }
    jsonlReadPos = prevPos + Buffer.byteLength(newData.substring(0, lastNl + 1), 'utf8');
    const lines = newData.substring(0, lastNl + 1).split('\n');
    ```
  - **Ограничения:** Учесть что `Buffer.byteLength` ≠ `string.length` для UTF-8.
  - **Критерии приёмки:** При записи половины JSON-строки в JSONL → следующий вызов дочитывает вторую половину → строка парсится полностью.

## Completion
- [ ] Все задачи выполнены
