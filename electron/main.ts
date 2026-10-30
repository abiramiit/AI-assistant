import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';

let mainWindow: BrowserWindow | null = null;
let pythonProcess: ChildProcess | null = null;
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isQuitting = false;

const PYTHON_SERVICE_URL = 'http://127.0.0.1:8765';
const PYTHON_WS_URL = 'ws://127.0.0.1:8765/ws';

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 950,
        height: 750,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl).catch(() => {
        mainWindow?.loadFile(path.join(__dirname, '../dist/index.html'));
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

async function checkServiceHealth(): Promise<boolean> {
    try {
        const res = await fetch(`${PYTHON_SERVICE_URL}/health`, { signal: AbortSignal.timeout(1000) });
        return res.ok;
    } catch {
        return false;
    }
}

async function ensurePythonService() {
    const isRunning = await checkServiceHealth();
    if (isRunning) {
        console.log('[Electron] Python service is already running on port 8765.');
        connectWebSocket();
        return;
    }

    console.log('[Electron] Launching managed Python speech service...');
    const pythonExe = 'C:\\\\Users\\\\abira\\\\AppData\\\\Local\\\\Programs\\\\Python\\\\Python312\\\\python.exe';
    const scriptPath = path.join(__dirname, '..', 'python-service', 'run.py');

    pythonProcess = spawn(pythonExe, [scriptPath], {
        cwd: path.join(__dirname, '..'),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    pythonProcess.stdout?.on('data', (data: Buffer) => {
        console.log(`[Python] ${data.toString().trim()}`);
    });

    pythonProcess.stderr?.on('data', (data: Buffer) => {
        console.log(`[Python] ${data.toString().trim()}`);
    });

    pythonProcess.on('close', (code: number | null) => {
        console.log(`[Electron] Python process exited with code ${code}`);
        pythonProcess = null;
    });

    // Wait for health endpoint before connecting WebSocket
    await waitForServiceReady(20);
}

async function waitForServiceReady(maxRetries = 20): Promise<boolean> {
    for (let i = 1; i <= maxRetries; i++) {
        if (isQuitting) return false;
        console.log(`[Electron] Waiting for Python service to be ready (attempt ${i}/${maxRetries})...`);
        const ready = await checkServiceHealth();
        if (ready) {
            console.log('[Electron] Python service health check PASSED. Connecting WebSocket...');
            connectWebSocket();
            return true;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.error('[Electron] Python service failed to become ready in time.');
    mainWindow?.webContents.send('status', 'Error: Speech service unreachable');
    return false;
}

function connectWebSocket() {
    if (isQuitting) return;

    if (ws) {
        try {
            ws.removeAllListeners();
            ws.terminate();
        } catch {}
        ws = null;
    }

    console.log(`[Electron] Connecting to WebSocket: ${PYTHON_WS_URL}`);
    ws = new WebSocket(PYTHON_WS_URL);

    ws.on('open', () => {
        console.log('[Electron] Connected to Python speech service WebSocket.');
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        mainWindow?.webContents.send('status', 'Ready');
    });

    ws.on('message', (data: WebSocket.Data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'transcription') {
                console.log(`[Electron] Transcription received: ${msg.text}`);
                mainWindow?.webContents.send('transcription', msg.text);
            } else if (msg.type === 'status') {
                mainWindow?.webContents.send('status', msg.status === 'listening' ? 'Listening' : 'Ready');
            } else if (msg.type === 'error') {
                console.error(`[Electron] Service error: ${msg.message}`);
                mainWindow?.webContents.send('status', `Error: ${msg.message}`);
            }
        } catch (e) {
            console.error('[Electron] Failed to parse message from Python service', e);
        }
    });

    ws.on('close', () => {
        if (!isQuitting) {
            console.log('[Electron] WebSocket closed. Scheduling reconnect in 2s...');
            scheduleReconnect();
        }
    });

    ws.on('error', (err: Error) => {
        if (!isQuitting) {
            console.log(`[Electron] WebSocket error: ${err.message}. Reconnecting...`);
            scheduleReconnect();
        }
    });
}

function scheduleReconnect() {
    if (isQuitting || reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        const healthy = await checkServiceHealth();
        if (healthy) {
            connectWebSocket();
        } else {
            console.log('[Electron] Service not responding on health check, retrying...');
            scheduleReconnect();
        }
    }, 2000);
}

const ASSISTANT_SYSTEM_PROMPT =
    'You are a helpful, precise, and concise AI assistant. Follow these instructions:\n' +
    "1. Provide direct, clear, and well-structured answers to the user's prompt or question.\n" +
    '2. For technical and programming questions, explain concepts simply and include short, clear examples.\n' +
    '3. If the user\'s input is garbled, incomplete, or contains obvious transcription errors or typos (such as unfamiliar words or jumbled grammar), do NOT invent fictional narratives, crimes, prisons, or unrelated assumptions. Politely note the potential typo or ambiguity, offer a plausible interpretation if obvious, or ask for clarification.\n' +
    '4. Keep responses concise, focused, and free of unnecessary filler or disclaimers.';

async function callOllama(question: string) {
    const trimmed = question?.trim();
    if (!trimmed) {
        console.warn('[Electron] Empty prompt received for Ollama');
        mainWindow?.webContents.send('status', 'Please provide a valid question');
        return;
    }

    const url = 'http://127.0.0.1:11434/api/generate';
    const body = {
        model: 'qwen2.5:3b',
        system: ASSISTANT_SYSTEM_PROMPT,
        prompt: trimmed,
        stream: true,
        options: {
            temperature: 0.3,
            top_p: 0.85,
            num_predict: 350,
        },
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.text();
            console.error(`[Electron] Ollama error: ${err}`);
            mainWindow?.webContents.send('status', `Ollama error: ${err}`);
            return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
            console.error('[Electron] Readable stream not available from Ollama.');
            mainWindow?.webContents.send('status', 'Ollama stream unavailable');
            return;
        }

        const decoder = new TextDecoder('utf-8');
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter((l) => l.trim());
            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.response) {
                        mainWindow?.webContents.send('answer-chunk', obj.response);
                    }
                } catch {}
            }
        }
        mainWindow?.webContents.send('status', 'Ready');
    } catch (err: any) {
        console.error('[Electron] Ollama request failed:', err.message);
        mainWindow?.webContents.send('status', `Ollama request failed: ${err.message}`);
    }
}

app.whenReady().then(async () => {
    createWindow();
    await ensurePythonService();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    isQuitting = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        try {
            ws.removeAllListeners();
            ws.close();
        } catch {}
        ws = null;
    }
    if (pythonProcess) {
        console.log('[Electron] Terminating managed Python speech process...');
        try {
            if (process.platform === 'win32' && pythonProcess.pid) {
                spawn('taskkill', ['/pid', pythonProcess.pid.toString(), '/f', '/t']);
            } else {
                pythonProcess.kill();
            }
        } catch (e) {
            console.error('[Electron] Failed to stop Python process:', e);
        }
        pythonProcess = null;
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

ipcMain.handle('start-recording', async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'start' }));
        return { success: true };
    }
    return { success: false, error: 'Python speech service not connected' };
});

ipcMain.handle('stop-recording', async () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ action: 'stop' }));
        return { success: true };
    }
    return { success: false, error: 'Python speech service not connected' };
});

ipcMain.handle('suggest-answer', async (_event, question: string) => {
    mainWindow?.webContents.send('status', 'Generating');
    await callOllama(question);
    return { success: true };
});
