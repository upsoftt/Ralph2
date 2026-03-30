# Инструкция: установка Ralph + TrayConsole + PortWatcher на новом компьютере

## Предварительные требования

На новом компьютере должны быть установлены:

1. **Git** — https://git-scm.com/download/win
2. **Python 3.11+** — https://www.python.org/downloads/ (добавить в PATH при установке)
3. **Node.js 18+** — https://nodejs.org/ (LTS версия)
4. **.NET 8 SDK** — https://dotnet.microsoft.com/download/dotnet/8.0
5. **Claude Code CLI** — `npm install -g @anthropic-ai/claude-code`

---

## Шаг 1: Клонирование репозиториев

Открой терминал и выполни:

```bash
cd D:\MyProjects

git clone https://github.com/upsoftt/TrayConsole.git
git clone https://github.com/upsoftt/Ralph2.git
git clone https://github.com/upsoftt/PortWatcher.git
git clone https://github.com/upsoftt/skills.git
```

Итоговая структура:
```
D:\MyProjects\
├── TrayConsole\
├── Ralph2\
├── PortWatcher\
└── skills\
```

---

## Шаг 2: Сборка TrayConsole

```bash
cd D:\MyProjects\TrayConsole
dotnet publish src\TrayConsole\TrayConsole.csproj -c Release -o .
```

После сборки в корне появится `TrayConsole.exe`.

**Запуск:** дважды кликни `TrayConsole.exe` — в системном трее появится иконка.

---

## Шаг 3: Установка зависимостей Ralph2

### Node.js зависимости (для overseer):

```bash
cd D:\MyProjects\Ralph2
npm install
```

Это установит `node-pty` и `strip-ansi`.

### Python зависимости (опционально, для трея):

```bash
pip install pystray pillow pywin32
```

---

## Шаг 4: Установка зависимостей PortWatcher

```bash
pip install psutil pystray pillow pywin32
```

---

## Шаг 5: Настройка скиллов Claude Code

Создай символическую ссылку (запусти PowerShell от админа):

```powershell
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.claude\skills" -Target "D:\MyProjects\skills"
```

Если папка `~/.claude/` не существует — создай:
```powershell
mkdir "$env:USERPROFILE\.claude" -Force
```

---

## Шаг 6: Регистрация проектов в TrayConsole

TrayConsole хранит список проектов в `%LOCALAPPDATA%\TrayConsole\registry.json`.

Создай этот файл:

```powershell
$dir = "$env:LOCALAPPDATA\TrayConsole"
mkdir $dir -Force

@'
{
  "projects": [
    "D:\\MyProjects\\Ralph2",
    "D:\\MyProjects\\PortWatcher"
  ]
}
'@ | Out-File -Encoding utf8 "$dir\registry.json"
```

Можешь добавить и другие проекты позже.

---

## Шаг 7: Запуск

### 1. Запусти TrayConsole:
```bash
D:\MyProjects\TrayConsole\TrayConsole.exe
```

В трее появится иконка. Правый клик покажет меню с зарегистрированными проектами.

### 2. Запусти Ralph (веб-сервер):

Через TrayConsole: правый клик на иконку → **Web Server Ralph** → **Start**

Или вручную:
```bash
cd D:\MyProjects\Ralph2
python ralph-tracker-web.py
```

Дашборд откроется на http://localhost:8767

### 3. Запусти PortWatcher:

Через TrayConsole: правый клик → **PortWatcher** → **Start**

Или вручную:
```bash
cd D:\MyProjects\PortWatcher
pythonw port_watcher.py
```

---

## Шаг 8: Настройка Ralph Loop

Ralph Loop запускается из Claude Code через скилл `/ralph-runloop`.

1. Открой Claude Code в папке любого проекта, который хочешь запустить через Ralph
2. Убедись, что проект добавлен в `D:\MyProjects\Ralph2\projects.json`
3. У проекта должны быть `tasks.md` и папка `specs/`
4. Запусти: `/ralph-runloop`

### Добавление проекта в Ralph:

В `D:\MyProjects\Ralph2\projects.json` добавь запись:

```json
{
  "id": "my-project",
  "name": "Название проекта",
  "path": "D:\\MyProjects\\MyProject"
}
```

Или используй скилл `/ralph-add-project` из Claude Code в папке проекта.

---

## Шаг 9: Настройка CLAUDE.md (глобальный)

Скопируй глобальный `CLAUDE.md` на новый компьютер:

**Файл:** `%USERPROFILE%\.claude\CLAUDE.md`

Содержимое — правила для агента (запрет на массовое убийство процессов, правила пересборки, захват порта и т.д.). Скопируй его с текущего компьютера.

---

## Шаг 10: Настройка автозапуска TrayConsole (опционально)

Чтобы TrayConsole запускался при входе в Windows:

```powershell
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\TrayConsole.lnk")
$shortcut.TargetPath = "D:\MyProjects\TrayConsole\TrayConsole.exe"
$shortcut.WorkingDirectory = "D:\MyProjects\TrayConsole"
$shortcut.Save()
```

---

## Проверка работоспособности

1. **TrayConsole** — иконка в трее, правый клик показывает меню с Ralph и PortWatcher
2. **Ralph веб-сервер** — http://localhost:8767 открывает дашборд с 3 колонками
3. **PortWatcher** — окно со списком портов и процессов
4. **Ralph Loop** — в Claude Code `/ralph-runloop` запускает автономное выполнение задач

---

## Репозитории

| Проект | URL |
|--------|-----|
| Ralph2 | https://github.com/upsoftt/Ralph2.git |
| TrayConsole | https://github.com/upsoftt/TrayConsole.git |
| PortWatcher | https://github.com/upsoftt/PortWatcher.git |
| Skills | https://github.com/upsoftt/skills.git |

---

## Порты

| Сервис | Порт |
|--------|------|
| Ralph веб-дашборд | 8767 |

## Named Pipes (TrayConsole IPC)

| Компонент | Pipe |
|-----------|------|
| Ralph2 | trayconsole_ralph2 |
| PortWatcher | trayconsole_portwatcher |
