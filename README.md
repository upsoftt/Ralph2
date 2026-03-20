# Ralph 2.0

Autonomous AI task runner with web dashboard. Manages Claude Code / Gemini CLI to execute project tasks from spec files.

## Components

- **ralph-tracker-web.py** — Web server + dashboard (port 8767)
- **ralph-overseer.js** — PTY-based overseer that drives Claude Code through tasks
- **agents.js** — Agent configuration (Claude, Gemini)
- **ralph-tray.py** — System tray icon (Windows)
- **spec-converter-fixed.ps1** — Generates spec files from tasks.md

## Quick Start

```bash
# Install Node.js dependencies
npm install

# Start web dashboard
python ralph-tracker-web.py

# Or start via system tray
python ralph-tray.py
```

## Requirements

- Python 3.11+
- Node.js 18+
- Claude Code CLI (`claude`)
- Windows 10+ (uses WinAPI via ctypes)

### Python packages
- `pystray` (for tray icon)
- `Pillow` (for tray icon drawing)

### Node.js packages
- `node-pty` — PTY spawning
- `strip-ansi` — ANSI code removal

## How It Works

1. Add projects via web dashboard or `/ralph-add-project` skill
2. Each project has `tasks.md` with sprints and tasks
3. Run `spec-converter-fixed.ps1` to generate `specs/` from `tasks.md`
4. Click Play in dashboard — overseer spawns Claude Code and feeds tasks one by one
5. Claude Code executes each task, reports results via RALPH_RESULT protocol
6. Dashboard shows live console, task progress, and execution results

## Platform

Windows-only. Uses `ctypes.windll` for process management, `node-pty` with ConPTY.
