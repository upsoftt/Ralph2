# Промт для Claude Code на новом компьютере

Скопируй всё ниже и вставь в Claude Code, открытый в папке D:\MyProjects:

---

Мне нужно настроить рабочее окружение. Репозитории уже склонированы в D:\MyProjects\:
- Ralph2 (веб-сервер дашборд, порт 8767)
- TrayConsole (системный трей, .NET 8)
- PortWatcher (мониторинг портов, Python)
- skills (скиллы для Claude Code)

Выполни по порядку:

1. **Сборка TrayConsole:**
   ```
   cd D:\MyProjects\TrayConsole
   dotnet publish src\TrayConsole\TrayConsole.csproj -c Release -o .
   ```

2. **Зависимости Ralph2:**
   ```
   cd D:\MyProjects\Ralph2
   npm install
   ```

3. **Python-зависимости** (для PortWatcher и трея):
   ```
   pip install psutil pystray pillow pywin32
   ```

4. **Симлинк скиллов** (PowerShell от админа):
   ```
   New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\skills" -Target "D:\MyProjects\skills"
   ```
   Если папка ~/.claude/ не существует — создай. Если симлинк уже есть — пропусти.

5. **Регистрация проектов в TrayConsole:**
   ```
   cd D:\MyProjects\TrayConsole
   powershell -ExecutionPolicy Bypass -File register-projects.ps1
   ```

6. **Скопируй глобальный CLAUDE.md** — возьми файл D:\MyProjects\Ralph2\CLAUDE.md как образец формата. Создай файл %USERPROFILE%\.claude\CLAUDE.md со следующим содержимым:

```markdown
# Глобальные правила для всех проектов

## ЗАПРЕТ НА МАССОВОЕ УБИЙСТВО ПРОЦЕССОВ (КРИТИЧЕСКОЕ)
- ЗАПРЕЩЕНО убивать процессы по имени образа: taskkill /IM node.exe, taskkill /IM python.exe, killall node, pkill node и т.д.
- Разрешено убивать ТОЛЬКО по конкретному PID, который ты сам запустил в текущей сессии.

## ОБЯЗАТЕЛЬНАЯ ПЕРЕСБОРКА И ПЕРЕЗАПУСК ПОСЛЕ ИЗМЕНЕНИЙ (КРИТИЧЕСКОЕ)
- Если ты изменил код, который требует пересборки (build), перекомпиляции или перезапуска сервиса — ты ОБЯЗАН выполнить это сам, не спрашивая пользователя.

## ЗАХВАТ ПОРТА ПРИ СТАРТЕ СЕРВИСА (КРИТИЧЕСКОЕ)
- Любой сервис, который слушает на порту, ОБЯЗАН при старте проверить, свободен ли порт, и убить старый процесс по PID если занят.
- ЗАПРЕЩЕНО стартовать на соседнем порту.

## РЕДАКТИРОВАНИЕ СКИЛЛОВ (КРИТИЧЕСКОЕ)
- Скиллы физически хранятся в D:\MyProjects\skills\, симлинк ~/.claude/skills используется только для обнаружения.
- Для ЛЮБОГО редактирования скиллов используй путь D:/MyProjects/skills/<skill-name>/SKILL.md.
```

7. **Запуск — проверь что всё работает:**
   - Запусти TrayConsole: `start D:\MyProjects\TrayConsole\TrayConsole.exe`
   - Запусти Ralph: `cd D:\MyProjects\Ralph2 && python ralph-tracker-web.py`
   - Проверь что http://localhost:8767 открывается
   - Запусти PortWatcher через TrayConsole (правый клик → PortWatcher → Start)

8. **Пути в projects.json** — проверь файл D:\MyProjects\Ralph2\projects.json. Пути проектов должны соответствовать реальным путям на ЭТОМ компьютере. Если проекты лежат не в D:\MyProjects\ — обнови пути.

После выполнения всех шагов сообщи что готово и какие проекты зарегистрированы в TrayConsole.
