# Спринт 100: Split Layout — Каркас двухпанельного интерфейса

## Команда запуска для Ralph Runner
`claude -p "Прочитай этот файл (specs/100-Split Layout — Каркас двухпанельного интерфейса/spec.md). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам из claude.md и применяй глобальные навыки (TDD, Debugging). ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md и корневой tasks.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>, а затем напиши блок <report>...</report>, внутри которого должен быть только строгий JSON с ключами: 'exact_task_name' (в точности скопируй строку задачи из файла), 'summary' (подробное описание того, что сделано), 'skills_used' (массив названий навыков, которые ты применил)."`

## Ссылки на контекст
- [Планирование](../../planning.md)
- [Правила](../../CLAUDE.md)
- [PRD](../../PRD.md)

## Tasks

- [x] {{TASK:100.1}} Заменить однонаправленный layout на CSS Grid split-view с двумя панелями
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `ralph-tracker-web.py` функция `get_dashboard_html()` — полностью перестроить HTML-структуру `<div class="container">`. Вместо вертикального стека (проекты → задачи → консоль) создать двухпанельный layout.
  - **Как сделать:**
    1. Заменить `.container` на CSS Grid: `display: grid; grid-template-columns: 25% 1fr; height: 100vh;`
    2. Создать `<div class="left-panel">` — содержит список проектов (скроллируемый) + статус сервера (прибит к низу).
    3. Создать `<div class="right-panel">` — содержит заголовок проекта + задачи (верх) + консоль (низ).
    4. `body` должен стать `height: 100vh; overflow: hidden; padding: 0;` — полноэкранный режим.
    5. `.left-panel`: `display: flex; flex-direction: column; border-right: 1px solid var(--border); overflow: hidden;`
    6. `.right-panel`: `display: flex; flex-direction: column; overflow: hidden;`
  - **Ограничения:** НЕ менять API-логику, только HTML/CSS/JS внутри `get_dashboard_html()`. Все `onclick`, `fetch()`, id-элементов сохранить для совместимости.
  - **Критерии приёмки:** Страница отображается в двухпанельном режиме. Слева — пустой блок проектов. Справа — пустой блок задач/консоли. Нет горизонтального скролла. Весь viewport заполнен.
- [x] {{TASK:100.2}} Добавить горизонтальный ресайзер между панелями
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Вставить `<div class="h-resizer">` между `.left-panel` и `.right-panel`. Реализовать drag-логику на JS.
  - **Как сделать:**
    1. HTML: `<div class="h-resizer" id="hResizer"></div>` — между панелями.
    2. CSS: `.h-resizer { width: 6px; cursor: col-resize; background: var(--border); transition: background 0.2s; z-index: 10; }` `.h-resizer:hover, .h-resizer.dragging { background: var(--blue); }`
    3. JS: `mousedown` на ресайзере → `mousemove` на document → пересчёт `grid-template-columns` у `.container`. `mouseup` → сохранение ширины в `localStorage.setItem('ralph_hSplit', leftPanelPercent)`.
    4. При загрузке: `const saved = localStorage.getItem('ralph_hSplit')` → применить к `grid-template-columns`.
    5. Минимальная ширина левой панели: 200px. Максимальная: 50%.
  - **Ограничения:** Не использовать библиотеки. Чистый JS. При ресайзе не должно моргать или дёргаться.
  - **Критерии приёмки:** Курсор `col-resize` при наведении на полоску. Drag → ширина панелей меняется плавно. После F5 — ширина восстановлена.

## Критерии завершения
- [ ] Все 2 невыполненных задач реализованы и протестированы.
- [ ] Файл `tasks.md` обновлен (поставлены [x] для завершенных пунктов).
