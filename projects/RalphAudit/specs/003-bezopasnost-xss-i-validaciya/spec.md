# Спринт 3: Безопасность — XSS и валидация

## Команда запуска для Ralph Runner
`claude -p "Прочитай этот файл (specs/003-bezopasnost-xss-i-validaciya/spec.md). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам. ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>." `

## Ссылки на контекст
- [Планирование](../../planning.md)

## Tasks

- [x] {{TASK:3.1}} Добавить escapeHtml и применить ко всем точкам инъекции
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В JS-часть `ralph-tracker-web.py` добавить:
    ```javascript
    function esc(s) { if(!s) return ''; const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }
    ```
  - Применить к: `${p.name}`, `${p.launch_description}`, `${p.busy}`, `${t.text}` (через `esc(cleanTaskText(...))`), `${d.summary}`, `${d.content}` в crash-log, `${t.description}` в textarea.
  - **Критерии приёмки:** Проект с именем `<img src=x onerror=alert(1)>` отображается как текст.

- [x] {{TASK:3.2}} Валидация путей в /api/open-folder
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Проверять что `body.get('path')` совпадает с путём одного из зарегистрированных проектов.
  - **Критерии приёмки:** POST с `path: "C:\\Windows\\System32\\cmd.exe"` → ошибка.

## Completion
- [ ] Все задачи выполнены
