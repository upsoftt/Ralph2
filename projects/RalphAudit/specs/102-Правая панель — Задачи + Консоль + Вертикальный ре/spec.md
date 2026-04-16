# Спринт 102: Правая панель — Задачи + Консоль + Вертикальный ресайзер

## Команда запуска для Ralph Runner
`claude -p "Прочитай этот файл (specs/102-Правая панель — Задачи + Консоль + Вертикальный ре/spec.md). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам из claude.md и применяй глобальные навыки (TDD, Debugging). ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md и корневой tasks.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>, а затем напиши блок <report>...</report>, внутри которого должен быть только строгий JSON с ключами: 'exact_task_name' (в точности скопируй строку задачи из файла), 'summary' (подробное описание того, что сделано), 'skills_used' (массив названий навыков, которые ты применил)."`

## Ссылки на контекст
- [Планирование](../../planning.md)
- [Правила](../../CLAUDE.md)
- [PRD](../../PRD.md)

## Tasks

- [x] {{TASK:102.1}} Добавить заголовок проекта в верхнюю часть правой панели
  **ПОДРОБНОСТИ:**
  - **Что сделать:** В `.right-panel` добавить `<div class="right-header">` с названием текущего активного проекта и кнопкой "+ Идея".
  - **Как сделать:**
    1. HTML: `<div class="right-header" id="rightHeader"><h2 id="rightProjectName">Выберите проект</h2><button class="idea-btn" onclick="showIdeaDialog()">+ Идея</button></div>`
    2. CSS: `.right-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }`
    3. В `refresh()`: `document.getElementById('rightProjectName').textContent = activeProject?.name || 'Выберите проект';` — обновлять название при смене проекта.
    4. Перенести кнопку "+ Идея" из `.card-header` задач сюда.
  - **Ограничения:** Не дублировать название — оно только в правой панели.
  - **Критерии приёмки:** При выборе проекта слева — название обновляется в заголовке справа. Кнопка "+ Идея" работает.
- [x] {{TASK:102.2}} Переместить секцию задач и консоль в правую панель с вертикальным ресайзером
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Перенести `<div id="tasksBody">` и `<div id="consoleWrapper">` в `.right-panel`. Добавить `<div class="v-resizer">` между ними. Оба блока должны делить правую панель ~50/50 по высоте.
  - **Как сделать:**
    1. HTML-структура правой панели:
       ```html
       <div class="right-panel">
           <div class="right-header">...</div>
           <div class="right-content" id="rightContent">
               <div class="tasks-pane" id="tasksPane">
                   <div id="tasks" style="overflow-y: auto; height: 100%; padding: 16px;"></div>
               </div>
               <div class="v-resizer" id="vResizer"></div>
               <div class="console-pane" id="consolePane">
                   <div class="console-header" onclick="toggleConsoleCollapse()">
                       <div style="display:flex; align-items:center; gap:10px;">
                           <span id="consoleArrow">▾</span>
                           <h3>Консоль</h3>
                           <span class="console-tab active" id="tab4">RALPH 4</span>
                       </div>
                       <div onclick="event.stopPropagation()">
                           <button class="btn-small" onclick="clearConsole()">Очистить</button>
                           <button class="btn-small" onclick="saveConsole()">Сохранить</button>
                       </div>
                   </div>
                   <div id="consoleBody">
                       <div id="consoleStatusContainer">...</div>
                       <div id="console" class="live-console"></div>
                   </div>
               </div>
           </div>
       </div>
       ```
    2. CSS: `.right-content { display: flex; flex-direction: column; flex: 1; overflow: hidden; }` `.tasks-pane { flex: 1; overflow-y: auto; }` `.console-pane { flex: 1; display: flex; flex-direction: column; }` `.live-console { flex: 1; height: auto; }`
    3. `.v-resizer { height: 6px; cursor: row-resize; background: var(--border); flex-shrink: 0; }` `.v-resizer:hover, .v-resizer.dragging { background: var(--blue); }`
    4. JS drag-логика аналогично горизонтальному ресайзеру: `mousedown` → `mousemove` → пересчёт `flex-basis` для `.tasks-pane` и `.console-pane`. Сохранение в `localStorage.setItem('ralph_vSplit', topPercent)`.
    5. Минимальная высота каждой панели: 100px.
  - **Ограничения:** ID элементов `console`, `consoleStatus`, `consoleStatusContainer`, `consoleWrapper` — НЕ менять, чтобы не ломать JS-логику обновления консоли. Если надо переименовать `consoleWrapper` в `consoleBody`, обновить все ссылки в JS.
  - **Критерии приёмки:** Задачи и консоль делят правую панель пополам. Drag вертикального ресайзера меняет пропорции. После F5 — пропорции восстановлены. Консоль автоскроллится корректно.
- [x] {{TASK:102.3}} Реализовать сворачивание консоли кликом на заголовок
  **ПОДРОБНОСТИ:**
  - **Что сделать:** Клик на "Консоль" в заголовке консоли → toggle скрытия/показа тела консоли. При скрытии задачи занимают всё пространство.
  - **Как сделать:**
    1. JS функция `toggleConsoleCollapse()`:
       ```javascript
       function toggleConsoleCollapse() {
           const body = document.getElementById('consoleBody');
           const resizer = document.getElementById('vResizer');
           const arrow = document.getElementById('consoleArrow');
           const pane = document.getElementById('consolePane');
           const isCollapsed = body.style.display === 'none';
           body.style.display = isCollapsed ? 'flex' : 'none';
           resizer.style.display = isCollapsed ? 'block' : 'none';
           arrow.textContent = isCollapsed ? '▾' : '▸';
           pane.style.flex = isCollapsed ? '' : '0 0 auto';
           localStorage.setItem('ralph_consoleCollapsed', isCollapsed ? '0' : '1');
       }
       ```
    2. При загрузке: проверить `localStorage.getItem('ralph_consoleCollapsed')` и применить состояние.
  - **Ограничения:** Обновление данных консоли (setInterval) должно продолжаться даже когда свёрнута — просто не видно.
  - **Критерии приёмки:** Клик на "Консоль" → консоль сворачивается, задачи занимают всё пространство. Повторный клик → консоль разворачивается. Состояние сохраняется между перезагрузками.

## Критерии завершения
- [ ] Все 3 невыполненных задач реализованы и протестированы.
- [ ] Файл `tasks.md` обновлен (поставлены [x] для завершенных пунктов).
