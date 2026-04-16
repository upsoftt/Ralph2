# Sprint 4 : UX Polish & Performance

## Context

Read planning.md and GEMINI.md before starting.

### Links

- [Planning](../planning.md)
- [Guidelines](../GEMINI.md)
- [PRD](../PRD.md)

## ⚡ Архитектурные правила и Тестирование (ОБЯЗАТЕЛЬНО)
* **UI и Рендеринг:** ВСЕ визуальные изменения должны проверяться через E2E-тесты (Playwright) или Agent-Browser. Юнит-тестов логики недостаточно.
* **Темы оформления:** ЗАПРЕЩАЕТСЯ хардкодить цвета (например, bg-gray-950), используйте адаптивные классы (dark:...) или CSS-переменные.
* **Zustand/Redux:** ЗАПРЕЩАЕТСЯ использовать геттеры внутри стора для производных данных. Используйте useMemo в хуках.

## Tasks

- [x] {{TASK:4.1}} Native Micro-animations (CSS + Web Animations API).
  ПОДРОБНОСТИ: Плавное перемещение элементов списка вверх при удалении одного из них (layout transitions). Используй CSS Transitions для эффектов наведения и появления.
- [x] {{TASK:4.2}} Accessibility & Hotkeys.
  ПОДРОБНОСТИ: Полная навигация табом. Горячие клавиши: Ctrl+F (поиск), Del (удаление выделенной). Приложение должно быть полностью доступно с клавиатуры.
- [x] {{TASK:4.3}} **ULTRA-ВЕРИФИКАЦИЯ:** QA & Performance.
  ПОДРОБНОСТИ: 1. Проверка на 100 задачах. 2. Тест Undo. 3. Тест мобильной верстки. 4. Валидация Lighthouse (Accessibility > 90).

## Completion

- [ ] All 3 tasks completed

**Output:** `<promise>DONE</promise>`




