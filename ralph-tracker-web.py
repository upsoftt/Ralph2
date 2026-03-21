#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Ralph 2.0 — Progress Tracker & Task Runner"""

import os
import sys
import json
import re
import time
import subprocess
from datetime import datetime
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import ctypes
import shutil
import webbrowser
_claude_exe = os.environ.get('CLAUDE_EXE') or shutil.which('claude') or r"C:\Users\upsof\.local\bin\claude.exe"

try:
    from trayconsole_client import TrayConsoleClient
    _trayconsole_available = True
except ImportError:
    _trayconsole_available = False

def _is_process_alive(pid):
    """Windows-safe проверка: жив ли процесс по PID (без os.kill, который убивает на Windows)."""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if handle:
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    return False

# --- ЛОГИРОВАНИЕ В ФАЙЛ И КОНСОЛЬ ОДНОВРЕМЕННО ---
class Tee(object):
    def __init__(self, *files):
        self.files = files
    def write(self, obj):
        for f in self.files:
            try:
                f.write(obj)
                f.flush()
            except: pass
    def flush(self):
        for f in self.files:
            try: f.flush()
            except: pass

# Ротация лога: если >5MB — переименовать в .old
log_path = Path(__file__).parent / "web_server.log"
if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
    old_path = log_path.with_suffix('.old')
    try: old_path.unlink(missing_ok=True); log_path.rename(old_path)
    except: pass
log_file = open(log_path, "a", encoding="utf-8")

# Подменяем стандартные потоки
sys.stdout = Tee(sys.stdout, log_file)
sys.stderr = Tee(sys.stderr, log_file)

print(f"\n--- СЕССИЯ ЗАПУЩЕНА: {datetime.now()} ---")

# Configuration
RALPH_DIR = Path(__file__).parent
WEB_PORT = 8767

PROJECTS_FILE = RALPH_DIR / "projects.json"
_projects_cache = []
_projects_mtime = 0

def load_projects():
    """Загружает проекты из projects.json, перечитывая файл только при изменении."""
    global _projects_cache, _projects_mtime
    try:
        mtime = os.path.getmtime(PROJECTS_FILE)
        if mtime != _projects_mtime:
            with open(PROJECTS_FILE, 'r', encoding='utf-8-sig') as f:
                _projects_cache = json.load(f)
            # Нормализуем разделители путей
            for proj in _projects_cache:
                for key in ('path', 'history_file', 'specs_dir'):
                    if key in proj and isinstance(proj[key], str):
                        proj[key] = os.path.normpath(proj[key])
            _projects_mtime = mtime
            print(f"[projects] Загружено {len(_projects_cache)} проектов из projects.json")
    except Exception as e:
        print(f"[projects] Ошибка загрузки projects.json: {e}")
        if not _projects_cache:
            _projects_cache = []
    return _projects_cache

# Первоначальная загрузка
PROJECTS = load_projects()

STATE_FILE = RALPH_DIR / "tracker_state.json"
ACTIVE_PROJECT_ID = None
try:
    if STATE_FILE.exists():
        ACTIVE_PROJECT_ID = json.loads(STATE_FILE.read_text(encoding='utf-8')).get("active_id")
except: pass

BUSY_PROJECTS = {}
BUSY_STATE_FILE = RALPH_DIR / "busy_state.json"
LAUNCHED_PROCESSES = {}  # project_id -> subprocess.Popen
LAUNCH_STATE_FILE = RALPH_DIR / "launch_state.json"

def _save_busy_state():
    """Сохраняет BUSY статусы на диск."""
    try:
        BUSY_STATE_FILE.write_text(json.dumps(BUSY_PROJECTS), encoding='utf-8')
    except: pass

def _count_tasks_in_file(filepath):
    """Считает (done, total) задачи в секции ## Tasks файла spec.md."""
    done = 0; total = 0
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as fp:
            in_tasks_section = False
            for ln in fp:
                if '## Tasks' in ln:
                    in_tasks_section = True
                    continue
                if in_tasks_section and ln.strip().startswith('##'):
                    in_tasks_section = False
                if in_tasks_section:
                    stripped = ln.strip()
                    if stripped.startswith('- [x]') or stripped.startswith('- [X]'):
                        done += 1; total += 1
                    elif stripped.startswith('- [ ]'):
                        total += 1
    except: pass
    return done, total

def _restore_busy_state():
    """Очищает BUSY статусы при старте — фоновые операции не переживают рестарт."""
    global BUSY_PROJECTS
    BUSY_PROJECTS = {}
    if BUSY_STATE_FILE.exists():
        try:
            BUSY_STATE_FILE.unlink()
        except: pass

_restore_busy_state()

def _save_launch_state():
    """Сохраняет PID запущенных приложений на диск."""
    state = {}
    for pid, proc in list(LAUNCHED_PROCESSES.items()):
        if proc.poll() is None:
            state[pid] = proc.pid
    try:
        LAUNCH_STATE_FILE.write_text(json.dumps(state), encoding='utf-8')
    except: pass

def _restore_launch_state():
    """Восстанавливает информацию о запущенных приложениях после перезапуска сервера."""
    if not LAUNCH_STATE_FILE.exists():
        return
    try:
        state = json.loads(LAUNCH_STATE_FILE.read_text(encoding='utf-8'))
        for project_id, pid in state.items():
            if _is_process_alive(pid):
                LAUNCHED_PROCESSES[project_id] = _PidHandle(pid)
    except: pass

class _PidHandle:
    """Обёртка для отслеживания процесса по PID (после перезапуска сервера)."""
    def __init__(self, pid):
        self.pid = pid
    def poll(self):
        if _is_process_alive(self.pid):
            return None  # Жив
        return 1  # Мёртв

_restore_launch_state()
import queue as _queue
import threading as _threading
_file_lock = _threading.Lock()
import hashlib as _hashlib
import socket as _socket
_idea_queues = {}  # project_id -> queue.Queue
_idea_workers = {}  # project_id -> Thread

def _generate_port(project_id):
    """Генерирует уникальный порт для проекта на основе хеша id (диапазон 8100-9899)."""
    h = int(_hashlib.md5(project_id.encode()).hexdigest()[:8], 16)
    return 8100 + (h % 1800)

def _kill_port(port):
    """Убивает процесс, занимающий указанный порт (Windows)."""
    try:
        result = subprocess.run(
            f'netstat -ano | findstr ":{port} "',
            shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace'
        )
        pids = set()
        for line in result.stdout.strip().split('\n'):
            line = line.strip()
            if not line:
                continue
            # Ищем LISTENING или ESTABLISHED на нужном порту
            parts = line.split()
            if len(parts) >= 5:
                local_addr = parts[1]
                if f':{port}' in local_addr:
                    pid = parts[-1]
                    if pid.isdigit() and int(pid) > 0:
                        pids.add(pid)
        for pid in pids:
            print(f"[PORT] Убиваю процесс PID {pid} на порту {port}")
            subprocess.run(f'taskkill /F /T /PID {pid}', shell=True, capture_output=True)
    except Exception as e:
        print(f"[PORT] Ошибка при освобождении порта {port}: {e}")

def _extract_port_from_str(s):
    """Извлекает номер порта из строки (команды или URL)."""
    # Паттерн: -p 8090, --port 8090, -P 8090, :3000, localhost:3000
    m = re.search(r'(?:-[pP]|--port)\s+(\d{4,5})', s)
    if m:
        return int(m.group(1))
    m = re.search(r'localhost:(\d{4,5})', s)
    if m:
        return int(m.group(1))
    m = re.search(r'127\.0\.0\.1:(\d{4,5})', s)
    if m:
        return int(m.group(1))
    return None
