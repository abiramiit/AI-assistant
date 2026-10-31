type APIResult = { success: boolean; error?: string };

type ElectronBridge = {
    startRecording: () => Promise<APIResult>;
    stopRecording: () => Promise<APIResult>;
    suggestAnswer: (question: string) => Promise<APIResult>;
    onTranscription: (callback: (text: string) => void) => void;
    onAnswerChunk: (callback: (chunk: string) => void) => void;
    onStatus: (callback: (status: string) => void) => void;
};

declare global {
    interface Window {
        electronAPI?: ElectronBridge;
    }
}

export interface AssistantAPI {
    isElectron: boolean;
    startRecording: () => Promise<APIResult>;
    stopRecording: () => Promise<APIResult>;
    suggestAnswer: (question: string) => Promise<APIResult>;
    onTranscription: (callback: (text: string) => void) => () => void;
    onAnswerChunk: (callback: (chunk: string) => void) => () => void;
    onStatus: (callback: (status: string) => void) => () => void;
}

const electronAPI = typeof window !== 'undefined' ? window.electronAPI : undefined;
const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';
const configuredWebSocketUrl = import.meta.env.VITE_WS_URL?.trim() ?? '';
const transcriptionListeners = new Set<(text: string) => void>();
const answerListeners = new Set<(chunk: string) => void>();
const statusListeners = new Set<(status: string) => void>();

let browserWs: WebSocket | null = null;
let browserWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let browserWsConnectPromise: Promise<WebSocket> | null = null;
let browserMediaStream: MediaStream | null = null;
let browserAudioContext: AudioContext | null = null;
let browserAudioSource: MediaStreamAudioSourceNode | null = null;
let browserAudioProcessor: ScriptProcessorNode | null = null;

function isLoopbackHostname(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '::1' ||
        /^127(?:\.\d{1,3}){3}$/.test(host) ||
        host === '0.0.0.0'
    );
}

function getBrowserBackendConfiguration():
    | { apiBaseUrl: string; webSocketUrl: string }
    | { error: string } {
    if (!import.meta.env.PROD) {
        const apiBaseUrl = configuredApiBaseUrl.replace(/\/+$/, '');
        const webSocketUrl = configuredWebSocketUrl
            ? configuredWebSocketUrl
            : (() => {
                  const url = apiBaseUrl
                      ? new URL('/ws', new URL(apiBaseUrl, window.location.href))
                      : new URL('/ws', window.location.href);
                  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
                  return url.toString();
              })();
        return { apiBaseUrl, webSocketUrl };
    }

    if (!configuredApiBaseUrl || !configuredWebSocketUrl) {
        return {
            error:
                'Backend is not configured. Set VITE_API_BASE_URL and VITE_WS_URL in Vercel Project Settings, then redeploy.',
        };
    }

    try {
        const apiUrl = new URL(configuredApiBaseUrl);
        const webSocketUrl = new URL(configuredWebSocketUrl);
        if (
            apiUrl.protocol !== 'https:' ||
            webSocketUrl.protocol !== 'wss:' ||
            isLoopbackHostname(apiUrl.hostname) ||
            isLoopbackHostname(webSocketUrl.hostname)
        ) {
            return {
                error:
                    'Backend is not configured. VITE_API_BASE_URL must use a public https:// URL and VITE_WS_URL a public wss:// URL; localhost is only valid in development.',
            };
        }

        return {
            apiBaseUrl: configuredApiBaseUrl.replace(/\/+$/, ''),
            webSocketUrl: webSocketUrl.toString(),
        };
    } catch {
        return {
            error:
                'Backend is not configured. VITE_API_BASE_URL must be an https:// URL and VITE_WS_URL must be a wss:// URL.',
        };
    }
}

function notifyStatus(status: string) {
    statusListeners.forEach((callback) => callback(status));
}

function notifyTranscription(text: string) {
    transcriptionListeners.forEach((callback) => callback(text));
}

function notifyAnswerChunk(chunk: string) {
    answerListeners.forEach((callback) => callback(chunk));
}

