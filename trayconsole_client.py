"""
TrayConsole Python Client — библиотека для подключения проектов к TrayConsole.

Подключается к Named Pipe серверу TrayConsole, принимает команды (status, shutdown,
show, custom:*) и отправляет JSON-ответы. Работает в фоновом daemon-потоке.

Зависимости: pywin32

Пример использования:
    from trayconsole_client import TrayConsoleClient

    client = TrayConsoleClient("my_project_pipe")

    @client.on("custom:reload")
    def handle_reload():
        reload_config()
        return {"status": "reloaded"}

    @client.on("shutdown")
    def handle_shutdown():
        cleanup()
        return {"status": "ok"}

    client.start()
"""

import json
import os
import sys
import threading
import time
from typing import Callable, Optional

try:
    import win32file
    import win32pipe
    import pywintypes
except ImportError:
    print(
        "trayconsole_client: pywin32 не установлен. "
        "Установите: pip install pywin32",
        file=sys.stderr,
    )
    raise


class TrayConsoleClient:
    """Клиент для подключения к TrayConsole через Named Pipes."""

    def __init__(self, pipe_name: str):
        """
        Инициализация клиента.

        Args:
            pipe_name: Имя pipe (без префикса \\\\.\\pipe\\).
        """
        self._pipe_name = pipe_name
        self._pipe_path = rf"\\.\pipe\{pipe_name}"
        self._handlers: dict[str, Callable] = {}
        self._running = False
        self._handle: Optional[object] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

        # Встроенные обработчики по умолчанию
        self._default_handlers: dict[str, Callable] = {
            "status": lambda: {"status": "running"},
            "shutdown": self._default_shutdown,
        }

    def on(self, command: str):
        """
        Декоратор для регистрации обработчика команды.

        Args:
            command: Имя команды (например, "shutdown", "custom:reload").

        Пример:
            @client.on("custom:test")
            def handle_test():
                return {"result": "ok"}
        """

        def decorator(func: Callable) -> Callable:
            self._handlers[command] = func
            return func

        return decorator

    def start(self):
        """Запустить фоновый daemon-поток подключения к pipe."""
        if self._running:
            return

        self._running = True
        self._thread = threading.Thread(target=self._listen, daemon=True)
        self._thread.start()

    def stop(self):
        """Остановить клиент и закрыть соединение."""
        self._running = False
        self._close_handle()

    @property
    def is_connected(self) -> bool:
        """Подключён ли клиент к pipe."""
        return self._handle is not None

    @property
    def pipe_name(self) -> str:
        """Имя pipe."""
        return self._pipe_name

    def _listen(self):
        """Основной цикл: подключение → чтение → переподключение."""
        retry_count = 0
        max_retries = 3

        while self._running:
            try:
                self._connect()
                retry_count = 0
                self._read_loop()
            except pywintypes.error as e:
                if not self._running:
                    break
                self._close_handle()
                retry_count += 1

                if retry_count <= max_retries:
                    _log(f"Ошибка подключения (попытка {retry_count}/{max_retries}): {e}")
                    time.sleep(2)
                else:
                    _log("Превышено количество попыток, ожидание 10 сек...")
                    time.sleep(10)
                    retry_count = 0
            except Exception as e:
                if not self._running:
                    break
                _log(f"Непредвиденная ошибка: {e}")
                self._close_handle()
                time.sleep(2)

    def _connect(self):
        """Подключиться к Named Pipe серверу."""
        self._handle = win32file.CreateFile(
            self._pipe_path,
            win32file.GENERIC_READ | win32file.GENERIC_WRITE,
            0,
            None,
            win32file.OPEN_EXISTING,
            0,
            None,
        )
        _log(f"Подключено к pipe: {self._pipe_name}")

    def _read_loop(self):
        """Цикл чтения команд из pipe и отправки ответов."""
        buffer = ""

        while self._running:
            try:
                hr, data = win32file.ReadFile(self._handle, 4096)
                if hr != 0:
                    _log(f"ReadFile вернул код: {hr}")
                    break

                buffer += data.decode("utf-8")
                lines = buffer.split("\n")
                # Последний элемент — неполная строка (или пустая)
                buffer = lines[-1]

                for line in lines[:-1]:
                    line = line.strip()
                    if not line:
                        continue
                    self._handle_command(line)

            except pywintypes.error as e:
                # ERROR_BROKEN_PIPE (109) или ERROR_NO_DATA (232)
                if e.winerror in (109, 232):
                    _log("Pipe разорван, переподключение...")
                else:
                    _log(f"Ошибка чтения pipe: {e}")
                break

        self._close_handle()

    def _handle_command(self, command: str):
        """Обработать команду и отправить ответ."""
        try:
            response = self._dispatch(command)
            response_json = json.dumps(response, ensure_ascii=False) + "\n"
            win32file.WriteFile(self._handle, response_json.encode("utf-8"))
        except pywintypes.error:
            raise  # Пробросить ошибки pipe наверх
        except Exception as e:
            _log(f"Ошибка обработки команды '{command}': {e}")
            try:
                error_response = json.dumps({"error": str(e)}) + "\n"
                win32file.WriteFile(self._handle, error_response.encode("utf-8"))
            except Exception:
                pass

    def _dispatch(self, command: str) -> dict:
        """Найти и вызвать обработчик команды."""
        # Shutdown — особый случай, всегда проверяем первым
        if command == "shutdown":
            handler = self._handlers.get("shutdown", self._default_handlers["shutdown"])
            result = handler()
            result = result if isinstance(result, dict) else {"status": "ok"}

            # Shutdown завершает процесс после отправки ответа
            self._running = False
            threading.Timer(0.5, lambda: os._exit(0)).start()
            return result

        # Обработка custom:* команд
        if command.startswith("custom:"):
            if command in self._handlers:
                result = self._handlers[command]()
                return result if isinstance(result, dict) else {"status": "ok"}
            else:
                return {"error": f"unknown custom command: {command}"}

        # Пользовательские обработчики
        if command in self._handlers:
            result = self._handlers[command]()
            return result if isinstance(result, dict) else {"status": "ok"}

        # Встроенные обработчики
        if command in self._default_handlers:
            result = self._default_handlers[command]()
            return result if isinstance(result, dict) else {"status": "ok"}

        return {"error": f"unknown command: {command}"}

    def _default_shutdown(self) -> dict:
        """Обработчик shutdown по умолчанию."""
        return {"status": "ok"}

    def _close_handle(self):
        """Закрыть pipe handle."""
        with self._lock:
            if self._handle is not None:
                try:
                    win32file.CloseHandle(self._handle)
                except Exception:
                    pass
                self._handle = None


def _log(message: str):
    """Вывод отладочных сообщений в stderr."""
    print(f"[trayconsole] {message}", file=sys.stderr, flush=True)
