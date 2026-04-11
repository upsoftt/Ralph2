import os
import sys
import subprocess
import threading
import webbrowser
import winreg
import time
import ctypes
import socket
from pathlib import Path

try:
    import pystray
    from PIL import Image, ImageDraw
except ImportError:
    print("Необходима установка зависимостей. Запустите build-tray.bat")
    sys.exit(1)

try:
    from trayconsole_client import TrayConsoleClient
    _trayconsole_available = True
except ImportError:
    _trayconsole_available = False

# WinAPI константы
SW_HIDE = 0
SW_SHOW = 5

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# Определение директории проекта
if getattr(sys, 'frozen', False):
    # Если это скомпилированный exe
    RALPH_DIR = Path(sys.executable).parent.absolute()
    PYTHON_EXE = "python" # системный питон для запуска скрипта
else:
    # Если запуск из исходника .py
    RALPH_DIR = Path(__file__).parent.absolute()
    PYTHON_EXE = sys.executable

WEB_SCRIPT = RALPH_DIR / "ralph-tracker-web.py"
LOG_FILE = RALPH_DIR / "web_server.log"

web_process = None
server_hwnd = None
icon = None
console_visible = False

def is_port_listening(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.connect(('127.0.0.1', port))
        return True
    except Exception:
        return False
    finally:
        s.close()

def get_icon_image(state):
    # Создаем простую иконку: Зеленый кружок - работает, Красный - остановлен
    img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    color = (63, 185, 80) if state == "running" else (248, 81, 73)
    d.ellipse((8, 8, 56, 56), fill=color)
    return img

def add_to_startup():
    try:
        # Добавляем в автозапуск путь к текущему исполняемому файлу
        exe_path = sys.executable if getattr(sys, 'frozen', False) else f'"{sys.executable}" "{__file__}"'
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(key, "RalphTracker", 0, winreg.REG_SZ, str(exe_path))
        winreg.CloseKey(key)
    except Exception as e:
        pass

def find_window_by_pid(pid):
    hwnd = None
    def callback(h, p):
        nonlocal hwnd
        lp_pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(h, ctypes.byref(lp_pid))
        if lp_pid.value == p:
            # Проверяем, что это консольное окно
            class_name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(h, class_name, 256)
            if class_name.value in ["ConsoleWindowClass", "CASCADIA_HOST_WINDOW_CLASS"]:
                hwnd = h
                return False
        return True

    cb_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    user32.EnumWindows(cb_type(callback), pid)
    return hwnd

def monitor_loop():
    """Фоновый поток мониторинга — бессмертный цикл, никогда не умирает."""
    global web_process, server_hwnd
    while True:
        try:
            time.sleep(1)

            # Обновляем иконку
            if icon:
                try:
                    update_icon()
                except Exception:
                    pass

            if web_process:
                # Проверка сигнала из веб-интерфейса
                signal_file = RALPH_DIR / ".ralph-runner" / "console_signal"
                if signal_file.exists():
                    try:
                        signal_file.unlink()
                        show_console()
                    except:
                        pass

                if web_process.poll() is not None:
                    # Процесс умер — перезапуск
                    web_process = None
                    server_hwnd = None
                    print("Веб-сервер остановился. Перезапуск...")
                    start_server()
                elif server_hwnd is None:
                    # Пытаемся найти окно запущенного процесса
                    server_hwnd = find_window_by_pid(web_process.pid)
                    if server_hwnd:
                        user32.ShowWindow(server_hwnd, SW_HIDE)
        except Exception as e:
            print(f"monitor_loop error: {e}")

def kill_port_owner(port):
    try:
        # Ищем PID процесса, который слушает указанный порт
        cmd = f'netstat -ano | findstr :{port}'
        output = subprocess.check_output(cmd, shell=True, text=True)
        for line in output.splitlines():
            if "LISTENING" in line:
                pid = line.strip().split()[-1]
                if pid != "0":
                    subprocess.run(f"taskkill /F /PID {pid}", shell=True, capture_output=True)
                    print(f"Убит старый процесс {pid} на порту {port}")
    except:
        pass

def start_server(i=None, item=None):
    global web_process, server_hwnd, console_visible
    if web_process is None or web_process.poll() is not None:
        kill_port_owner(8767) # ОСВОБОЖДАЕМ ПОРТ ПЕРЕД ЗАПУСКОМ
        server_hwnd = None
        console_visible = False

        try: (RALPH_DIR / ".ralph-runner" / "console_state").write_text("hidden")
        except: pass

        # Определяем рабочую команду питона
        py_cmd = PYTHON_EXE
        try:
            subprocess.check_call([py_cmd, "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except:
            py_cmd = "py" # Если python не в PATH, пробуем лаунчер 'py'

        try:
            fake_prompt = f"{RALPH_DIR}>{py_cmd} {WEB_SCRIPT.name}"
            full_cmd = f'title Ralph Web Server && echo {fake_prompt} && echo. && "{py_cmd}" "{WEB_SCRIPT}" || pause'

            web_process = subprocess.Popen(
                f'cmd.exe /c "{full_cmd}"',
                cwd=str(RALPH_DIR),
                creationflags=subprocess.CREATE_NEW_CONSOLE
            )
        except Exception as e:
            with open(LOG_FILE, 'a', encoding='utf-8') as f:
                f.write(f"\nОшибка запуска: {e}\n")
    update_icon()

def stop_server(i=None, item=None):
    global web_process, server_hwnd
    if web_process and web_process.poll() is None:
        # Если окно было открыто - закрываем
        if server_hwnd:
            user32.ShowWindow(server_hwnd, SW_HIDE)

        web_process.terminate()
        try:
            web_process.wait(timeout=3)
        except:
            web_process.kill()
    web_process = None
    server_hwnd = None
    update_icon()

def restart_server(i=None, item=None):
    stop_server()
    time.sleep(1)
    start_server()

def open_page(i=None, item=None):
    webbrowser.open("http://127.0.0.1:8767")

def show_console(i=None, item=None):
    global server_hwnd, console_visible
    state_file = RALPH_DIR / ".ralph-runner" / "console_state"
    if server_hwnd:
        if console_visible:
            user32.ShowWindow(server_hwnd, SW_HIDE)
            console_visible = False
            try: state_file.write_text("hidden")
            except: pass
        else:
            user32.ShowWindow(server_hwnd, SW_SHOW)
            user32.SetForegroundWindow(server_hwnd)
            console_visible = True
            try: state_file.write_text("visible")
            except: pass
    update_icon()

def on_quit(i, item):
    stop_server()
    icon.stop()

def update_icon():
    global icon, console_visible, web_process
    process_alive = web_process is not None and web_process.poll() is None
    port_active = is_port_listening(8767)

    menu_items = [
        pystray.MenuItem("Открыть Дашборд", open_page, default=True),
        pystray.Menu.SEPARATOR,
    ]

    if process_alive:
        menu_items.append(pystray.MenuItem("Остановить сервер", stop_server))
    else:
        menu_items.append(pystray.MenuItem("Запустить сервер", start_server))

    menu_items.extend([
        pystray.MenuItem("Перезапустить сервер", restart_server),
        pystray.MenuItem("Скрыть консоль" if console_visible else "Показать консоль", show_console),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Выход", on_quit)
    ])

    if icon:
        icon.icon = get_icon_image("running" if port_active else "stopped")
        icon.menu = pystray.Menu(*menu_items)
        status_text = "В СЕТИ" if port_active else "ОСТАНОВЛЕН"
        icon.title = f"Ralph 2.0 (Сервер {status_text})"

def setup_tray():
    global icon
    add_to_startup()
    start_server()

    icon = pystray.Icon("RalphTracker")
    update_icon()

    # Бессмертный daemon-поток мониторинга (не Timer-цепочка)
    t = threading.Thread(target=monitor_loop, daemon=True)
    t.start()

    icon.run()

def _setup_trayconsole():
    """Подключение к TrayConsole через Named Pipe."""
    if not _trayconsole_available:
        return

    client = TrayConsoleClient("trayconsole_ralph")

    @client.on("status")
    def handle_status():
        process_alive = web_process is not None and web_process.poll() is None
        port_active = is_port_listening(8767)
        return {
            "status": "running",
            "server": "running" if process_alive else "stopped",
            "port_active": port_active,
        }

    @client.on("shutdown")
    def handle_shutdown():
        stop_server()
        if icon:
            icon.stop()
        return {"status": "ok"}

    @client.on("custom:open_dashboard")
    def handle_open_dashboard():
        open_page()
        return {"ok": True}

    @client.on("custom:restart_server")
    def handle_restart():
        threading.Thread(target=restart_server, daemon=True).start()
        return {"ok": True}

    @client.on("custom:toggle_console")
    def handle_toggle_console():
        show_console()
        return {"ok": True}

    client.start()


if __name__ == "__main__":
    _setup_trayconsole()
    setup_tray()