function initBrowserWebSocket(): void {
    const configuration = getBrowserBackendConfiguration();
    if ('error' in configuration) {
        notifyStatus(`Error: ${configuration.error}`);
        return;
    }

    if (
        browserWs &&
        (browserWs.readyState === WebSocket.OPEN || browserWs.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    try {
        browserWs = new WebSocket(configuration.webSocketUrl);
        browserWs.binaryType = 'arraybuffer';
        browserWs.onopen = () => {
            if (browserWsReconnectTimer) {
                clearTimeout(browserWsReconnectTimer);
                browserWsReconnectTimer = null;
            }
            notifyStatus('Ready');
        };
        browserWs.onmessage = (event: MessageEvent<string>) => {
            try {
                const message = JSON.parse(event.data) as {
                    type?: string;
                    text?: string;
                    status?: string;
                    message?: string;
                };
                if (message.type === 'transcription' && message.text) {
                    notifyTranscription(message.text);
                } else if (message.type === 'status') {
                    notifyStatus(message.status === 'listening' ? 'Listening' : 'Ready');
                } else if (message.type === 'error') {
                    notifyStatus(`Error: ${message.message ?? 'Speech service error'}`);
                }
            } catch (error) {
                console.error('[Web] Failed to parse speech service message:', error);
                notifyStatus('Error: Invalid speech service response');
            }
        };
        browserWs.onclose = () => {
            browserWs = null;
            if (browserMediaStream) stopBrowserCapture();
            notifyStatus('Speech service offline (retrying...)');
            scheduleBrowserReconnect();
        };
        browserWs.onerror = () => {
            notifyStatus('Speech service connection error');
        };
    } catch (error) {
        console.error('[Web] Could not create speech service connection:', error);
        notifyStatus('Speech service connection error');
        scheduleBrowserReconnect();
    }
}

function scheduleBrowserReconnect(): void {
    if (browserWsReconnectTimer) return;
    browserWsReconnectTimer = setTimeout(() => {
        browserWsReconnectTimer = null;
        initBrowserWebSocket();
    }, 2000);
}

async function waitForBrowserWebSocket(): Promise<WebSocket> {
    initBrowserWebSocket();
    if (browserWs?.readyState === WebSocket.OPEN) return browserWs;
    if (browserWsConnectPromise) return browserWsConnectPromise;

    browserWsConnectPromise = new Promise<WebSocket>((resolve, reject) => {
        const socket = browserWs;
        if (!socket) {
            reject(new Error('Could not establish a speech service connection.'));
            return;
        }

        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Speech service connection timed out.'));
        }, 10000);
        const cleanup = () => {
            clearTimeout(timeout);
            socket.removeEventListener('open', onOpen);
            socket.removeEventListener('error', onError);
            socket.removeEventListener('close', onClose);
        };
        const onOpen = () => {
            cleanup();
            resolve(socket);
        };
        const onError = () => {
            cleanup();
            reject(new Error('Could not connect to the speech service.'));
        };
        const onClose = () => {
            cleanup();
            reject(new Error('Speech service closed the connection.'));
        };
        socket.addEventListener('open', onOpen, { once: true });
        socket.addEventListener('error', onError, { once: true });
        socket.addEventListener('close', onClose, { once: true });
    }).finally(() => {
        browserWsConnectPromise = null;
    });

    return browserWsConnectPromise;
}

function stopBrowserCapture(): void {
    if (browserAudioProcessor) {
        browserAudioProcessor.onaudioprocess = null;
        browserAudioProcessor.disconnect();
        browserAudioProcessor = null;
    }
    browserAudioSource?.disconnect();
    browserAudioSource = null;
    browserMediaStream?.getTracks().forEach((track) => track.stop());
    browserMediaStream = null;
    if (browserAudioContext && browserAudioContext.state !== 'closed') {
        void browserAudioContext.close();
    }
    browserAudioContext = null;
}

function resampleTo16Khz(input: Float32Array, inputSampleRate: number): Float32Array {
    const outputLength = Math.floor((input.length * 16000) / inputSampleRate);
    const output = new Float32Array(outputLength);
    const ratio = inputSampleRate / 16000;

    for (let index = 0; index < outputLength; index += 1) {
        const sourcePosition = index * ratio;
        const leftIndex = Math.floor(sourcePosition);
        const rightIndex = Math.min(leftIndex + 1, input.length - 1);
        const fraction = sourcePosition - leftIndex;
        output[index] = input[leftIndex] * (1 - fraction) + input[rightIndex] * fraction;
    }
    return output;
}

