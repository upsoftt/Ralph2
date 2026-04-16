/**
 * TrayConsole Node.js Client — библиотека для подключения проектов к TrayConsole.
 *
 * Подключается к Named Pipe серверу TrayConsole, принимает команды (status, shutdown,
 * show, custom:*) и отправляет JSON-ответы. Работает асинхронно с автоматическим
 * переподключением.
 *
 * Протокол: JSON Line (одна JSON-строка на команду/ответ, разделитель \n).
 * Heartbeat: %LOCALAPPDATA%/TrayConsole/heartbeats/{name}.json каждые 5 секунд.
 * Named Mutex: Global\TrayConsole_{name} как маркер работающего процесса.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

const HEARTBEAT_INTERVAL = 5_000;
const HEARTBEAT_DIR = path.join(process.env.LOCALAPPDATA || '', 'TrayConsole', 'heartbeats');

type CommandHandler = () => Record<string, unknown>;

// Windows API для Named Mutex (загружается лениво через koffi)
let _koffi: any = null;
let _kernel32: any = null;

function loadKoffi(): boolean {
    if (_koffi) return true;
    try {
        _koffi = require('koffi');
        _kernel32 = _koffi.load('kernel32.dll');
        return true;
    } catch {
        return false;
    }
}

export class TrayConsoleClient {
    private pipeName: string;
    private pipePath: string;
    private handlers = new Map<string, CommandHandler>();
    private running = false;
    private socket: net.Socket | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private heartbeatPath: string;
    private reconnectDelay = 2_000;
    private readonly MAX_RECONNECT_DELAY = 30_000;
    private buffer = '';
    private mutexHandle: number | null = null;

    // koffi-bound Windows API functions
    private _CreateMutexW: any = null;
    private _CloseHandle: any = null;

    constructor(pipeName: string) {
        this.pipeName = pipeName;
        this.pipePath = `\\\\.\\pipe\\${pipeName}`;
        this.heartbeatPath = path.join(HEARTBEAT_DIR, `${pipeName}.json`);
    }

    /**
     * Зарегистрировать обработчик команды.
     * Встроенные команды: "status" (по умолчанию {status:"running"}), "shutdown".
     * Кастомные: "custom:reload", "custom:open_dashboard" и т.д.
     */
    on(command: string, handler: CommandHandler): this {
        this.handlers.set(command, handler);
        return this;
    }

    /** Запустить клиент: mutex, heartbeat, подключение к pipe. */
    start(): void {
        if (this.running) return;
        this.running = true;
        this.createMutex();
        this.startHeartbeat();
        this.connect();
    }

    /** Остановить клиент: закрыть соединение, удалить heartbeat, освободить mutex. */
    stop(): void {
        this.running = false;
        this.closeSocket();
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.deleteHeartbeat();
        this.releaseMutex();
    }

    get isConnected(): boolean {
        return this.socket !== null && !this.socket.destroyed;
    }

    // --- Named Pipe ---

    private connect(): void {
        if (!this.running) return;

        const socket = net.connect(this.pipePath);

        socket.on('connect', () => {
            this.socket = socket;
            this.reconnectDelay = 2_000;
            this.log(`Подключено к pipe: ${this.pipeName}`);
        });

        socket.on('data', (data: Buffer) => {
            this.buffer += data.toString('utf-8');
            const lines = this.buffer.split('\n');
            this.buffer = lines[lines.length - 1];

            for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i].trim();
                if (line) this.handleCommand(line);
            }
        });

        socket.on('error', (err: Error) => {
            if (!this.running) return;
            this.log(`Ошибка подключения (retry через ${this.reconnectDelay / 1000} сек): ${err.message}`);
        });

        socket.on('close', () => {
            this.socket = null;
            if (!this.running) return;
            setTimeout(() => this.connect(), this.reconnectDelay);
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
        });
    }

    private handleCommand(command: string): void {
        try {
            const response = this.dispatch(command);
            const json = JSON.stringify(response) + '\n';
            if (this.socket && !this.socket.destroyed) {
                this.socket.write(json, 'utf-8');
            }
        } catch (err) {
            this.log(`Ошибка обработки команды '${command}': ${err}`);
            try {
                const errJson = JSON.stringify({ error: String(err) }) + '\n';
                if (this.socket && !this.socket.destroyed) {
                    this.socket.write(errJson, 'utf-8');
                }
            } catch { /* pipe broken */ }
        }
    }

    private dispatch(command: string): Record<string, unknown> {
        // Shutdown — особый случай
        if (command === 'shutdown') {
            const handler = this.handlers.get('shutdown');
            const result = handler ? handler() : { status: 'ok' };
            this.running = false;
            this.deleteHeartbeat();
            this.releaseMutex();
            setTimeout(() => process.exit(0), 500);
            return typeof result === 'object' && result !== null ? result : { status: 'ok' };
        }

        // custom:* команды
        if (command.startsWith('custom:')) {
            const handler = this.handlers.get(command);
            if (handler) {
                const r = handler();
                return typeof r === 'object' && r !== null ? r : { status: 'ok' };
            }
            return { error: `unknown custom command: ${command}` };
        }

        // Пользовательский обработчик
        const handler = this.handlers.get(command);
        if (handler) {
            const r = handler();
            return typeof r === 'object' && r !== null ? r : { status: 'ok' };
        }

        // Встроенный status
        if (command === 'status') {
            return { status: 'running' };
        }

        return { error: `unknown command: ${command}` };
    }

    // --- Heartbeat ---

    private startHeartbeat(): void {
        try {
            fs.mkdirSync(HEARTBEAT_DIR, { recursive: true });
        } catch { /* ignore */ }

        this.writeHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.running) this.writeHeartbeat();
        }, HEARTBEAT_INTERVAL);
    }

    private writeHeartbeat(): void {
        try {
            const data = JSON.stringify({
                pid: process.pid,
                timestamp: Date.now() / 1000,
                status: 'running',
                name: this.pipeName,
            });
            const tmpPath = this.heartbeatPath + '.tmp';
            fs.writeFileSync(tmpPath, data, 'utf-8');
            fs.renameSync(tmpPath, this.heartbeatPath);
        } catch (err) {
            this.log(`Ошибка записи heartbeat: ${err}`);
        }
    }

    private deleteHeartbeat(): void {
        try { fs.unlinkSync(this.heartbeatPath); } catch { /* ok */ }
    }

    // --- Named Mutex (Windows API через koffi) ---

    private createMutex(): void {
        if (!loadKoffi()) {
            this.log('Mutex: koffi не найден, используется heartbeat как маркер процесса');
            return;
        }

        try {
            if (!this._CreateMutexW) {
                this._CreateMutexW = _kernel32.func('CreateMutexW', 'pointer', ['pointer', 'bool', 'str16']);
                this._CloseHandle = _kernel32.func('CloseHandle', 'bool', ['pointer']);
            }

            const mutexName = `Global\\TrayConsole_${this.pipeName}`;
            const handle = this._CreateMutexW(null, false, mutexName);

            if (handle === null || handle === 0) {
                this.log(`Не удалось создать mutex`);
            } else {
                this.mutexHandle = handle;
                this.log(`Mutex создан: ${mutexName}`);
            }
        } catch (err) {
            this.log(`Ошибка создания mutex: ${err}`);
        }
    }

    private releaseMutex(): void {
        if (this.mutexHandle !== null && this._CloseHandle) {
            try {
                this._CloseHandle(this.mutexHandle);
                this.log('Mutex освобождён');
            } catch (err) {
                this.log(`Ошибка освобождения mutex: ${err}`);
            }
            this.mutexHandle = null;
        }
    }

    // --- Socket ---

    private closeSocket(): void {
        if (this.socket) {
            try { this.socket.destroy(); } catch { /* ok */ }
            this.socket = null;
        }
    }

    private log(message: string): void {
        process.stderr.write(`[trayconsole] ${message}\n`);
    }
}