def save_projects_to_disk():
    """Сохраняет текущий список проектов в projects.json."""
    global _projects_mtime
    try:
        with open(PROJECTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(PROJECTS, f, ensure_ascii=False, indent=4)
        _projects_mtime = os.path.getmtime(PROJECTS_FILE)
        print(f"[projects] Сохранено {len(PROJECTS)} проектов в projects.json")
        return True
    except Exception as e:
        print(f"Error saving projects: {e}")
        return False

def get_active_project():
    projects = load_projects()
    for proj in projects:
        if proj["id"] == ACTIVE_PROJECT_ID: return proj
    return projects[0] if projects else None

def _load_launch_config(p_path):
    """Загрузить launch.json или авто-определить конфигурацию запуска."""
    p_path = Path(p_path)
    launch_file = p_path / "launch.json"
    if launch_file.exists():
        try:
            cfg = json.loads(launch_file.read_text(encoding='utf-8'))
            # Если launch.json — массив шагов, обернуть в объект
            if isinstance(cfg, list):
                cfg = {"description": "", "steps": cfg}
            # Поддержка нового формата (steps) и старого (type/command)
            if 'steps' in cfg:
                return cfg
            # Конвертируем старый формат в новый
            step = {"type": cfg.get("type", "command"), "label": cfg.get("description", "")}
            if cfg.get("type") == "open":
                step["url"] = cfg.get("command", "")
            else:
                step["command"] = cfg.get("command", "")
                if cfg.get("type") == "web" or cfg.get("type") == "command":
                    step["type"] = "shell"
            return {"description": cfg.get("description", ""), "steps": [step]}
        except Exception as e:
            print(f"Error loading launch.json: {e}")
    # Авто-определение
    if (p_path / "index.html").exists():
        return {"description": "Открыть в браузере", "steps": [{"type": "open", "url": "index.html", "label": "Открыть в браузере"}]}
    if (p_path / "package.json").exists():
        try:
            pkg = json.loads((p_path / "package.json").read_text(encoding='utf-8'))
            steps = []
            if (p_path / "node_modules").exists() is False:
                steps.append({"type": "command", "command": "npm install", "wait": True, "label": "Установка зависимостей"})
            if pkg.get("scripts", {}).get("build"):
                steps.append({"type": "command", "command": "npm run build", "wait": True, "label": "Сборка"})
            if pkg.get("scripts", {}).get("start"):
                steps.append({"type": "shell", "command": "npm start", "label": "Запуск"})
            elif pkg.get("scripts", {}).get("dev"):
                steps.append({"type": "shell", "command": "npm run dev", "label": "Запуск (dev)"})
            if steps:
                return {"description": "Node.js приложение", "steps": steps}
        except: pass
    if (p_path / "main.py").exists():
        return {"description": "Python приложение", "steps": [{"type": "shell", "command": "python main.py", "label": "Запуск"}]}
    if (p_path / "app.py").exists():
        return {"description": "Python приложение", "steps": [{"type": "shell", "command": "python app.py", "label": "Запуск"}]}
    return None

def _execute_launch(project_id, p_path, launch_config):
    """Выполнить цепочку шагов запуска проекта."""
    p_path = Path(p_path)
    steps = launch_config.get("steps", [])
    if not steps:
        return

    def run_steps():
        for i, step in enumerate(steps):
            stype = step.get("type", "command")
            label = step.get("label", f"Шаг {i+1}")
            print(f"[LAUNCH] {project_id}: {label}")

            if stype == "open":
                # Открыть файл или URL
                delay = step.get("delay", 0)
                if delay:
                    time.sleep(delay)
                url = step.get("url", "")
                if url.startswith("http"):
                    import webbrowser
                    webbrowser.open(url)
                else:
                    target = p_path / url
                    os.startfile(str(target))

            elif stype == "command":
                # Выполнить команду и дождаться завершения
                cmd = step.get("command", "")
                wait = step.get("wait", True)
                try:
                    proc = subprocess.run(
                        cmd, shell=True, cwd=str(p_path),
                        capture_output=True, text=True, timeout=300,
                        encoding='utf-8', errors='replace'
                    )
                    if proc.returncode != 0:
                        print(f"[LAUNCH] {label} failed (exit {proc.returncode}): {proc.stderr[:200] if proc.stderr else ''}")
                except subprocess.TimeoutExpired:
                    print(f"[LAUNCH] {label} timed out")

            elif stype == "shell":
                # Запустить в новом окне терминала (для серверов)
                cmd = step.get("command", "")
                # Проверяем порт — если занят, убиваем процесс на нём
                port = _extract_port_from_str(cmd)
                if port:
                    _kill_port(port)
                proc = subprocess.Popen(
                    f'cmd.exe /k "{cmd}"',
                    cwd=str(p_path),
                    creationflags=subprocess.CREATE_NEW_CONSOLE
                )
                # Храним список процессов (может быть фронт+бэк)
                if project_id not in LAUNCHED_PROCESSES or not isinstance(LAUNCHED_PROCESSES[project_id], list):
                    LAUNCHED_PROCESSES[project_id] = []
                LAUNCHED_PROCESSES[project_id].append(proc)
                _save_launch_state()

    _threading.Thread(target=run_steps, daemon=True).start()

def update_status():
    global PROJECTS
    PROJECTS = load_projects()
    active_proj = get_active_project()
    status_list = []
    for proj in PROJECTS:
        total = 0; done = 0
        
        # FIX: Avoid pathlib here due to SystemError in multi-threaded contexts on Windows
        try:
            specs_path = str(proj.get("specs_dir", ""))
            if specs_path and os.path.exists(specs_path):
                for root, dirs, files in os.walk(specs_path):
                    for file in files:
                        if file == "spec.md":
                            sf = os.path.join(root, file)
                            d, t = _count_tasks_in_file(sf)
                            done += d; total += t
        except: pass
        running = False
        paused = False
        running_version = "v4"
        p_stat_file = os.path.join(str(proj.get("path", "")), ".ralph-runner", "status.json")
        if os.path.exists(p_stat_file):
            try:
                with open(p_stat_file, 'r', encoding='utf-8') as sf:
                    data = json.loads(sf.read())
                target_pid = data.get('pid')
                paused = data.get('paused', False)
                running_version = data.get('version', 'v4')
                if data.get('running') and target_pid:
                    # Уровень 3: проверяем heartbeat — если старше 15 сек, процесс мёртв
                    heartbeat = data.get('heartbeat')
                    heartbeat_stale = False
                    if heartbeat:
                        try:
                            from datetime import timezone
                            hb_time = datetime.fromisoformat(heartbeat.replace('Z', '+00:00'))
                            now_utc = datetime.now(timezone.utc)
                            heartbeat_stale = (now_utc - hb_time).total_seconds() > 15
                        except: pass

                    if heartbeat_stale:
                        # Heartbeat устарел — процесс точно мёртв
                        running = False
                    elif _is_process_alive(target_pid):
                        running = True
                    else:
                        # PID мёртв — ищем процесс по командной строке (fallback)
                        try:
                            import subprocess as _sp
                            result = _sp.run(
                                ['wmic', 'process', 'where', "name='node.exe'", 'get', 'processid,commandline'],
                                capture_output=True, text=True, timeout=5
                            )
                            proj_path_str = str(proj.get("path", ""))
                            for line in result.stdout.split('\n'):
                                if 'ralph-overseer' in line and proj_path_str.replace('\\', '/') in line.replace('\\', '/'):
                                    running = True
                                    break
                        except:
                            running = False

                    # Уровень 2: если процесс мёртв — очищаем status.json автоматически
                    if not running and data.get('running'):
                        try:
                            with open(p_stat_file, 'w', encoding='utf-8') as wf:
                                wf.write(json.dumps({"running": False, "version": "v4"}, indent=2))
                            print(f"[auto-cleanup] Очищен status.json для {proj.get('name', '?')} (PID {target_pid} мёртв)")
                        except: pass
            except: pass
        # Launch info
        all_done = total > 0 and done == total
        p_path_obj = Path(proj["path"])
        launch_config = _load_launch_config(p_path_obj)
        launch_running = False
        if proj["id"] in LAUNCHED_PROCESSES:
            procs = LAUNCHED_PROCESSES[proj["id"]]
            if isinstance(procs, list):
                launch_running = any(p.poll() is None for p in procs)
            else:
                launch_running = procs.poll() is None
        status_list.append({"id": proj["id"], "name": proj["name"], "path": str(proj["path"]), "total": total, "completed": done, "active": proj["id"] == ACTIVE_PROJECT_ID, "running": running, "paused": paused, "busy": BUSY_PROJECTS.get(proj["id"], False), "running_version": running_version, "launch_available": launch_config is not None and all_done, "launch_description": launch_config.get("description", "") if launch_config else "", "launch_running": launch_running})
    spec_details = {}
    if active_proj:
        try:
            specs_dir = active_proj.get("specs_dir", "")
            if specs_dir and os.path.exists(specs_dir):
                for dirname in sorted(os.listdir(specs_dir)):
                    sdir = os.path.join(specs_dir, dirname)
                    if os.path.isdir(sdir):
                        sf = os.path.join(sdir, "spec.md")
                        if os.path.exists(sf):
                            try:
                                with open(sf, 'r', encoding='utf-8', errors='ignore') as fpp:
                                    c = fpp.read()
                                tasks = []
                                in_tasks = False
                                for ln in c.split('\n'):
                                    if '## Tasks' in ln: 
                                        in_tasks = True
                                        continue
                                    if in_tasks and ln.strip().startswith('##'): 
                                        in_tasks = False
                                    if in_tasks:
                                        stripped = ln.strip()
                                        if stripped.startswith(('- [ ]', '- [x]')):
                                            tasks.append({"done": '- [x]' in stripped, "text": stripped[6:].strip(), "description": ""})
                                        elif tasks and stripped:
                                            clean_line = re.sub(r'^ПОДРОБНОСТИ:\s*', '', stripped)
                                            if clean_line:
                                                if tasks[-1]["description"]: tasks[-1]["description"] += " "
                                                tasks[-1]["description"] += clean_line
                                spec_details[dirname] = {"tasks": tasks, "completed": sum(1 for t in tasks if t["done"]), "total": len(tasks)}
                            except: pass
        except: pass

    console_visible = False
    try:
        console_visible = (RALPH_DIR / ".ralph-runner" / "console_state").read_text(encoding='utf-8').strip() == "visible"
    except: pass

    return {"projects": status_list, "spec_details": spec_details, "active_id": ACTIVE_PROJECT_ID, "console_visible": console_visible}

class Handler(BaseHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass

    def do_GET(self):
        global PROJECTS
        PROJECTS = load_projects()
        p = urlparse(self.path)
        if p.path == "/":
            self.send_response(200); self.send_header("Content-type", "text/html; charset=utf-8"); self.end_headers()
            self.wfile.write(get_dashboard_html().encode('utf-8'))
        elif p.path == "/api": self.send_json(update_status())
        elif p.path == "/api/stream":
            project = get_active_project()
            if not project: self.send_json({"success": False, "content": ""}); return
            r_dir = Path(project["path"]) / ".ralph-runner"
            content4 = (r_dir / "live_console_4.log").read_text(encoding='utf-8', errors='replace') if (r_dir / "live_console_4.log").exists() else ""
            status4 = (r_dir / "thinking_status.txt").read_text(encoding='utf-8', errors='replace').strip() if (r_dir / "thinking_status.txt").exists() else ""
            self.send_json({"success": True, "content4": content4, "status4": status4})
        elif p.path == "/api/crash-log":
            project = get_active_project()
            if not project: self.send_json({"success": False, "content": "No active project"}); return
            log_file = Path(project["path"]) / ".ralph-runner" / "crash.log"
            content = log_file.read_text(encoding='utf-8', errors='replace') if log_file.exists() else "Ошибок не найдено (crash.log пуст)."
            self.send_json({"success": True, "content": content})
        elif p.path == "/api/server-log":
            log_file = RALPH_DIR / "web_server.log"
            content = log_file.read_text(encoding='utf-8', errors='replace') if log_file.exists() else "Файл логов веб-сервера пуст или не существует."
            self.send_json({"success": True, "content": content})
        elif p.path == "/api/task-report":
            qs = parse_qs(p.query)
            pid = qs.get('project', [''])[0]
            tid = qs.get('task_id', [''])[0].replace('.', '_')
            proj = next((pr for pr in PROJECTS if pr['id'] == pid), None)
            if proj:
                report_path = Path(proj['path']) / ".ralph-runner" / "results" / f"{tid}.json"
                if report_path.exists():
                    try:
                        data = json.loads(report_path.read_text(encoding='utf-8'))
                        summary = data.get('summary', data.get('result', 'No summary available.'))
                        self.send_json({"success": True, "summary": summary})
                        return
                    except: pass
            self.send_json({"success": False})
        elif p.path == "/api/launch-info":
            qs = parse_qs(p.query)
            pid = qs.get('project', [None])[0]
            proj = next((pr for pr in PROJECTS if pr['id'] == pid), None) if pid else get_active_project()
            if not proj:
                self.send_json({"available": False, "allDone": False})
                return
            p_path = Path(proj['path'])
            # Check if all tasks are done
            total = 0; done = 0
            specs_path = str(proj.get("specs_dir", ""))
            if specs_path and os.path.exists(specs_path):
                for root, dirs, files in os.walk(specs_path):
                    for file in files:
                        if file == "spec.md":
                            sf = os.path.join(root, file)
                            d, t = _count_tasks_in_file(sf)
                            done += d; total += t
            all_done = total > 0 and done == total
            launch_config = _load_launch_config(p_path)
            # Check if already running
            running = pid in LAUNCHED_PROCESSES and LAUNCHED_PROCESSES[pid].poll() is None
            self.send_json({
                "available": launch_config is not None,
                "allDone": all_done,
                "description": launch_config.get("description", "") if launch_config else "",
                "type": launch_config.get("type", "") if launch_config else "",
                "running": running
            })
        elif p.path == "/api/task-results":
            pid, spec = parse_qs(p.query).get('project', [''])[0], parse_qs(p.query).get('spec', [''])[0]
            proj = next((p for p in PROJECTS if p['id'] == pid), None)
            res = {}
            if proj:
                r_dir = Path(proj['path']) / ".ralph-runner" / "results"
                if r_dir.exists():
                    for f in r_dir.glob("*.json"):
                        try:
                            data = json.loads(f.read_text(encoding='utf-8'))
                            t_name = re.sub(r'^- \[[ x]\]\s*', '', data.get('task_name', '')).strip()
                            if data.get('spec_name') == spec: res[t_name] = data
                        except: pass
            self.send_json(res)
        else: self.send_error(404)

    def do_POST(self):
        global PROJECTS, ACTIVE_PROJECT_ID
        PROJECTS = load_projects()
        p = urlparse(self.path)
        clen = int(self.headers.get('Content-Length', 0))
        try: body = json.loads(self.rfile.read(clen).decode('utf-8')) if clen > 0 else {}
        except: body = {}
        if p.path == "/api/project":
            req_id = body.get('project_id')
            if req_id: 
                ACTIVE_PROJECT_ID = req_id
                try: STATE_FILE.write_text(json.dumps({"active_id": req_id}), encoding='utf-8')
                except: pass
            self.send_json({"success": True})
        elif p.path == "/api/start4":
            pid = body.get('project_id')
            model = body.get('model', 'sonnet')
            project = next((p for p in PROJECTS if p['id'] == pid), None) or get_active_project()
            if not project:
                self.send_json({"success": False, "error": "Project not found"})
                return
            proj_path = project["path"]

            # Проверяем: не запущен ли уже Ralph Loop на этом проекте
            stat_file = os.path.join(proj_path, ".ralph-runner", "status.json")
            if os.path.exists(stat_file):
                try:
                    with open(stat_file, 'r', encoding='utf-8') as sf:
                        st = json.loads(sf.read())
                    if st.get('running') and st.get('pid') and _is_process_alive(st['pid']):
                        self.send_json({"success": False, "error": f"Ralph уже запущен на этом проекте (PID {st['pid']})"})
                        return
                except: pass

            overseer = RALPH_DIR / "ralph-overseer.js"
            env = os.environ.copy()
            env['RALPH_MODEL'] = model
            try:
                subprocess.Popen(
                    ['node', str(overseer), str(proj_path)],
                    creationflags=subprocess.CREATE_NO_WINDOW,
                    env=env
                )
                self.send_json({"success": True})
            except Exception as e:
                print(f"Ошибка запуска 4: {e}")
                self.send_json({"success": False, "error": str(e)})
        elif p.path == "/api/stop":
            pid = body.get('project_id')
            project = next((p for p in PROJECTS if p['id'] == pid), None) or get_active_project()
            if project:
                (Path(project["path"]) / ".ralph-stop").write_text("STOP", encoding='utf-8')
                self.send_json({"success": True})
            else:
                self.send_json({"success": False, "error": "Project not found"})
        elif p.path == "/api/pause":
            pid = body.get('project_id')
            project = next((p for p in PROJECTS if p['id'] == pid), None) or get_active_project()
            if project:
                p_path = Path(project['path'])
                pause_file = p_path / ".ralph-pause"
                status_file = p_path / ".ralph-runner" / "status.json"
                if pause_file.exists():
                    pause_file.unlink()
                    # Обновляем status.json — убираем paused
                    if status_file.exists():
                        try:
                            sd = json.loads(status_file.read_text(encoding='utf-8'))
                            sd['paused'] = False
                            status_file.write_text(json.dumps(sd, indent=2), encoding='utf-8')
                        except: pass
                else:
                    pause_file.write_text("PAUSE", encoding='utf-8')
                    # Обновляем status.json — ставим paused
                    if status_file.exists():
                        try:
                            sd = json.loads(status_file.read_text(encoding='utf-8'))
                            sd['paused'] = True
                            status_file.write_text(json.dumps(sd, indent=2), encoding='utf-8')
                        except: pass
            self.send_json({"success": True})
        elif p.path == "/api/show-console":
            signal_path = RALPH_DIR / ".ralph-runner" / "console_signal"
            try:
                signal_path.touch()
                self.send_json({"success": True})
            except:
                self.send_json({"success": False})
        elif p.path == "/api/restart":
            pid = body.get('project_id')
            project = next((p for p in PROJECTS if p['id'] == pid), None) or get_active_project()
            if project:
                p_path = Path(project['path'])
                (p_path / ".ralph-stop").write_text("STOP", encoding='utf-8')
                
                # kill by pid
                p_stat_file = p_path / ".ralph-runner" / "status.json"
                if p_stat_file.exists():
                    try:
                        data = json.loads(p_stat_file.read_text(encoding='utf-8'))
                        if data.get('pid'):
                            subprocess.run(f"taskkill /F /PID {data['pid']}", shell=True, capture_output=True)
                    except: pass
                
                overseer = RALPH_DIR / "ralph-overseer.js"
                proj_path = project["path"]
                cmd_str = f'node "{overseer}" "{proj_path}"'
                subprocess.Popen(['node', str(overseer), str(proj_path)], creationflags=subprocess.CREATE_NO_WINDOW)
            self.send_json({"success": True})
        elif p.path == "/api/restart-server":
            self.send_json({"success": True})
            print("--- ПЕРЕЗАПУСК СЕРВЕРА ---")
            def restart_later():
                time.sleep(0.5)
                # Запускаем новый экземпляр перед смертью
                subprocess.Popen(
                    [sys.executable, str(RALPH_DIR / "ralph-tracker-web.py")],
                    cwd=str(RALPH_DIR),
                    creationflags=subprocess.CREATE_NO_WINDOW
                )
                time.sleep(1)
                os._exit(0)
            import threading
            threading.Thread(target=restart_later, daemon=True).start()
        elif p.path == "/api/clear-stream":
            project = get_active_project()
            if not project:
                self.send_json({"success": False})
                return
            r_dir = Path(project["path"]) / ".ralph-runner"
            if r_dir.exists():
                for log_file in ["live_console_4.log", "thinking_status.txt"]:
                    lf = r_dir / log_file
                    if lf.exists(): lf.write_text("", encoding='utf-8')
            self.send_json({"success": True})
        elif p.path == "/api/reset-full":
            pid = body.get('project_id')
            proj = next((p for p in PROJECTS if p['id'] == pid), None)
            if proj:
                p_path = Path(proj['path'])
                # 1. Сначала делаем обычный сброс прогресса (галочки)
                self._do_reset_progress(proj)
                
                # 2. Теперь удаляем все файлы, кроме системных
                keep_files = ["prd.md", "gemini.md", "planning.md", "tasks.md", "ralph_history.txt"]
                keep_dirs = [".ralph-runner", "specs", ".gemini", "node_modules", ".git"]
                
                try:
                    for item in p_path.iterdir():
                        name_low = item.name.lower()
                        if item.is_file():
                            if name_low not in keep_files:
                                item.unlink()
                        elif item.is_dir():
                            if name_low not in keep_dirs:
                                import shutil
                                shutil.rmtree(item, ignore_errors=True)
                    self.send_json({"success": True})
                except Exception as e:
                    self.send_json({"success": False, "error": str(e)})
            else:
                self.send_json({"success": False, "error": "Project not found"})

        elif p.path == "/api/reset-progress":
            pid = body.get('project_id')
            proj = next((p for p in PROJECTS if p['id'] == pid), None)
            if proj:
                self._do_reset_progress(proj)
                self.send_json({"success": True})
            else:
                self.send_json({"success": False, "error": "Project not found"})

        elif p.path == "/api/toggle-task":
            pid, spec, task_idx, done = body.get('project_id'), body.get('spec_name'), body.get('task_idx'), body.get('done')
            proj = next((p for p in PROJECTS if p['id'] == pid), None)
            if proj:
                sf = Path(proj['specs_dir']) / spec / "spec.md"
                if sf.exists():
                    with _file_lock:
                        content_text = sf.read_text(encoding='utf-8')
                        lines = content_text.split('\n')
                        curr_idx, in_tasks = 0, False
                        task_id_to_toggle = None
                        for i, ln in enumerate(lines):
                            if '## Tasks' in ln: in_tasks = True; continue
                            if in_tasks and ln.startswith('##'): in_tasks = False
                            if in_tasks and ln.strip().startswith(('- [ ]', '- [x]')):
                                if curr_idx == task_idx:
                                    lines[i] = ln.replace('- [x]', '- [ ]') if not done else ln.replace('- [ ]', '- [x]')
                                    m = re.search(r'\{\{TASK:([a-zA-Z0-9_.-]+)\}\}', ln)
                                    if m:
                                        task_id_to_toggle = m.group(1)
                                        if not done:
                                            tid = task_id_to_toggle.replace('.', '_')
                                            res_path = Path(proj['path']) / ".ralph-runner" / "results" / f"{tid}.json"
                                            if res_path.exists():
                                                try: res_path.unlink()
                                                except: pass
                                    break
                                curr_idx += 1
                        sf.write_text('\n'.join(lines), encoding='utf-8')

                        if task_id_to_toggle:
                            tmd = Path(proj['path']) / "tasks.md"
                            if tmd.exists():
                                t_lines = tmd.read_text(encoding='utf-8').split('\n')
                                for j, t_ln in enumerate(t_lines):
                                    if t_ln.strip().startswith(('- [ ]', '- [x]')) and f"{{{{TASK:{task_id_to_toggle}}}}}" in t_ln:
                                        t_lines[j] = t_ln.replace('- [x]', '- [ ]') if not done else t_ln.replace('- [ ]', '- [x]')
                                        break
                                tmd.write_text('\n'.join(t_lines), encoding='utf-8')

                    self.send_json({"success": True})
                else:
                    self.send_json({"success": False, "error": "Spec not found"})
            else:
                self.send_json({"success": False, "error": "Project not found"})
        elif p.path == "/api/generate-specs":
            pid = body.get('project_id'); proj = next((p for p in PROJECTS if p['id'] == pid), None)
            if proj:
                BUSY_PROJECTS[pid] = "Generating Specs..."; _save_busy_state()
                def run_gen():
                    try:
                        cmd = f'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{RALPH_DIR / "spec-converter-fixed.ps1"}" -ProjectDir "{proj["path"]}"'
                        subprocess.run(cmd, shell=True)
                    finally:
                        if pid in BUSY_PROJECTS: del BUSY_PROJECTS[pid]
                        _save_busy_state()
                import threading; threading.Thread(target=run_gen).start()
                self.send_json({"success": True})
        elif p.path == "/api/delete-project":
            pid = body.get('project_id')
            PROJECTS = [p for p in PROJECTS if p['id'] != pid]
            save_projects_to_disk()
            # Очистка словарей для удалённого проекта
            if pid in _idea_queues: del _idea_queues[pid]
            if pid in _idea_workers: del _idea_workers[pid]
            if pid in LAUNCHED_PROCESSES:
                procs = LAUNCHED_PROCESSES.pop(pid)
                if not isinstance(procs, list): procs = [procs]
                for proc in procs:
                    try: subprocess.run(f"taskkill /F /T /PID {proc.pid}", shell=True, capture_output=True)
                    except: pass
            if pid in BUSY_PROJECTS:
                del BUSY_PROJECTS[pid]; _save_busy_state()
            _save_launch_state()
            self.send_json({"success": True})
        elif p.path == "/api/save-task-description":
            pid, spec, task, desc = body.get('project_id'), body.get('spec_name'), body.get('task_header'), body.get('new_description')
            proj = next((p for p in PROJECTS if p['id'] == pid), None)
            if proj:
                sf = Path(proj['specs_dir']) / spec / "spec.md"
                if sf.exists():
                    try:
                        with _file_lock:
                            lines = sf.read_text(encoding='utf-8').split('\n')
                            new_lines, skip = [], False
                            for l in lines:
                                if l.strip().startswith(('- [ ]', '- [x]')) and task in l:
                                    new_lines.append(l)
                                    if desc.strip(): new_lines.append(f"  {desc.strip()}")
                                    skip = True; continue
                                if skip:
                                    if l.strip().startswith(('- [ ]', '- [x]')) or l.strip().startswith('##'): skip = False
                                    else: continue
                                new_lines.append(l)
                            sf.write_text('\n'.join(new_lines), encoding='utf-8')
                    except: pass
            self.send_json({"success": True})
        elif p.path == "/api/add-subtask":
            pid = body.get('project_id')
            spec_name = body.get('spec_name')
            task_text = body.get('task_text', '').strip()
            task_desc = body.get('task_description', '').strip()
            proj = next((p for p in PROJECTS if p['id'] == pid), None)
            if not proj or not spec_name:
                self.send_json({"success": False, "error": "Missing params"})
                return
            sf = Path(proj['specs_dir']) / spec_name / "spec.md"
            if not sf.exists():
                self.send_json({"success": False, "error": "Spec not found"})
                return
            try:
                with _file_lock:
                    content = sf.read_text(encoding='utf-8')
                    # Find sprint number from spec folder name (e.g., "001-..." -> 1)
                    sprint_num = re.match(r'(\d+)', spec_name)
                    sprint_num = int(sprint_num.group(1)) if sprint_num else 1
                    # Find max subtask number in this sprint
                    existing = re.findall(r'\{\{TASK:' + str(sprint_num) + r'\.(\d+)\}\}', content)
                    next_sub = max([int(x) for x in existing], default=0) + 1
                    task_id = f"{sprint_num}.{next_sub}"
                    # Build new task line
                    new_task_line = f"- [ ] {{{{TASK:{task_id}}}}} {task_text}"
                    if task_desc:
                        new_task_line += f"\n  {task_desc}"
                    # Insert before ## Completion or at end of Tasks section
                    lines = content.split('\n')
                    insert_idx = len(lines)
                    in_tasks = False
                    last_task_idx = -1
                    for i, ln in enumerate(lines):
                        if '## Tasks' in ln:
                            in_tasks = True
                            continue
                        if in_tasks:
                            if ln.strip().startswith('##'):
                                insert_idx = i
                                break
                            if ln.strip().startswith(('- [ ]', '- [x]')):
                                last_task_idx = i
                                # Skip description lines after this task
                            elif last_task_idx >= 0 and not ln.strip():
                                # Empty line after task block
                                pass
                    if last_task_idx >= 0:
                        # Find the end of the last task's description block
                        end_of_last = last_task_idx + 1
                        while end_of_last < len(lines):
                            ln = lines[end_of_last].strip()
                            if ln.startswith(('- [ ]', '- [x]')) or ln.startswith('##'):
                                break
                            end_of_last += 1
                        insert_idx = end_of_last
                    lines.insert(insert_idx, new_task_line)
                    sf.write_text('\n'.join(lines), encoding='utf-8')
                    # Also add to tasks.md
                    tmd = Path(proj['path']) / "tasks.md"
                    if tmd.exists():
                        t_content = tmd.read_text(encoding='utf-8')
                        t_lines = t_content.split('\n')
                        # Find the sprint section and insert at end of its tasks
                        t_insert = len(t_lines)
                        t_in_sprint = False
                        t_last_task = -1
                        sprint_header_pattern = re.compile(r'^##\s+.*' + re.escape(spec_name.split('-', 1)[-1].strip()[:20]), re.IGNORECASE)
                        # More reliable: find by sprint number in TASK ids
                        for j, tl in enumerate(t_lines):
                            if f"{{{{TASK:{sprint_num}." in tl:
                                t_last_task = j
                        if t_last_task >= 0:
                            end_t = t_last_task + 1
                            while end_t < len(t_lines):
                                tl = t_lines[end_t].strip()
                                if tl.startswith(('- [ ]', '- [x]')) or tl.startswith('##'):
                                    break
                                end_t += 1
                            t_lines.insert(end_t, new_task_line)
                            tmd.write_text('\n'.join(t_lines), encoding='utf-8')
                self.send_json({"success": True, "task_id": task_id})
            except Exception as e:
                print(f"Add subtask error: {e}")
                self.send_json({"success": False, "error": str(e)})
        elif p.path == "/api/add-idea":
            pid = body.get('project_id')
            idea_text = body.get('idea', '').strip()
            proj = next((p for p in PROJECTS if p['id'] == pid), None)
            if not proj or not idea_text:
                self.send_json({"success": False, "error": "Missing params"})
                return
            # Очередь идей: если воркер уже работает, идея встаёт в очередь
            if pid not in _idea_queues:
                _idea_queues[pid] = _queue.Queue()
            _idea_queues[pid].put(idea_text)
            # Запускаем воркер если его нет или он завершился
            if pid not in _idea_workers or not _idea_workers[pid].is_alive():
                def idea_worker(project_id, proj_data):
                    q = _idea_queues[project_id]
                    while not q.empty():
                        # Собираем ВСЕ идеи из очереди в один батч
                        ideas = []
                        while not q.empty():
                            try: ideas.append(q.get_nowait())
                            except: break
                        if not ideas:
                            break
                        count = len(ideas)
                        BUSY_PROJECTS[project_id] = f"AI анализирует {'идею' if count == 1 else f'{count} идей'}..."; _save_busy_state()
                        proj_path = proj_data['path']
                        specs_dir = proj_data.get('specs_dir', os.path.join(proj_path, 'specs'))
                        # Снимок mtime spec-файлов ДО запуска
                        def get_spec_snapshot():
                            snap = {}
                            try:
                                for root, dirs, files in os.walk(specs_dir):
                                    for f in files:
                                        if f == 'spec.md':
                                            fp = os.path.join(root, f)
                                            snap[fp] = os.path.getmtime(fp)
                            except: pass
                            return snap
                        before_snap = get_spec_snapshot()
                        # Формируем промпт с полным контекстом проекта
                        if count == 1:
                            ideas_block = f'Идея: {ideas[0]}'
                        else:
                            ideas_block = 'Идеи (обработай ВСЕ за один раз):\n' + '\n'.join(f'{i+1}. {idea}' for i, idea in enumerate(ideas))
                        prompt = (
                            'Ты — архитектор проекта. Тебе нужно добавить новые задачи в проект.\n\n'
                            'СНАЧАЛА изучи полный контекст проекта для понимания целей, архитектуры и текущего состояния:\n'
                            '1. PRD.md — цели, требования, целевая аудитория\n'
                            '2. planning.md — архитектура, технические решения, стек\n'
                            '3. tasks.md — текущий план задач и их статус\n'
                            '4. Все файлы specs/*/spec.md — детальные спецификации спринтов\n'
                            '5. CLAUDE.md — правила и соглашения проекта\n\n'
                            'ЗАТЕМ проанализируй следующие идеи и для КАЖДОЙ:\n'
                            '1) Определи наиболее подходящий существующий спринт. Если ни один не подходит — создай новый (папка в specs/ + секция в tasks.md).\n'
                            '2) Определи правильный номер TASK (спринт.подзадача), чтобы не было конфликтов с существующими.\n'
                            '3) Назначь роль [Role: ...] исходя из характера задачи.\n'
                            '4) Напиши подробное описание в формате ПОДРОБНОСТИ: Что сделать, Как сделать, Ограничения, Критерии приёмки.\n'
                            '5) Добавь задачу в spec.md соответствующего спринта И в tasks.md.\n\n'
                            f'{ideas_block}'
                        )
                        try:
                            claude_exe = _claude_exe
                            proc = subprocess.Popen(
                                [claude_exe, '--dangerously-skip-permissions', '-p', prompt],
                                cwd=proj_path,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE,
                                encoding='utf-8',
                                errors='replace'
                            )
                            while proc.poll() is None:
                                time.sleep(1)
                                after_snap = get_spec_snapshot()
                                if after_snap != before_snap:
                                    print(f"[IDEA] Spec files changed, clearing busy status")
                                    if project_id in BUSY_PROJECTS:
                                        del BUSY_PROJECTS[project_id]; _save_busy_state()
                                    break
                            try:
                                proc.wait(timeout=120)
                            except subprocess.TimeoutExpired:
                                proc.kill()
                            print(f"[IDEA] Claude exit code: {proc.returncode}, processed {count} idea(s)")
                        except Exception as e:
                            print(f"Idea generation error: {e}")
                    if project_id in BUSY_PROJECTS:
                        del BUSY_PROJECTS[project_id]; _save_busy_state()
                _idea_workers[pid] = _threading.Thread(target=idea_worker, args=(pid, proj), daemon=True)
                _idea_workers[pid].start()
            self.send_json({"success": True})
        elif p.path == "/api/launch":
            pid = body.get('project_id')
            proj = next((pr for pr in PROJECTS if pr['id'] == pid), None) if pid else get_active_project()
            if not proj:
                self.send_json({"success": False, "error": "Project not found"})
                return
            p_path = Path(proj['path'])
            launch_config = _load_launch_config(p_path)
            if not launch_config:
                self.send_json({"success": False, "error": "No launch config"})
                return
            try:
                _execute_launch(proj['id'], p_path, launch_config)
                self.send_json({"success": True})
            except Exception as e:
                print(f"Launch error: {e}")
                self.send_json({"success": False, "error": str(e)})
        elif p.path == "/api/generate-launch":
            # AI анализирует проект и генерирует launch.json
            pid = body.get('project_id')
            proj = next((p for p in PROJECTS if p['id'] == pid), None)
            if not proj:
                self.send_json({"success": False, "error": "Project not found"})
                return
            proj_path = proj['path']
            project_port = _generate_port(pid)
            BUSY_PROJECTS[pid] = "AI определяет способ запуска..."; _save_busy_state()
            def gen_launch():
                try:
                    prompt = (
                        'Проанализируй структуру этого проекта и определи, как его нужно запускать.\n\n'
                        'Прочитай PRD.md, planning.md и изучи файлы проекта (package.json, index.html, main.py, и т.д.).\n\n'
                        'Создай файл launch.json в корне проекта с цепочкой шагов запуска.\n\n'
                        f'ВАЖНО: Для этого проекта используй порт {project_port}. '
                        'Не используй стандартные порты (3000, 5000, 8080) — каждый проект имеет свой уникальный порт.\n\n'
                        'Формат launch.json:\n'
                        '{\n'
                        '  "description": "Краткое описание на русском",\n'
                        '  "steps": [\n'
                        '    {"type": "command", "command": "npm install", "wait": true, "label": "Установка зависимостей"},\n'
                        '    {"type": "command", "command": "npm run build", "wait": true, "label": "Сборка"},\n'
                        f'    {{"type": "shell", "command": "npx http-server -p {project_port}", "label": "Запуск сервера"}},\n'
                        f'    {{"type": "open", "url": "http://localhost:{project_port}", "delay": 3, "label": "Открыть в браузере"}}\n'
                        '  ]\n'
                        '}\n\n'
                        'Типы шагов:\n'
                        '- "command" — выполнить команду. wait=true означает дождаться завершения перед следующим шагом.\n'
                        '- "open" — открыть URL или файл в браузере. delay=N — подождать N секунд перед открытием.\n'
                        '- "shell" — выполнить команду в новом окне терминала (для серверов, которые должны работать постоянно).\n\n'
                        'Примеры:\n'
                        '- Простой HTML-файл: [{"type": "open", "url": "index.html", "label": "Открыть в браузере"}]\n'
                        f'- Node.js приложение: [{{"type": "command", "command": "npm install", "wait": true}}, {{"type": "shell", "command": "npx http-server -p {project_port}"}}, {{"type": "open", "url": "http://localhost:{project_port}", "delay": 3}}]\n'
                        f'- Python Flask: [{{"type": "command", "command": "pip install -r requirements.txt", "wait": true}}, {{"type": "shell", "command": "python app.py --port {project_port}"}}, {{"type": "open", "url": "http://localhost:{project_port}", "delay": 2}}]\n'
                        '- Electron: [{"type": "command", "command": "npm install", "wait": true}, {"type": "command", "command": "npm start"}]\n\n'
                        'ВАЖНО: Создай ТОЛЬКО файл launch.json. Не меняй ничего другого.'
                    )
                    claude_exe = _claude_exe
                    subprocess.run(
                        [claude_exe, '--dangerously-skip-permissions', '-p', prompt],
                        cwd=proj_path, capture_output=True, text=True,
                        timeout=120, encoding='utf-8', errors='replace'
                    )
                except Exception as e:
                    print(f"Generate launch error: {e}")
                finally:
                    if pid in BUSY_PROJECTS: del BUSY_PROJECTS[pid]; _save_busy_state()
            _threading.Thread(target=gen_launch, daemon=True).start()
            self.send_json({"success": True})
        elif p.path == "/api/launch-stop":
            pid = body.get('project_id')
            if pid in LAUNCHED_PROCESSES:
                procs = LAUNCHED_PROCESSES[pid]
                if not isinstance(procs, list):
                    procs = [procs]
                for proc in procs:
                    if proc.poll() is None:
                        try:
                            subprocess.run(f"taskkill /F /T /PID {proc.pid}", shell=True, capture_output=True)
                        except: pass
                # Ждём завершения всех процессов (до 5 секунд)
                for proc in procs:
                    try:
                        proc.wait(timeout=5)
                    except: pass
                del LAUNCHED_PROCESSES[pid]
                _save_launch_state()
            self.send_json({"success": True})
        elif p.path == "/api/open-folder":
            req_path = body.get('path', '')
            # Валидация: разрешаем только пути зарегистрированных проектов
            allowed = [os.path.normpath(str(pr.get('path', ''))) for pr in PROJECTS]
            norm_req = os.path.normpath(req_path) if req_path else ''
            if not norm_req or norm_req not in allowed:
                self.send_json({"success": False, "error": "Path not allowed"})
                return
            os.startfile(norm_req)
            self.send_json({"success": True})
        else: self.send_error(404)

    def _do_reset_progress(self, proj):
        p_path = Path(proj['path']); specs_dir = Path(proj['specs_dir'])
        if specs_dir.exists():
            for sf in specs_dir.rglob("spec.md"):
                c = sf.read_text(encoding='utf-8', errors='ignore').replace('- [x]', '- [ ]')
                sf.write_text(c, encoding='utf-8')
        tmd = p_path / "tasks.md"
        if tmd.exists():
            c = tmd.read_text(encoding='utf-8', errors='ignore').replace('- [x]', '- [ ]')
            tmd.write_text(c, encoding='utf-8')
        r_dir = p_path / ".ralph-runner" / "results"
        if r_dir.exists():
            for f in r_dir.glob("*.json"): f.unlink()
        
        l_dir = p_path / ".ralph-runner" / "logs"
        if l_dir.exists():
            for f in l_dir.glob("*.*"): f.unlink()
        
        for log_file in ["live_console_4.log", "crash.log", "thinking_status.txt"]:
            lf = p_path / ".ralph-runner" / log_file
            if lf.exists(): lf.write_text("", encoding='utf-8')
        
        status_file = p_path / ".ralph-runner" / "status.json"
        if status_file.exists():
            try:
                s_data = json.loads(status_file.read_text(encoding='utf-8'))
                if 'session_id' in s_data: s_data['session_id'] = None
                status_file.write_text(json.dumps(s_data), encoding='utf-8')
            except: pass
    def send_json(self, data):
        try:
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            print(f"send_json error: {e}")
    def log_message(self, format, *args): return

def get_dashboard_html():
    return r'''<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Ralph 2.0</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2358a6ff' stroke-width='2.5'%3E%3Cpath d='M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-0.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z'/%3E%3Cpath d='M10 2c1 .5 2 2 2 5'/%3E%3C/svg%3E">
<style>
    :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #f0f6fc; --blue: #58a6ff; --green: #3fb950; --red: #f85149; --orange: #d29922; --text-dim: #8b949e; --bg-hover: #1f242c; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 0; height: 100vh; overflow: hidden; }
    .container { display: flex; flex-direction: column; height: 100vh; max-width: 100%; }
    .split-view { display: flex; gap: 0; flex: 1; min-height: 0; overflow: hidden; }
    .col-resizer { width: 12px; min-width: 12px; cursor: col-resize; background: transparent; position: relative; flex-shrink: 0; z-index: 10; transition: background 0.2s; align-self: stretch; margin: 0 -2px; }
    .col-resizer::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 4px; height: 40px; background: var(--border); border-radius: 2px; transition: background 0.2s, height 0.2s; }
    .col-resizer:hover { background: rgba(88,166,255,0.08); }
    .col-resizer:hover::after, .col-resizer.dragging::after { background: var(--blue); height: 60px; }
    .col-resizer.dragging { background: rgba(88,166,255,0.12); }
    .row-resizer { height: 12px; min-height: 12px; cursor: row-resize; background: transparent; position: relative; flex-shrink: 0; z-index: 10; transition: background 0.2s; margin: -2px 0; }
    .row-resizer::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 40px; height: 4px; background: var(--border); border-radius: 2px; transition: background 0.2s, width 0.2s; }
    .row-resizer:hover { background: rgba(88,166,255,0.08); }
    .row-resizer:hover::after, .row-resizer.dragging::after { background: var(--blue); width: 60px; }
    .row-resizer.dragging { background: rgba(88,166,255,0.12); }
    .col1 { min-width: 180px; flex: 0 0 18%; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--border); }
    .col1 .projects-section { flex: 1; overflow-y: auto; padding: 8px; }
    .col2 { min-width: 200px; flex: 0 0 35%; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--border); }
    .col2-header { padding: 10px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .col2-body { flex: 1; overflow-y: auto; padding: 8px; min-height: 0; }
    .col2-body::-webkit-scrollbar { width: 6px; background: transparent; }
    .col2-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
    .col2-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
    .col3 { min-width: 200px; flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .col3-top { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 60px; border-bottom: 1px solid var(--border); }
    .col3-top-header { padding: 8px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; font-weight: 700; color: var(--text-dim); font-size: 0.85em; }
    .col3-top-content { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .detail-desc-pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 40px; border-bottom: 1px solid var(--border); }
    .detail-result-pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 40px; }
    .col3-top-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-dim); font-size: 0.9em; }
    .col3-bottom { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 60px; }
    .col3-bottom .live-console { flex: 1; height: 0 !important; min-height: 0; resize: none; overflow-y: auto; }
    .panel-arrow { display:inline-block; font-size:0.7em; color:var(--text-dim); transition:transform 0.25s ease; cursor:pointer; }
    @media (max-width: 900px) { .split-view { flex-direction: column; } .col-resizer { display: none; } .col1, .col2, .col3 { flex: none !important; width: 100%; } .row-resizer { display: none; } .col3-bottom .live-console { height: 400px !important; } }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0; z-index: 100; background: var(--bg); padding: 10px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .header h1 { display: flex; align-items: center; gap: 12px; }
    .project-item { position: relative; background: var(--card); border-radius: 8px; padding: 10px 12px; cursor: pointer; border: 1px solid var(--border); margin-bottom: 6px; transition: 0.2s; }
    .project-item.active { border-color: var(--blue); background: var(--bg-hover); box-shadow: 0 0 0 1px var(--blue), 0 0 10px rgba(88,166,255,0.3); }
    .project-item .progress-bg { position: absolute; bottom: 0; left: 0; height: 2px; background: var(--green); transition: width 0.5s; opacity: 0.6; border-radius: 0 0 8px 8px; }
    .project-row1 { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .project-row1-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .project-row1-left strong { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 1.05em; max-width: 200px; display: inline-block; vertical-align: middle; }
    .project-row1-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .project-row1-right .project-controls { display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; }
    .project-row2 { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
    .project-row2 .progress-bar-wrap { flex: 1; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; min-width: 40px; }
    .project-row2 .progress-bar-fill { height: 100%; background: var(--green); border-radius: 3px; transition: width 0.5s; }
    .project-row2 .progress-text { font-size: 0.75em; color: var(--green); font-weight: 700; white-space: nowrap; }
    .project-row2 .project-controls { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .icon-btn { background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-dim); cursor: pointer; padding: 6px; border-radius: 6px; display: flex; align-items: center; justify-content: center; transition: 0.2s; }
    .icon-btn:hover { color: var(--text); background: rgba(255,255,255,0.15); }
    .icon-btn.start { color: var(--green); border-color: rgba(63,185,80,0.3); }
    .icon-btn.stop { color: var(--red); border-color: rgba(248,81,73,0.3); }
    .model-toggle { display:none; align-items:center; gap:0; border-radius:5px; overflow:hidden; border:1px solid var(--border); font-size:0.7em; font-weight:700; height:28px; }
    .model-toggle .mt-opt { padding:4px 8px; cursor:pointer; transition:0.2s; color:var(--text-dim); background:transparent; user-select:none; }
    .model-toggle .mt-opt:hover { background:rgba(255,255,255,0.05); }
    .model-toggle .mt-opt.active-sonnet { background:rgba(88,166,255,0.15); color:var(--blue); }
    .model-toggle .mt-opt.active-opus { background:rgba(168,85,247,0.2); color:#a855f7; }
    .launch-btn { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; padding: 8px 16px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 0.85em; display: inline-flex; align-items: center; gap: 6px; transition: 0.2s; box-shadow: 0 2px 8px rgba(99,102,241,0.3); }
    .launch-btn:hover { background: linear-gradient(135deg, #4f46e5, #7c3aed); box-shadow: 0 4px 15px rgba(99,102,241,0.5); transform: translateY(-1px); }
    .launch-btn.running { background: linear-gradient(135deg, #dc2626, #ef4444); box-shadow: 0 2px 8px rgba(220,38,38,0.3); }
    .launch-btn.running:hover { background: linear-gradient(135deg, #b91c1c, #dc2626); box-shadow: 0 4px 15px rgba(220,38,38,0.5); }
    .add-subtask-btn { display: flex; align-items: center; gap: 6px; padding: 8px 14px; margin: 8px 16px 12px; border-radius: 6px; border: 1px dashed var(--border); background: transparent; color: var(--text-dim); cursor: pointer; font-size: 0.85em; transition: 0.2s; }
    .add-subtask-btn:hover { border-color: var(--blue); color: var(--blue); background: rgba(88,166,255,0.05); }
    .add-subtask-form { padding: 12px 16px; border-top: 1px solid var(--border); background: rgba(0,0,0,0.2); }
    .add-subtask-form input, .add-subtask-form textarea { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font-family: inherit; font-size: 0.9em; margin-bottom: 8px; outline: none; }
    .add-subtask-form input:focus, .add-subtask-form textarea:focus { border-color: var(--blue); }
    .add-subtask-form textarea { min-height: 60px; resize: vertical; }
    .idea-btn { padding: 6px 14px; border-radius: 6px; border: 1px solid rgba(139,92,246,0.3); background: rgba(139,92,246,0.1); color: #a78bfa; cursor: pointer; font-size: 0.8em; font-weight: 600; transition: 0.2s; display: inline-flex; align-items: center; gap: 6px; }
    .idea-btn:hover { background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.5); color: #c4b5fd; }
    .busy-badge { display:inline-flex; align-items:center; gap:6px; color:var(--orange); font-size:0.75em; font-weight:600; background:rgba(210,153,34,0.1); border:1px solid rgba(210,153,34,0.25); padding:2px 10px; border-radius:12px; }
    .busy-spinner { width:12px; height:12px; border:2px solid rgba(210,153,34,0.3); border-top-color:var(--orange); border-radius:50%; animation:busySpin 0.8s linear infinite; flex-shrink:0; }
    @keyframes busySpin { to { transform:rotate(360deg); } }
    .menu-dropdown { position: absolute; background: #1c2128; border: 1px solid var(--border); border-radius: 8px; padding: 6px; width: max-content; z-index: 9999; display: none; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .menu-dropdown.show { display: block; }
    .menu-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; font-size: 0.9em; border-radius: 6px; cursor: pointer; transition: 0.2s; color: var(--text); }
    .menu-item:hover { background: var(--bg-hover); }
    .menu-item.danger { color: var(--red); }
    .menu-item.warning { color: var(--orange); }
    .menu-item.success { color: var(--green); }
    .card { background: var(--card); border-radius: 10px; padding: 20px; border: 1px solid var(--border); }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; cursor: pointer; }
    .master-task { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; transition: 0.3s; }
    .task-group { margin-bottom: 4px; }
    .task-group-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; transition: 0.2s; font-size: 0.85em; background: var(--card); border: 1px solid var(--border); border-radius: 6px; }
    .task-group-header:hover { background: var(--bg-hover); }
    .master-task.fully-completed { border-color: var(--green); background: rgba(63,185,80,0.05); }
    .master-header { padding: 14px 16px; background: rgba(255,255,255,0.03); cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: bold; }
    .spec-right { display: flex; align-items: center; gap: 10px; }
    .spec-progress-bar { width: 60px; height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; overflow: hidden; }
    .spec-progress-fill { height: 100%; background: var(--green); border-radius: 2px; transition: width 0.4s ease; width: 0; }
    .subtask { padding: 10px 16px; border-top: 1px solid var(--border); cursor: pointer; transition: 0.2s; }
    .subtask-header { display: flex; align-items: center; gap: 12px; }
    .subtask.done .subtask-header { color: var(--green); }
    .subtask.selected { background: rgba(88,166,255,0.08); border-left: 3px solid var(--blue); }
    .desc-box { margin-top: 10px; padding: 15px; background: #05070a; border-radius: 6px; border: 1px solid var(--border); display: none; }
    .desc-box.show { display: block; }
    textarea { width: 100%; background: transparent; border: none; color: #fff; min-height: 100px; outline: none; resize: vertical; font-family: inherit; line-height: 1.5; font-size: 0.95em; }
    .res-box { margin-top: 15px; padding: 15px; background: #000; border: 1px solid #3fb950; border-radius: 6px; font-family: 'Consolas', monospace; font-size: 0.9em; line-height: 1.4; color: #3fb950; position: relative; }
    .res-box::before { content: "EXECUTED LOG"; position: absolute; top: -10px; left: 10px; background: #000; padding: 0 5px; font-size: 0.7em; font-weight: bold; color: #3fb950; }
    .save-btn { padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--blue); color: #fff; cursor: pointer; margin-top: 10px; font-weight: bold; }
    .live-console { background: #000; padding: 15px; overflow-y: auto; white-space: pre; font-family: 'Consolas', 'Monaco', 'Lucida Console', monospace; font-size: 0.85em; border-radius: 8px; border: 1px solid var(--border); position: relative; line-height: 1.2; letter-spacing: 0px; }
    .live-console::-webkit-scrollbar { width: 8px; }
    .live-console::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .copy-btn { position: absolute; top: 10px; right: 10px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); color: var(--text-dim); padding: 5px; border-radius: 4px; cursor: pointer; z-index: 10; transition: 0.2s; display: flex; }
    .log-o { color: #58a6ff; font-weight: bold; }
    .log-i { color: #d29922; font-weight: bold; }
    .log-ts { color: var(--text-dim); font-size: 0.85em; margin-right: 8px; }
    .custom-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 99998; display: none; background: rgba(0,0,0,0.4); backdrop-filter: blur(2px); }
    .custom-modal { position: absolute; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 18px; box-shadow: 0 10px 30px rgba(0,0,0,0.8); z-index: 99999; display: none; min-width: 280px; max-width: 400px; color: var(--text); font-size: 0.95em; animation: modalIn 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
    .custom-modal.center { top: 50% !important; left: 50% !important; transform: translate(-50%, -50%); position: fixed; animation: modalInCenter 0.2s cubic-bezier(0.16, 1, 0.3, 1); }
    .custom-modal .modal-msg { margin-bottom: 20px; line-height: 1.4; }
    .custom-modal .modal-btns { display: flex; justify-content: flex-end; gap: 10px; }
    .custom-modal .btn { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; transition: 0.2s; font-weight: 600; font-size: 0.9em; }
    .custom-modal .btn:hover { background: var(--bg-hover); }
    .custom-modal .btn.btn-danger { background: rgba(248,81,73,0.1); color: var(--red); border-color: rgba(248,81,73,0.4); }
    .custom-modal .btn.btn-danger:hover { background: rgba(248,81,73,0.2); }
    .custom-modal .btn.btn-primary { background: var(--blue); color: #fff; border-color: var(--blue); }
    .custom-modal .btn.btn-primary:hover { background: #3182ce; }
    @keyframes modalIn { from { opacity: 0; transform: translateY(10px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
    @keyframes modalInCenter { from { opacity: 0; transform: translate(-50%, -45%) scale(0.95); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
    .console-tabs { display:flex; gap:5px; margin-left: 15px; font-size: 0.9em; }
    .console-tab { padding:6px 12px; cursor:pointer; font-weight:bold; color:var(--text-dim); border-bottom:2px solid transparent; transition:0.2s; border-radius: 6px 6px 0 0; }
    .console-tab:hover { color:var(--text); background: rgba(255,255,255,0.05); }
    .console-tab.active { color:var(--blue); border-bottom-color:var(--blue); background: rgba(88,166,255,0.1); }
    @keyframes newTaskGlow { 0% { background:transparent; border-left:3px solid transparent; } 50% { background:rgba(168,85,247,0.12); border-left:3px solid rgba(168,85,247,0.6); } 100% { background:transparent; border-left:3px solid transparent; } }
    .subtask.new-task-highlight { animation: newTaskGlow 2s ease-in-out 2; }
    .project-header { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; margin-bottom:10px; background:var(--card); border:1px solid var(--border); border-radius:8px; min-height:0; flex-shrink:0; }
    .project-header:empty { display:none; }
    .project-header .ph-left { display:flex; align-items:center; gap:10px; min-width:0; }
    .project-header .ph-name { font-size:1.05em; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .project-header .ph-path { font-size:0.75em; color:var(--text-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
    .project-header .ph-path:hover { color:var(--blue); }
    .project-header .ph-right { display:flex; align-items:center; gap:10px; flex-shrink:0; }
    .project-header .ph-progress { font-size:0.85em; font-weight:700; color:var(--green); }
    .project-header .ph-status { display:inline-flex; align-items:center; gap:6px; font-size:0.75em; font-weight:600; padding:3px 10px; border-radius:12px; border:1px solid var(--border); }
    .project-header .ph-status.running { color:var(--green); border-color:rgba(63,185,80,0.3); background:rgba(63,185,80,0.08); }
    .project-header .ph-status.paused { color:var(--orange); border-color:rgba(210,153,34,0.3); background:rgba(210,153,34,0.08); }
    .project-header .ph-status.stopped { color:var(--text-dim); }
    .server-status-bar { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; margin-top:10px; background:var(--card); border:1px solid var(--border); border-radius:8px; }
    .server-status-left { display:flex; align-items:center; gap:8px; }
    .server-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--green); box-shadow:0 0 6px var(--green); }
    .server-label { font-size:0.8em; font-weight:600; color:var(--green); }
    .server-status-right { display:flex; align-items:center; gap:4px; }
    .server-status-right .icon-btn { padding:4px; }
</style></head><body>
<div id="customModalOverlay" class="custom-modal-overlay" onclick="closeCustomModal()"></div>
<div id="customModal" class="custom-modal">
    <div class="modal-msg" id="customModalMsg"></div>
    <div class="modal-btns" id="customModalBtns"></div>
</div>
<div class="container">
    <div class="header">
        <h1><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#58a6ff" stroke-width="2.5"><path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-0.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"></path><path d="M10 2c1 .5 2 2 2 5"></path></svg> Ralph 2.0</h1>
        <div style="display:flex; align-items:center; gap:10px;">
            <div style="display:flex; align-items:center; gap:6px; font-size:0.8em; color:var(--green);"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green)"></span>Сервер</div>
            <button class="icon-btn" onclick="globalRestart()" title="Перезапустить веб-сервер"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg></button>
            <button class="icon-btn" id="btnShowConsole" onclick="showServerLogs()" title="Логи сервера"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg></button>
        </div>
    </div>
    <div class="split-view">
        <!-- Колонка 1: Проекты -->
        <div class="col1" id="col1">
            <div class="projects-section"><h2 style="font-size:0.75em;color:var(--text-dim);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;padding:8px 8px 0">Проекты</h2><div id="projects"></div></div>
        </div>
        <div class="col-resizer" id="resizer12"></div>
        <!-- Колонка 2: Задачи -->
        <div class="col2" id="col2">
            <div class="col2-header" id="col2Header">
                <h2 style="font-size:1.15em; margin-bottom:2px;" id="projectHeader">Выберите проект</h2>
                <div id="projectPath" style="font-size:0.75em; color:var(--text-dim); cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" onclick="if(this.dataset.path) openFolder(this.dataset.path, event)" title="Открыть папку проекта"></div>
                <button class="idea-btn" style="width:100%; justify-content:center; margin-top:8px; padding:8px;" onclick="showIdeaDialog()">+ Добавить идею</button>
            </div>
            <div class="col2-body" id="tasksBody">
                <div id="tasks"></div>
                <div id="doneSection"></div>
            </div>
        </div>
        <div class="col-resizer" id="resizer23"></div>
        <!-- Колонка 3: Описание задачи + Консоль -->
        <div class="col3" id="col3">
            <div class="col3-top" id="col3Top">
                <div class="col3-top-header" id="detailHeader">Описание задачи</div>
                <div class="col3-top-content" id="col3TopContent">
                    <div class="detail-desc-pane" id="detailDescPane">
                        <div id="detailBody" style="flex:1; overflow-y:auto; padding:12px;"><div class="col3-top-empty" id="detailEmpty">Выберите задачу</div></div>
                    </div>
                    <div class="row-resizer" id="resizerDetail"></div>
                    <div class="detail-result-pane" id="detailResultPane">
                        <div style="padding:6px 12px; border-bottom:1px solid var(--border); flex-shrink:0; font-size:0.8em; font-weight:700; color:var(--text-dim);">Результат выполнения</div>
                        <div id="detailResults" style="flex:1; overflow-y:auto; padding:12px;"></div>
                    </div>
                </div>
            </div>
            <div class="row-resizer" id="resizer3v"></div>
            <div class="col3-bottom" id="col3Bottom">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--border); flex-shrink:0; cursor:pointer;" onclick="toggleConsole()">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span id="consoleArrow" class="panel-arrow" style="transform:rotate(90deg);">&#9654;</span>
                        <h3 style="font-size:0.9em; color:var(--text-dim);">Консоль</h3>
                    </div>
                    <div onclick="event.stopPropagation()" style="display:flex;gap:4px;" id="consoleBtns">
                        <button style="padding:4px 10px; border-radius:4px; border:1px solid var(--border); background:var(--bg); color:var(--text-dim); cursor:pointer; font-size:0.8em;" onclick="clearConsole()">Очистить</button>
                        <button style="padding:4px 10px; border-radius:4px; border:1px solid var(--border); background:var(--bg); color:var(--text-dim); cursor:pointer; font-size:0.8em;" onclick="saveConsole()">Сохранить</button>
                    </div>
                </div>
                <div id="consoleWrapper" style="position:relative; flex:1; display:flex; flex-direction:column; overflow:hidden;">
                    <div id="consoleStatusContainer" style="display:none; position:relative;">
                        <button class="copy-btn" id="copyStatusBtn" onclick="copyConsoleStatus()" title="Копировать статус" style="top:5px; right:10px; padding:6px;"></button>
                        <div id="consoleStatus" style="background:rgba(88,166,255,0.1); border:1px solid var(--border); border-bottom:none; border-radius:8px 8px 0 0; padding:8px 15px; padding-right:40px; color:var(--blue); font-family:'Consolas', monospace; font-size:0.85em; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></div>
                    </div>
                    <div style="position:relative; flex:1; display:flex; flex-direction:column; min-height:0;">
                        <button class="copy-btn" id="copyMainBtn" onclick="copyConsoleMain()" title="Копировать консоль" style="padding:6px;"></button>
                        <div id="console" class="live-console"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>
<div id="ctxMenu" class="menu-dropdown">
    <div class="menu-item success" onclick="handleMenu(event, 'start')"><span id="m-icon-run"></span> <span id="m-text-run"></span></div>
    <div class="menu-item" id="m-item-pause" style="display:none;" onclick="handleMenu(event, 'pause')"><span id="m-icon-pause"></span> <span id="m-text-pause">Пауза</span></div>
    <div class="menu-item" onclick="handleMenu(event, 'restart')"><span id="m-icon-restart"></span> Перезапустить</div>
    <div class="menu-item warning" onclick="handleMenu(event, 'crash')"><span id="m-icon-crash"></span> Лог ошибок (crash.log)</div>
    <div class="menu-item" onclick="handleMenu(event, 'gen')"><span id="m-icon-gen"></span> Сгенерировать спецификации</div>
    <div class="menu-item warning" onclick="handleMenu(event, 'reset')"><span id="m-icon-reset"></span> Сбросить прогресс</div>
    <div class="menu-item danger" onclick="handleMenu(event, 'reset-full')"><span id="m-icon-reset-full"></span> Полный сброс (с удалением файлов)</div>
    <div class="menu-item danger" onclick="handleMenu(event, 'delete')"><span id="m-icon-trash"></span> Удалить из списка</div>
</div>
<script>
    const ICONS = {
        folder: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>',
        play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
        stop: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
        pause: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
        refresh: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>',
        more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>',
        gen: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>',
        trash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
        check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>',
        square: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>',
        chevron: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>',
        copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>'
    };

    let activeId = null, renderedProjectId = null, isEditing = false, firstLoadDone = false, menuTarget = null, menuX = 0, menuY = 0;
    const projectModels = JSON.parse(localStorage.getItem('ralph_models') || '{}');
    function getModel(pid) { return projectModels[pid] || 'opus'; }
    function saveModels() { localStorage.setItem('ralph_models', JSON.stringify(projectModels)); }
    function toggleModel(pid, ev) { ev.stopPropagation(); projectModels[pid] = getModel(pid)==='sonnet' ? 'opus' : 'sonnet'; saveModels(); refresh(); }
    let prevSpecSignature = '';

    let _actionLock = null; // {id, action, time}
    function isLocked(id, action) {
        if (!_actionLock || _actionLock.id !== id) return false;
        if (Date.now() - _actionLock.time >= 8000) return false;
        // Stop всегда разрешён, даже если идёт starting
        if (action === 'stopping') return _actionLock.action === 'stopping';
        return true;
    }
    function setLock(id, action) { _actionLock = {id, action, time: Date.now()}; refresh(); }
    function clearLock() { _actionLock = null; refresh(); }

    async function toggleRun4(id) {
        if (isLocked(id, 'starting')) return;
        setLock(id, 'starting');
        switchConsoleTab(4, null);
        await fetch('/api/start4', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: id, model: getModel(id) }) });
        setTimeout(clearLock, 3000);
    }
    async function stopRun(id) {
        if (isLocked(id, 'stopping')) return;
        setLock(id, 'stopping');
        await fetch('/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: id }) });
        setTimeout(clearLock, 3000);
    }
    let activeConsoleTab = 4;
    let consoleData = {4: ''};
    let consoleStatusData = {4: ''};

    function processConsoleData(rawText, explicitStatus) {
        if (!rawText && !explicitStatus) return { text: '', status: '' };
        
        // 1. Полностью очищаем от всех ANSI-кодов (цвета, управление курсором и т.д.)
        const ansiRegex = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
        let noAnsiText = (rawText||'').replace(ansiRegex, '');
        let noAnsiExplicit = (explicitStatus||'').replace(ansiRegex, '');
        
        let statusLine = noAnsiExplicit || '';
        let normalizedText = noAnsiText.replace(/\r(?!\n)/g, '\n');
        
        // 2. Ищем и удаляем строку с таймером/спиннером, извлекая только сам статус
        let cleanText = normalizedText.replace(/^[^\n]*(?:esc to cancel|escape to cancel|responding \()[^\n]*(?:\n|$)/gim, (match) => {
            if (!noAnsiExplicit) {
                // Пытаемся вытащить только ту часть, которая относится к таймеру/спиннеру
                let m = match.match(/(?:⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|responding|thinking).*?(?:esc to cancel|escape to cancel)[^\n)]*\)?/i);
                statusLine = m ? m[0].trim() : match.replace(/\n$/, '').trim();
            }
            return '';
        });
        
        // 3. Удаляем случайные проскакивания статус-бара Gemini (Model: ... Context: ...)
        cleanText = cleanText.replace(/^[^\n]*Model:[^\n]*Context:[^\n]*(?:\n|$)/gim, '');
        
        return { text: cleanText, status: statusLine };
    }

    function updateConsoleStatusDisplay() {
        const statContainer = document.getElementById('consoleStatusContainer');
        const statEl = document.getElementById('consoleStatus');
        const consEl = document.getElementById('console');
        const statText = consoleStatusData[activeConsoleTab];
        if (statText) {
            statEl.innerText = statText;
            statContainer.style.display = 'block';
            consEl.style.borderTopLeftRadius = '0';
            consEl.style.borderTopRightRadius = '0';
        } else {
            statContainer.style.display = 'none';
            consEl.style.borderTopLeftRadius = '8px';
            consEl.style.borderTopRightRadius = '8px';
        }
    }

    function switchConsoleTab(tabNum, e) {
        if(e) e.stopPropagation();
        activeConsoleTab = tabNum;
        document.querySelectorAll('.console-tab').forEach(el => el.classList.remove('active'));
        const tabEl = document.getElementById('tab'+tabNum);
        if (tabEl) tabEl.classList.add('active');
        
        const el = document.getElementById('console');
        el.textContent = consoleData[tabNum];
        el.scrollTop = el.scrollHeight;
        updateConsoleStatusDisplay();
    }

    async function togglePause(pid) {
        if (isLocked(pid, 'pausing')) return;
        setLock(pid, 'pausing');
        await fetch('/api/pause', { method: 'POST', body: JSON.stringify({ project_id: pid }) });
        setTimeout(clearLock, 2000);
    }

    function customConfirm(msg, x, y, onConfirm) {
        const overlay = document.getElementById('customModalOverlay');
        const modal = document.getElementById('customModal');
        document.getElementById('customModalMsg').innerHTML = msg;
        const btnContainer = document.getElementById('customModalBtns');
        btnContainer.innerHTML = '';
        
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn';
        cancelBtn.innerText = 'Отмена';
        cancelBtn.onclick = closeCustomModal;
        
        const okBtn = document.createElement('button');
        okBtn.className = 'btn btn-danger';
        okBtn.innerText = 'Подтвердить';
        okBtn.onclick = () => { closeCustomModal(); onConfirm(); };
        
        btnContainer.appendChild(cancelBtn);
        btnContainer.appendChild(okBtn);
        
        overlay.style.display = 'block';
        modal.style.display = 'block';
        modal.classList.remove('center');
        
        if (x && y) {
            setTimeout(() => {
                const modalRect = modal.getBoundingClientRect();
                let top = y - modalRect.height - 15;
                let left = x - (modalRect.width / 2);
                if (top < 10) top = 10;
                if (left < 10) left = 10;
                if (left + modalRect.width > window.innerWidth - 10) left = window.innerWidth - modalRect.width - 10;
                modal.style.top = top + 'px';
                modal.style.left = left + 'px';
            }, 0);
        } else {
            modal.classList.add('center');
        }
    }

    function customAlert(msg) {
        const overlay = document.getElementById('customModalOverlay');
        const modal = document.getElementById('customModal');
        document.getElementById('customModalMsg').innerHTML = msg;
        const btnContainer = document.getElementById('customModalBtns');
        btnContainer.innerHTML = '';
        const okBtn = document.createElement('button');
        okBtn.className = 'btn btn-primary';
        okBtn.innerText = 'OK';
        okBtn.onclick = closeCustomModal;
        btnContainer.appendChild(okBtn);
        overlay.style.display = 'block';
        modal.style.display = 'block';
        modal.classList.add('center');
        modal.style.top = '';
        modal.style.left = '';
    }

    function closeCustomModal() {
        document.getElementById('customModalOverlay').style.display = 'none';
        document.getElementById('customModal').style.display = 'none';
    }

    function initStaticIcons() {
        const _si = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
        _si('copyStatusBtn', ICONS.copy); _si('copyMainBtn', ICONS.copy);
        _si('m-icon-restart', '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>');
        _si('m-icon-crash', '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>');
        _si('m-icon-gen', ICONS.gen);
        _si('m-icon-reset', ICONS.refresh);
        _si('m-icon-reset-full', ICONS.trash);
        _si('m-icon-trash', ICONS.trash);
    }

    function getSafeId(s) { return s.replace(/[^a-z0-9]/gi, '_'); }
    function esc(s) { if(!s) return ''; const d=document.createElement('div'); d.textContent=String(s); return d.innerHTML; }
    function cleanTaskText(txt) { return txt.replace(/\{\{TASK:[\d.]+\}\}/g, '').trim(); }
    function getTaskNumber(txt) { const m = txt.match(/\{\{TASK:([\d.]+)\}\}/); return m ? m[1] : ''; }

    async function refresh() {
        try {
            const r = await fetch('/api'), d = await r.json(); activeId = d.active_id;
            document.getElementById('projects').innerHTML = d.projects.map(p => {
                const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
                let controls = '';
                const locked = _actionLock && _actionLock.id === p.id && (Date.now() - _actionLock.time < 8000);
                const lockAction = locked ? _actionLock.action : '';
                const spinnerHtml = '<span class="busy-spinner" style="width:14px;height:14px;border-width:2px"></span>';
                if (locked) {
                    const labels = {starting:'Запускается...', stopping:'Останавливается...', pausing:'Пауза...', launch_stopping:'Останавливаю...'};
                    controls = `<span style="display:flex;align-items:center;gap:6px;color:var(--text-dim);font-size:0.75em;" title="${labels[lockAction]||''}">${spinnerHtml} ${labels[lockAction]||''}</span>`;
                } else if (p.running) {
                    controls = `
                        <button class="icon-btn stop" style="color:#00e5ff; border-color:rgba(0,229,255,0.3)" onclick="event.stopPropagation(); stopRun('${p.id}')" title="Остановить Ralph">${ICONS.stop}</button>
                        <button class="icon-btn" style="color:var(--blue); border-color:rgba(88,166,255,0.3)" onclick="event.stopPropagation(); showServerLogs()" title="Показать консоль"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg></button>
                        <button class="icon-btn ${p.paused?'start':'pause'}" style="${p.paused?'color:var(--orange);border-color:var(--orange)':''}" onclick="event.stopPropagation(); togglePause('${p.id}')" title="${p.paused?'Продолжить':'Пауза'}">${p.paused?ICONS.play:ICONS.pause}</button>
                    `;
                } else {
                    const m = getModel(p.id);
                    controls = `
                        <div class="model-toggle" onclick="event.stopPropagation()">
                            <div class="mt-opt ${m==='sonnet'?'active-sonnet':''}" onclick="projectModels['${p.id}']='sonnet'; saveModels(); refresh();" title="Sonnet (быстрая, дешёвая)">Sonnet</div>
                            <div class="mt-opt ${m==='opus'?'active-opus':''}" onclick="projectModels['${p.id}']='opus'; saveModels(); refresh();" title="Opus 4.6 (самая мощная)">Opus</div>
                        </div>
                        <button class="icon-btn start" title="Запуск Ralph (${m==='opus'?'Opus 4.6':'Sonnet'})" style="color:#00e5ff; border-color:rgba(0,229,255,0.3)" ${p.busy?'disabled':''} onclick="event.stopPropagation(); toggleRun4('${p.id}')">${ICONS.play}</button>
                    `;
                }
                const statusDot = p.running
                    ? (p.paused ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--orange);box-shadow:0 0 6px var(--orange);flex-shrink:0" title="Пауза"></span>'
                                : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green);flex-shrink:0;animation:busySpin 1.5s linear infinite" title="Запущен"></span>')
                    : '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--text-dim);flex-shrink:0" title="Остановлен"></span>';
                // Launch-кнопка встраивается в ряд прогресса
                let launchBtn = '';
                if (p.launch_available) {
                    const launchTitle = esc(p.launch_description) || 'Запустить приложение';
                    launchBtn = p.launch_running
                        ? `<button class="launch-btn running" style="padding:2px 8px;font-size:0.75em;flex-shrink:0" onclick="event.stopPropagation(); launchStop('${p.id}')" title="${launchTitle}">⏹</button>`
                        : `<button class="launch-btn" style="padding:2px 8px;font-size:0.75em;flex-shrink:0" onclick="event.stopPropagation(); launchProject('${p.id}')" title="${launchTitle}">🚀</button>`;
                }
                return `<div class="project-item ${p.active?'active':''}" onclick="setProject('${p.id}')" oncontextmenu="event.preventDefault(); showMenu(event, '${p.id}', ${p.running}, ${!!p.busy}, ${!!p.paused})">
                    <div class="project-row1">
                        <div class="project-row1-left">${statusDot}<strong class="project-name-text" title="${esc(p.name)}">${esc(p.name)}</strong>${p.busy ? '<span class="busy-badge" style="font-size:0.7em;padding:1px 7px"><span class="busy-spinner" style="width:10px;height:10px"></span>'+esc(p.busy)+'</span>' : ''}</div>
                        <div class="project-row1-right">${controls}</div>
                    </div>
                    <div class="project-row2">
                        <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
                        <span class="progress-text">${p.completed}/${p.total}</span>${launchBtn}
                    </div>
                    <div class="progress-bg" style="width:${pct}%"></div>
                </div>`;
            }).join('');
            // Обновляем заголовок активного проекта в правой панели
            const ap = d.projects.find(p => p.active);
            const phEl = document.getElementById('projectHeader');
            const ppEl = document.getElementById('projectPath');
            if (ap && phEl) {
                phEl.textContent = ap.name;
                if (ppEl) {
                    ppEl.textContent = ap.path;
                    ppEl.title = ap.path + ' (клик — открыть)';
                    ppEl.dataset.path = ap.path;
                }
            } else if (phEl) {
                phEl.textContent = 'Выберите проект';
                if (ppEl) { ppEl.textContent = ''; ppEl.dataset.path = ''; }
            }
            // Сигнатура: кол-во спринтов + кол-во задач в каждом — для обнаружения новых
            const newSig = Object.keys(d.spec_details).map(s => s + ':' + d.spec_details[s].tasks.length).join('|');
            const structureChanged = prevSpecSignature && prevSpecSignature !== newSig && renderedProjectId === activeId;
            if (renderedProjectId !== activeId || !firstLoadDone || structureChanged) {
                // Запомним старую структуру для подсветки
                const oldTaskCounts = {};
                if (structureChanged) {
                    document.querySelectorAll('.master-task').forEach(mt => {
                        const specName = mt.getAttribute('data-spec-name');
                        oldTaskCounts[specName] = mt.querySelectorAll('.subtask').length;
                    });
                }
                renderTaskStructure(d.spec_details);
                renderedProjectId = activeId;
                firstLoadDone = true;
                // Подсветить новые задачи и раскрыть спринт
                if (structureChanged) {
                    for (const s in d.spec_details) {
                        const safeS = getSafeId(s);
                        const oldCount = oldTaskCounts[s] || 0;
                        const newCount = d.spec_details[s].tasks.length;
                        if (newCount > oldCount) {
                            // Раскрыть спринт
                            const body = document.getElementById('body-' + safeS);
                            if (body) body.style.display = 'block';
                            // Подсветить новые задачи (мигание 2 раза)
                            for (let i = oldCount; i < newCount; i++) {
                                const st = document.getElementById('st-' + safeS + '-' + i);
                                if (st) {
                                    st.classList.add('new-task-highlight');
                                    st.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                    st.addEventListener('animationend', () => st.classList.remove('new-task-highlight'), { once: true });
                                }
                            }
                        }
                    }
                }
            }
            prevSpecSignature = newSig;
            updateTaskDataSurgically(d.spec_details);
            
            const btnCons = document.getElementById('btnShowConsole');
            if(btnCons) {
                btnCons.title = d.console_visible ? "Скрыть консоль" : "Показать консоль";
                if(d.console_visible) { btnCons.style.color = "var(--text)"; btnCons.style.background = "rgba(255,255,255,0.15)"; }
                else { btnCons.style.color = ""; btnCons.style.background = ""; }
            }
        } catch (e) { console.error(e); }
    }

    function renderSprintBlock(s, det) {
        const safeS = getSafeId(s);
        return `<div class="master-task" id="mt-${safeS}" data-spec-name="${s}">
            <div class="master-header" onclick="toggleSpec('${safeS}')"><div style="display:flex; align-items:center; gap:10px"><span class="master-status-icon"></span><span>${esc(s)}</span></div><div class="spec-right"><div class="spec-progress-bar"><div class="spec-progress-fill"></div></div><span class="spec-counter">0/0</span></div></div>
            <div id="body-${safeS}" style="display:none">
                ${det.tasks.map((t, i) => `<div class="subtask" id="st-${safeS}-${i}" data-task-id="${i}">
                    <div class="subtask-header" onclick="toggleSubtask('${safeS}', ${i}, '${s}', '${t.text.replace(/'/g,"\\'")}')">
                        <span class="task-status-icon" onclick="event.stopPropagation(); manualToggle('${s}', ${i}, ${t.done}, event)"></span>
                        <span style="font-weight:bold; color:var(--blue); min-width:30px;">${getTaskNumber(t.text)}</span><span>${esc(cleanTaskText(t.text))}</span>
                    </div>
                    <div class="desc-box" id="desc-${safeS}-${i}">
                        <textarea onfocus="isEditing=true" onblur="isEditing=false" oninput="document.getElementById('save-${safeS}-${i}').style.display='block'">${esc(t.description||'')}</textarea>
                        <button class="save-btn" id="save-${safeS}-${i}" style="display:none" onclick="saveDesc('${s}','${t.text.replace(/'/g,"\\'")}', '${safeS}', ${i})">Сохранить изменения</button>
                        <div class="res-container" id="res-${safeS}-${i}"></div>
                    </div>
                </div>`).join('')}
                <button class="add-subtask-btn" id="add-btn-${safeS}" onclick="showAddSubtask('${safeS}', '${s}')">+ Добавить подзадачу</button>
                <div class="add-subtask-form" id="add-form-${safeS}" style="display:none">
                    <input type="text" id="add-title-${safeS}" placeholder="Название подзадачи..." />
                    <textarea id="add-desc-${safeS}" placeholder="Описание (необязательно)..." onfocus="isEditing=true" onblur="isEditing=false"></textarea>
                    <div style="display:flex; gap:8px">
                        <button class="save-btn" style="display:block" onclick="submitSubtask('${safeS}', '${s}')">Сохранить</button>
                        <button class="save-btn" style="display:block; background:var(--bg); color:var(--text-dim); border-color:var(--border)" onclick="hideAddSubtask('${safeS}')">Отмена</button>
                    </div>
                </div>
            </div>
        </div>`;
    }

    function renderTaskStructure(specs) {
        let activeH = '', doneH = '', doneCount = 0;
        for (const s in specs) {
            const det = specs[s];
            const allDone = det.total > 0 && det.completed === det.total;
            if (allDone) {
                doneH += renderSprintBlock(s, det);
                doneCount++;
            } else {
                activeH += renderSprintBlock(s, det);
            }
        }
        // Порядок: Выполнено (сверху, свёрнуто) → В работе (снизу, развёрнуто)
        let allH = '';
        if (doneCount > 0) {
            const collapsed = localStorage.getItem('ralph_doneCollapsed') !== '0';
            allH += `<div class="task-group">
                <div class="task-group-header" onclick="toggleTaskGroup('done')">
                    <span id="doneArrow" class="panel-arrow" style="transform:rotate(${collapsed ? '0' : '90'}deg);">&#9654;</span>
                    <span style="color:var(--green); font-weight:700;">Выполнено (${doneCount})</span>
                </div>
                <div id="doneGroupBody" class="task-group-body" style="display:${collapsed ? 'none' : 'block'};">${doneH}</div>
            </div>`;
        }
        const activeCount = Object.keys(specs).length - doneCount;
        if (activeCount > 0) {
            const aCollapsed = localStorage.getItem('ralph_activeCollapsed') === '1';
            allH += `<div class="task-group">
                <div class="task-group-header" onclick="toggleTaskGroup('active')">
                    <span id="activeArrow" class="panel-arrow" style="transform:rotate(${aCollapsed ? '0' : '90'}deg);">&#9654;</span>
                    <span style="color:var(--blue); font-weight:700;">В работе (${activeCount})</span>
                </div>
                <div id="activeGroupBody" class="task-group-body" style="display:${aCollapsed ? 'none' : 'block'};">${activeH}</div>
            </div>`;
        }
        document.getElementById('tasks').innerHTML = allH;
        document.getElementById('doneSection').innerHTML = '';
    }

    function toggleTaskGroup(which) {
        const bodyId = which === 'done' ? 'doneGroupBody' : 'activeGroupBody';
        const arrowId = which === 'done' ? 'doneArrow' : 'activeArrow';
        const key = which === 'done' ? 'ralph_doneCollapsed' : 'ralph_activeCollapsed';
        const body = document.getElementById(bodyId);
        const arrow = document.getElementById(arrowId);
        if (!body || !arrow) return;
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? 'block' : 'none';
        arrow.style.transform = isHidden ? 'rotate(90deg)' : 'rotate(0deg)';
        localStorage.setItem(key, isHidden ? '0' : '1');
    }

    function updateTaskDataSurgically(specs) {
        let needRerender = false;
        for (const s in specs) {
            const det = specs[s], safeS = getSafeId(s), mt = document.getElementById(`mt-${safeS}`);
            if (!mt) continue;
            const isDone = det.completed === det.total && det.total > 0;
            const wasDone = mt.classList.contains('fully-completed');
            if (isDone !== wasDone) needRerender = true;
            mt.classList.toggle('fully-completed', isDone);
            mt.querySelector('.master-status-icon').innerHTML = isDone ? ICONS.check : '';
            mt.querySelector('.spec-counter').innerText = `${det.completed}/${det.total}`;
            const fill = mt.querySelector('.spec-progress-fill');
            if (fill) fill.style.width = det.total ? (det.completed / det.total * 100) + '%' : '0%';
            det.tasks.forEach((t, i) => {
                const st = document.getElementById(`st-${safeS}-${i}`);
                if (st) {
                    st.classList.toggle('done', t.done);
                    st.querySelector('.task-status-icon').innerHTML = t.done ? ICONS.check : ICONS.square;
                    const desc = document.getElementById(`desc-${safeS}-${i}`);
                    if (t.done && desc.style.display === 'block') fetchRes(s, t.text, safeS, i);
                }
            });
        }
        if (needRerender) renderTaskStructure(specs);
    }

        function showMenu(e, id, running, busy, paused) {
            e.stopPropagation(); menuTarget = { id, running, busy, paused };
            menuX = e.pageX; menuY = e.pageY;
            const menu = document.getElementById('ctxMenu');
            menu.style.display = 'block';
    
            let left = e.pageX;
            let top = e.pageY;
    
            // Prevent menu from going off the right screen edge
            if (left + menu.offsetWidth > window.innerWidth) {
                left = window.innerWidth - menu.offsetWidth - 10;
            }
    
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
    
            document.getElementById('m-text-run').innerText = running ? 'Остановить' : 'Запустить';
            document.getElementById('m-icon-run').innerHTML = running ? ICONS.stop : ICONS.play;
            const runItem = document.getElementById('m-text-run').parentElement;
            if (running) { runItem.classList.remove('success'); runItem.classList.add('danger'); }
            else { runItem.classList.remove('danger'); runItem.classList.add('success'); }
            
            const pauseItem = document.getElementById('m-item-pause');
            if (running) {
                pauseItem.style.display = 'flex';
                document.getElementById('m-text-pause').innerText = paused ? 'Продолжить' : 'Пауза';
                document.getElementById('m-icon-pause').innerHTML = paused ? ICONS.play : ICONS.pause;
                if (paused) { pauseItem.classList.remove('warning'); pauseItem.classList.add('success'); }
                else { pauseItem.classList.remove('success'); pauseItem.classList.add('warning'); }
            } else {
                pauseItem.style.display = 'none';
            }
        }
        async function handleMenu(e, type) {
            e.stopPropagation();
            const {id, running} = menuTarget;
            const clickX = e.pageX;
            const clickY = e.pageY;
    
            if (type === 'start') { if(running){stopRun(id)}else{toggleRun4(id)}; document.getElementById('ctxMenu').style.display = 'none'; refresh(); }
            else if (type === 'pause') { togglePause(id); document.getElementById('ctxMenu').style.display = 'none'; refresh(); }
            else if (type === 'restart') {            document.getElementById('ctxMenu').style.display = 'none';
            await fetch('/api/restart', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:id})});
            refresh();
        }
        else if (type === 'crash') { document.getElementById('ctxMenu').style.display = 'none'; showCrashLogs(); }
        else if (type === 'reset') { 
            document.getElementById('ctxMenu').style.display = 'none';
            customConfirm('Вы уверены, что хотите сбросить весь прогресс проекта?', clickX, clickY, async () => {
                await fetch('/api/reset-progress', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:id})}); 
                location.reload(); 
            });
        }
        else if (type === 'gen') { document.getElementById('ctxMenu').style.display = 'none'; await fetch('/api/generate-specs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:id})}); refresh(); }
        else if (type === 'reset-full') { 
            document.getElementById('ctxMenu').style.display = 'none';
            customConfirm(`<div style="color:var(--red);font-weight:bold">ВНИМАНИЕ! ПОЛНЫЙ СБРОС</div>Этот проект будет возвращен к начальному состоянию. <br><br><b>ВСЕ СОЗДАННЫЕ ФАЙЛЫ КОДА БУДУТ УДАЛЕНЫ!</b><br><br>Вы уверены?`, menuX, menuY, async () => {
                await fetch('/api/reset-full', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:id})});
                refresh();
            });
        }
        else if (type === 'delete') { 
            document.getElementById('ctxMenu').style.display = 'none';
            customConfirm('Вы уверены, что хотите удалить проект из списка?', clickX, clickY, async () => {
                await fetch('/api/delete-project', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:id})}); 
                location.reload(); 
            });
        }
    }

    function togglePanel(which) { /* deprecated */ }
    function toggleConsole() {
        const wrapper = document.getElementById('consoleWrapper');
        const arrow = document.getElementById('consoleArrow');
        const btns = document.getElementById('consoleBtns');
        const resizer = document.getElementById('resizer3v');
        const col3Top = document.getElementById('col3Top');
        const col3Bottom = document.getElementById('col3Bottom');
        const collapsed = wrapper.style.display === 'none';
        wrapper.style.display = collapsed ? 'flex' : 'none';
        if (btns) btns.style.display = collapsed ? '' : 'none';
        if (arrow) arrow.style.transform = collapsed ? 'rotate(90deg)' : 'rotate(0deg)';
        if (collapsed) {
            // Разворачиваем — восстанавливаем пропорции
            const saved = parseFloat(localStorage.getItem('ralph_col3v'));
            if (saved && saved > 10 && saved < 90) {
                col3Top.style.flex = '0 0 ' + saved + '%';
                col3Bottom.style.flex = '0 0 ' + (100 - saved) + '%';
            } else {
                col3Top.style.flex = '0 0 50%';
                col3Bottom.style.flex = '0 0 50%';
            }
            if (resizer) resizer.style.display = '';
        } else {
            // Сворачиваем — описание занимает всё место
            col3Top.style.flex = '1 1 auto';
            col3Bottom.style.flex = '0 0 auto';
            if (resizer) resizer.style.display = 'none';
        }
        localStorage.setItem('ralph_console_collapsed', collapsed ? '0' : '1');
    }
    // Восстановление состояния консоли
    if (localStorage.getItem('ralph_console_collapsed') === '1') {
        setTimeout(toggleConsole, 100);
    }
    function toggleSpec(safeS) { const el = document.getElementById(`body-${safeS}`); el.style.display = el.style.display === 'none' ? 'block' : 'none'; }
    let selectedTask = null;
    function toggleSubtask(safeS, i, s, text) {
        // Показываем описание в колонке 3
        const detailBody = document.getElementById('detailBody');
        const detailHeader = document.getElementById('detailHeader');
        const taskNum = text.match(/TASK:([\d.]+)/);
        const cleanText = text.replace(/\{\{TASK:[\d.]+\}\}/g, '').trim();

        // Подсветка выбранной задачи
        document.querySelectorAll('.subtask.selected').forEach(el => el.classList.remove('selected'));
        const stEl = document.getElementById(`st-${safeS}-${i}`);
        if (stEl) stEl.classList.add('selected');

        // Заголовок
        detailHeader.textContent = taskNum ? `Задача ${taskNum[1]}: ${cleanText.substring(0,50)}` : cleanText.substring(0,60);

        // Тело: textarea + результаты
        const descEl = document.getElementById(`desc-${safeS}-${i}`);
        const textarea = descEl ? descEl.querySelector('textarea') : null;
        const descText = textarea ? textarea.value : '';

        detailBody.innerHTML = `
            <div style="position:relative; width:100%; height:100%;">
                <textarea style="width:100%; height:100%; background:var(--bg); border:1px solid var(--border); color:var(--text); outline:none; resize:none; font-family:inherit; line-height:1.5; font-size:0.9em; padding:10px; padding-bottom:36px; border-radius:6px; box-sizing:border-box;" onfocus="isEditing=true" onblur="isEditing=false" oninput="document.getElementById('detailSaveBtn').style.display='block'" id="detailTextarea">${esc(descText)}</textarea>
                <button class="save-btn" id="detailSaveBtn" style="display:none; position:absolute; bottom:8px; right:8px; padding:4px 14px; font-size:0.8em; z-index:2;" onclick="saveDescFromDetail('${s}','${text.replace(/'/g,"\\'")}', '${safeS}', ${i})">Сохранить</button>
            </div>`;
        document.getElementById('detailResults').innerHTML = '';

        selectedTask = {safeS, i, s, text};
        fetchRes(s, text, safeS, i);
    }

    async function saveDescFromDetail(spec, task, safeS, i) {
        const val = document.getElementById('detailTextarea').value;
        // Обновляем и скрытый textarea в списке задач
        const origDesc = document.getElementById('desc-' + safeS + '-' + i);
        if (origDesc) {
            const ta = origDesc.querySelector('textarea');
            if (ta) ta.value = val;
        }
        const r = await fetch('/api/save-task-description', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:activeId, spec_name:spec, task_header:task, new_description:val})});
        const res = await r.json();
        if (res.success) {
            document.getElementById('detailSaveBtn').style.display='none';
            // Автоматически снимаем галочку и очищаем результат, чтобы Ralph взял задачу заново
            await fetch('/api/toggle-task', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:activeId, spec_name:spec, task_idx:i, done:false})});
            // Очищаем результат в UI
            const detailResults = document.getElementById('detailResults');
            if (detailResults) detailResults.innerHTML = '';
            refresh();
        }
    }

    async function clearConsole() { 
        await fetch('/api/clear-stream', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({})}); 
        consoleData[4] = ''; consoleStatusData[4] = '';
        document.getElementById('console').innerHTML = '';
        updateConsoleStatusDisplay();
    }
    function saveConsole() { const content = document.getElementById('console').innerText; const blob = new Blob([content], {type:'text/plain'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'ralph_console.txt'; a.click(); }
    function copyConsoleMain() {
        const content = document.getElementById('console').innerText;
        navigator.clipboard.writeText(content).then(() => {
            const btn = document.getElementById('copyMainBtn'); const old = btn.innerHTML;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(() => btn.innerHTML = old, 2000);
        });
    }
    function copyConsoleStatus() {
        const content = document.getElementById('consoleStatus').innerText;
        navigator.clipboard.writeText(content).then(() => {
            const btn = document.getElementById('copyStatusBtn'); const old = btn.innerHTML;
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3fb950" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(() => btn.innerHTML = old, 2000);
        });
    }
    async function manualToggle(spec, idx, done, event) {
        if (done) {
            let x, y;
            if (event && event.currentTarget) {
                const rect = event.currentTarget.getBoundingClientRect();
                x = rect.left + rect.width / 2;
                y = rect.top;
            } else if (event) {
                x = event.clientX;
                y = event.clientY;
            }
            customConfirm('Действительно хотите отменить выполнение этой задачи? <br><br><small style="color:var(--text-dim)">Файл с результатами также будет удален.</small>', x, y, async () => {
                await fetch('/api/toggle-task', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:activeId, spec_name:spec, task_idx:idx, done:!done})});
                refresh();
            });
        } else {
            await fetch('/api/toggle-task', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:activeId, spec_name:spec, task_idx:idx, done:!done})}); 
            refresh(); 
        }
    }
    
    async function globalRestart() { await fetch('/api/restart-server', {method:'POST', headers:{'Content-Type':'application/json'}}); setTimeout(()=>location.reload(true), 2500); }
    async function showCrashLogs() { 
        const r = await fetch('/api/crash-log'); const d = await r.json();
        const m = document.getElementById('customModal');
        m.style.maxWidth = '800px'; m.style.width = '80vw';
        customAlert(`<div style="font-weight:bold;margin-bottom:10px;color:var(--red)">Логи краша (crash.log)</div><div style="max-height:500px;overflow-y:auto;font-family:monospace;font-size:0.85em;white-space:pre-wrap;background:#000;color:#ccc;padding:15px;border-radius:6px;text-align:left;border:1px solid var(--border)">${esc(d.content) || 'Файл пуст.'}</div>`);
        setTimeout(() => { m.style.maxWidth = ''; m.style.width = ''; }, 5000); // reset after close
    }

    async function showServerLogs() { 
        // Посылаем сигнал трею переключить видимость реального окна терминала
        fetch('/api/show-console', {method:'POST'});
    }

    async function setProject(id) { await fetch('/api/project', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:id})}); firstLoadDone = false; document.getElementById('console').textContent = ''; refresh(); }
    async function openFolder(path, ev) { ev.stopPropagation(); await fetch('/api/open-folder', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path})}); }
    async function fetchRes(spec, text, safeS, i) {
        const tidMatch = text.match(/TASK:([\d.]+)/);
        if (!tidMatch) return;
        const tid = tidMatch[1];
        const r = await fetch(`/api/task-report?project=${activeId}&task_id=${tid}`);
        const d = await r.json();
        // Показываем в col3
        const detailResults = document.getElementById('detailResults');
        if (detailResults) {
            if (d.success) detailResults.innerHTML = `<div class="res-box">${esc(d.summary)}</div>`;
            else detailResults.innerHTML = '';
        }
        // Также обновляем inline (для совместимости)
        const resEl = document.getElementById(`res-${safeS}-${i}`);
        if(d.success && resEl && resEl.innerHTML === '') resEl.innerHTML = `<div class="res-box">${esc(d.summary)}</div>`;
        else if (!d.success && resEl) resEl.innerHTML = '';
    }
    async function saveDesc(spec, task, safeS, i) {
        const val = document.querySelector(`#desc-${safeS}-${i} textarea`).value;
        const r = await fetch('/api/save-task-description', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:activeId, spec_name:spec, task_header:task, new_description:val})});
        if((await r.json()).success) document.getElementById(`save-${safeS}-${i}`).style.display='none';
    }
    
    document.addEventListener('click', () => document.getElementById('ctxMenu').style.display = 'none');
    setInterval(refresh, 3000);
    setInterval(async () => {
        try {
            const r = await fetch('/api/stream'), d = await r.json();
            const el = document.getElementById('console');
            if(d.success) {
                const p4 = processConsoleData(d.content4 !== undefined ? d.content4 : '', d.status4 || '');
                consoleData[4] = p4.text; consoleStatusData[4] = p4.status;

                const currentText = consoleData[activeConsoleTab];
                const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
                const hasSelection = window.getSelection().toString().length > 0 && el.contains(window.getSelection().anchorNode);
                if (!hasSelection && el.textContent !== currentText) {
                    el.textContent = currentText;
                    if (isAtBottom) el.scrollTop = el.scrollHeight;
                }
                updateConsoleStatusDisplay();
            }
        } catch(e) {}
    }, 1000);
    async function launchProject(pid) {
        const r = await fetch('/api/launch', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:pid})});
        const d = await r.json();
        if (!d.success && d.error) { alert('Ошибка запуска: ' + d.error); }
        refresh();
    }
    async function launchStop(pid) {
        if (isLocked(pid, 'launch_stopping')) return;
        setLock(pid, 'launch_stopping');
        await fetch('/api/launch-stop', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:pid})});
        clearLock();
    }
    async function generateLaunch(pid) {
        await fetch('/api/generate-launch', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:pid})});
        refresh();
    }
    function showAddSubtask(safeS, specName) {
        document.getElementById('add-btn-' + safeS).style.display = 'none';
        document.getElementById('add-form-' + safeS).style.display = 'block';
        document.getElementById('add-title-' + safeS).focus();
    }
    function hideAddSubtask(safeS) {
        document.getElementById('add-btn-' + safeS).style.display = 'flex';
        document.getElementById('add-form-' + safeS).style.display = 'none';
        document.getElementById('add-title-' + safeS).value = '';
        document.getElementById('add-desc-' + safeS).value = '';
    }
    async function submitSubtask(safeS, specName) {
        const title = document.getElementById('add-title-' + safeS).value.trim();
        if (!title) return;
        const desc = document.getElementById('add-desc-' + safeS).value.trim();
        const r = await fetch('/api/add-subtask', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:activeId, spec_name:specName, task_text:title, task_description:desc})});
        const d = await r.json();
        if (d.success) {
            hideAddSubtask(safeS);
            firstLoadDone = false;
            refresh();
        }
    }
    function showIdeaDialog() {
        const overlay = document.getElementById('customModalOverlay');
        const modal = document.getElementById('customModal');
        modal.style.maxWidth = '600px'; modal.style.width = '80vw';
        document.getElementById('customModalMsg').innerHTML = `
            <div style="font-weight:bold; margin-bottom:12px; color:#a78bfa; display:flex; align-items:center; gap:8px">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                Добавить идею
            </div>
            <p style="color:var(--text-dim); font-size:0.85em; margin-bottom:12px">AI проанализирует идею, определит подходящий спринт, назначит роль и создаст подзадачи.</p>
            <textarea id="ideaInput" style="width:100%; min-height:100px; background:var(--bg); border:1px solid var(--border); color:var(--text); padding:10px; border-radius:6px; font-family:inherit; font-size:0.9em; resize:vertical; outline:none;" placeholder="Опишите вашу идею..."></textarea>`;
        const btnContainer = document.getElementById('customModalBtns');
        btnContainer.innerHTML = '';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn'; cancelBtn.innerText = 'Отмена'; cancelBtn.onclick = () => { closeCustomModal(); modal.style.maxWidth = ''; modal.style.width = ''; };
        const okBtn = document.createElement('button');
        okBtn.className = 'btn btn-primary'; okBtn.innerText = 'Отправить AI'; okBtn.onclick = async () => {
            const idea = document.getElementById('ideaInput').value.trim();
            if (!idea) return;
            closeCustomModal(); modal.style.maxWidth = ''; modal.style.width = '';
            await fetch('/api/add-idea', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({project_id:activeId, idea:idea})});
            refresh();
        };
        btnContainer.appendChild(cancelBtn);
        btnContainer.appendChild(okBtn);
        overlay.style.display = 'block';
        modal.style.display = 'block';
        modal.classList.add('center');
        modal.style.top = ''; modal.style.left = '';
        setTimeout(() => document.getElementById('ideaInput').focus(), 100);
    }
    initStaticIcons();
    refresh();

    // === RESIZER ENGINE (unified) ===
    let _drag = null; // {type:'col'|'row', resizer, panel, panel2, container, storageKey, min, max}

    document.addEventListener('mousemove', function(e) {
        if (!_drag) return;
        e.preventDefault();
        if (_drag.type === 'col') {
            const svRect = _drag.container.getBoundingClientRect();
            const panelLeft = _drag.panel.getBoundingClientRect().left;
            let pct = ((e.clientX - panelLeft) / svRect.width) * 100;
            if (pct < _drag.min) pct = _drag.min;
            if (pct > _drag.max) pct = _drag.max;
            _drag.panel.style.flex = '0 0 ' + pct + '%';
        } else {
            const cRect = _drag.container.getBoundingClientRect();
            let pct = ((e.clientY - cRect.top) / cRect.height) * 100;
            if (pct < _drag.min) pct = _drag.min;
            if (pct > _drag.max) pct = _drag.max;
            _drag.panel.style.flex = '0 0 ' + pct + '%';
            _drag.panel2.style.flex = '0 0 ' + (100 - pct) + '%';
        }
    });

    document.addEventListener('mouseup', function() {
        if (!_drag) return;
        _drag.resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Save
        if (_drag.type === 'col') {
            const svRect = _drag.container.getBoundingClientRect();
            const pct = (_drag.panel.getBoundingClientRect().width / svRect.width) * 100;
            localStorage.setItem(_drag.storageKey, pct.toFixed(1));
        } else {
            const cRect = _drag.container.getBoundingClientRect();
            const pct = (_drag.panel.getBoundingClientRect().height / cRect.height) * 100;
            localStorage.setItem(_drag.storageKey, pct.toFixed(1));
        }
        _drag = null;
    });

    function initColResizer(resizerId, panelId, storageKey, defaultPct, minPct, maxPct) {
        const resizer = document.getElementById(resizerId);
        const splitView = document.querySelector('.split-view');
        const panel = document.getElementById(panelId);
        if (!resizer || !splitView || !panel) { console.warn('Col resizer not found:', resizerId, panelId); return; }

        const saved = parseFloat(localStorage.getItem(storageKey));
        panel.style.flex = '0 0 ' + ((saved >= minPct && saved <= maxPct) ? saved : defaultPct) + '%';

        resizer.addEventListener('mousedown', function(e) {
            e.preventDefault();
            _drag = {type:'col', resizer, panel, container:splitView, storageKey, min:minPct, max:maxPct};
            resizer.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        });
    }

    function initRowResizer(resizerId, topId, bottomId, containerId, storageKey, defaultTop) {
        const resizer = document.getElementById(resizerId);
        const container = document.getElementById(containerId);
        const topEl = document.getElementById(topId);
        const bottomEl = document.getElementById(bottomId);
        if (!resizer || !container || !topEl || !bottomEl) { console.warn('Row resizer not found:', resizerId); return; }

        const saved = parseFloat(localStorage.getItem(storageKey));
        const topPct = (saved > 10 && saved < 90) ? saved : defaultTop;
        topEl.style.flex = '0 0 ' + topPct + '%';
        bottomEl.style.flex = '0 0 ' + (100 - topPct) + '%';

        resizer.addEventListener('mousedown', function(e) {
            e.preventDefault();
            _drag = {type:'row', resizer, panel:topEl, panel2:bottomEl, container, storageKey, min:10, max:90};
            resizer.classList.add('dragging');
            document.body.style.cursor = 'row-resize';
            document.body.style.userSelect = 'none';
        });
    }

    // Init all resizers
    initColResizer('resizer12', 'col1', 'ralph_col1_w', 18, 8, 30);
    initColResizer('resizer23', 'col2', 'ralph_col2_w', 35, 15, 55);
    initRowResizer('resizer3v', 'col3Top', 'col3Bottom', 'col3', 'ralph_col3v', 50);
    initRowResizer('resizerDetail', 'detailDescPane', 'detailResultPane', 'col3TopContent', 'ralph_detail_v', 50);
</script></body></html>'''

if __name__ == "__main__":
    # Завершение при закрытии консоли (Windows CTRL_CLOSE_EVENT)
    import signal
    def _shutdown(signum, frame):
        print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Сервер завершён (сигнал {signum})")
        os._exit(0)
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        def _console_handler(event):
            if event in (0, 2):  # CTRL_C_EVENT=0, CTRL_CLOSE_EVENT=2
                os._exit(0)
            return False
        HANDLER_ROUTINE = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_ulong)
        kernel32.SetConsoleCtrlHandler(HANDLER_ROUTINE(_console_handler), True)
    except: pass

    print(f"🧸 Ralph 2.0 at http://127.0.0.1:{WEB_PORT}")

    server = HTTPServer(('127.0.0.1', WEB_PORT), Handler)

    # TrayConsole интеграция
    _tc = None
    if _trayconsole_available:
        _tc = TrayConsoleClient("trayconsole_ralph2")

        @_tc.on("status")
        def _tc_status():
            return {"status": "running", "port": WEB_PORT, "projects": len(PROJECTS)}

        @_tc.on("shutdown")
        def _tc_shutdown():
            import threading
            def _do_shutdown():
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Graceful shutdown по команде TrayConsole...")
                try:
                    server.shutdown()
                except: pass
                if _tc:
                    try: _tc.stop()
                    except: pass
                print(f"[{datetime.now().strftime('%H:%M:%S')}] Сервер остановлен.")
                os._exit(0)
            threading.Thread(target=_do_shutdown, daemon=True).start()
            return {"status": "ok"}

        @_tc.on("custom:open_dashboard")
        def _tc_open():
            webbrowser.open(f"http://localhost:{WEB_PORT}")
            return {"ok": True}

        _tc.start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Остановка по Ctrl+C...")
        server.shutdown()
        if _tc:
            try: _tc.stop()
            except: pass