async function startBrowserRecording(): Promise<APIResult> {
    const configuration = getBrowserBackendConfiguration();
    if ('error' in configuration) {
        notifyStatus(`Error: ${configuration.error}`);
        return { success: false, error: configuration.error };
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        return { success: false, error: 'Browser microphone capture requires HTTPS or localhost.' };
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        browserMediaStream = stream;
        const socket = await waitForBrowserWebSocket();
        browserAudioContext = new AudioContext();
        browserAudioSource = browserAudioContext.createMediaStreamSource(stream);
        browserAudioProcessor = browserAudioContext.createScriptProcessor(4096, 1, 1);
        browserAudioProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            const samples = resampleTo16Khz(
                event.inputBuffer.getChannelData(0),
                browserAudioContext?.sampleRate ?? 16000,
            );
            event.outputBuffer.getChannelData(0).fill(0);
            if (samples.length > 0) socket.send(samples.buffer);
        };
        browserAudioSource.connect(browserAudioProcessor);
        browserAudioProcessor.connect(browserAudioContext.destination);

        socket.send(JSON.stringify({ action: 'start', mode: 'browser' }));
        notifyStatus('Listening');
        return { success: true };
    } catch (error) {
        stopBrowserCapture();
        const message = error instanceof Error ? error.message : 'Unable to start browser recording.';
        notifyStatus(`Error: ${message}`);
        return { success: false, error: message };
    }
}

async function stopBrowserRecording(): Promise<APIResult> {
    const socket = browserWs;
    stopBrowserCapture();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return { success: false, error: 'Speech service not connected' };
    }
    socket.send(JSON.stringify({ action: 'stop' }));
    return { success: true };
}

async function suggestAnswerInBrowser(question: string): Promise<APIResult> {
    const trimmed = question.trim();
    if (!trimmed) return { success: false, error: 'Please provide a valid question.' };

    const configuration = getBrowserBackendConfiguration();
    if ('error' in configuration) {
        notifyStatus(`Error: ${configuration.error}`);
        return { success: false, error: configuration.error };
    }

    notifyStatus('Generating');
    try {
        const response = await fetch(`${configuration.apiBaseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: trimmed }),
        });
        if (!response.ok) {
            const errorBody = (await response.json().catch(() => null)) as
                | { detail?: string }
                | null;
            const message = errorBody?.detail ?? `AI service request failed (${response.status}).`;
            notifyStatus(`Error: ${message}`);
            return { success: false, error: message };
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('AI response streaming is unavailable.');

        const decoder = new TextDecoder();
        let pending = '';
        let streamError: string | undefined;
        const consumeEvent = (event: string) => {
            for (const line of event.split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data) continue;
                const item = JSON.parse(data) as {
                    type: string;
                    chunk?: string;
                    message?: string;
                };
                if (item.type === 'chunk' && item.chunk) notifyAnswerChunk(item.chunk);
                if (item.type === 'error') streamError = item.message ?? 'AI generation failed.';
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            pending += decoder.decode(value, { stream: !done });
            const events = pending.split(/\r?\n\r?\n/);
            pending = events.pop() ?? '';
            events.forEach(consumeEvent);
            if (done) break;
        }
        if (pending.trim()) consumeEvent(pending);
        if (streamError) {
            notifyStatus(`Error: ${streamError}`);
            return { success: false, error: streamError };
        }
        notifyStatus('Ready');
        return { success: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'AI generation failed.';
        console.error('[Web] AI generation failed:', error);
        notifyStatus(`Error: ${message}`);
        return { success: false, error: message };
    }
}

export const api: AssistantAPI = electronAPI
    ? {
          isElectron: true,
          startRecording: () => electronAPI.startRecording(),
          stopRecording: () => electronAPI.stopRecording(),
          suggestAnswer: (question) => electronAPI.suggestAnswer(question),
          onTranscription: (callback) => {
              electronAPI.onTranscription(callback);
              return () => {};
          },
          onAnswerChunk: (callback) => {
              electronAPI.onAnswerChunk(callback);
              return () => {};
          },
          onStatus: (callback) => {
              electronAPI.onStatus(callback);
              return () => {};
          },
      }
    : {
          isElectron: false,
          startRecording: startBrowserRecording,
          stopRecording: stopBrowserRecording,
          suggestAnswer: suggestAnswerInBrowser,
          onTranscription: (callback) => {
              transcriptionListeners.add(callback);
              initBrowserWebSocket();
              return () => transcriptionListeners.delete(callback);
          },
          onAnswerChunk: (callback) => {
              answerListeners.add(callback);
              return () => answerListeners.delete(callback);
          },
          onStatus: (callback) => {
              statusListeners.add(callback);
              initBrowserWebSocket();
              return () => statusListeners.delete(callback);
          },
      };
