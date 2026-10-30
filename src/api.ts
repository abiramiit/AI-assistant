export interface AssistantAPI {
    isElectron: boolean;
    startRecording: () => Promise<{ success: boolean; error?: string }>;
    stopRecording: () => Promise<{ success: boolean; error?: string }>;
    suggestAnswer: (question: string) => Promise<{ success: boolean; error?: string }>;
    onTranscription: (callback: (text: string) => void) => () => void;
    onAnswerChunk: (callback: (chunk: string) => void) => () => void;
    onStatus: (callback: (status: string) => void) => () => void;
}

// Check if running in Electron with preload injected
const electronAPI = typeof window !== 'undefined' ? (window as any).electronAPI : undefined;

let browserWs: WebSocket | null = null;
let browserWsReconnectTimer: any = null;
const transcriptionListeners = new Set<(text: string) => void>();
const answerListeners = new Set<(chunk: string) => void>();
const statusListeners = new Set<(status: string) => void>();

function notifyStatus(status: string) {
    statusListeners.forEach((cb) => cb(status));
}

function notifyTranscription(text: string) {
    transcriptionListeners.forEach((cb) => cb(text));
}

function notifyAnswerChunk(chunk: string) {
    answerListeners.forEach((cb) => cb(chunk));
}

function initBrowserWebSocket() {
    if (browserWs && (browserWs.readyState === WebSocket.OPEN || browserWs.readyState === WebSocket.CONNECTING)) {
        return;
    }

    try {
        browserWs = new WebSocket('ws://127.0.0.1:8765/ws');

        browserWs.onopen = () => {
            console.log('[Web] Connected to Python speech service on ws://127.0.0.1:8765/ws');
            if (browserWsReconnectTimer) {
                clearTimeout(browserWsReconnectTimer);
                browserWsReconnectTimer = null;
            }
            notifyStatus('Ready');
        };

        browserWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'transcription') {
                    notifyTranscription(msg.text);
                } else if (msg.type === 'status') {
                    notifyStatus(msg.status === 'listening' ? 'Listening' : 'Ready');
                } else if (msg.type === 'error') {
                    notifyStatus(`Error: ${msg.message}`);
                }
            } catch (err) {
                console.error('[Web] Failed to parse WebSocket message', err);
            }
        };

        browserWs.onclose = () => {
            console.log('[Web] WebSocket closed. Retrying in 2s...');
            notifyStatus('Speech service offline (retrying...)');
            scheduleBrowserReconnect();
        };

        browserWs.onerror = (err) => {
            console.warn('[Web] WebSocket error:', err);
            notifyStatus('Speech service connection error');
            scheduleBrowserReconnect();
        };
    } catch (e) {
        console.error('[Web] Error creating WebSocket:', e);
        scheduleBrowserReconnect();
    }
}

function scheduleBrowserReconnect() {
    if (browserWsReconnectTimer) return;
    browserWsReconnectTimer = setTimeout(() => {
        browserWsReconnectTimer = null;
        initBrowserWebSocket();
    }, 2000);
}

const ASSISTANT_SYSTEM_PROMPT =
    'You are a helpful, precise, and concise AI assistant. Follow these instructions:\n' +
    "1. Provide direct, clear, and well-structured answers to the user's prompt or question.\n" +
    '2. For technical and programming questions, explain concepts simply and include short, clear examples.\n' +
    '3. If the user\'s input is garbled, incomplete, or contains obvious transcription errors or typos (such as unfamiliar words or jumbled grammar), do NOT invent fictional narratives, crimes, prisons, or unrelated assumptions. Politely note the potential typo or ambiguity, offer a plausible interpretation if obvious, or ask for clarification.\n' +
    '4. Keep responses concise, focused, and free of unnecessary filler or disclaimers.';

export const api: AssistantAPI = electronAPI
    ? {
          isElectron: true,
          startRecording: () => electronAPI.startRecording(),
          stopRecording: () => electronAPI.stopRecording(),
          suggestAnswer: (question: string) => electronAPI.suggestAnswer(question),
          onTranscription: (cb: (text: string) => void) => {
              electronAPI.onTranscription(cb);
              return () => {};
          },
          onAnswerChunk: (cb: (chunk: string) => void) => {
              electronAPI.onAnswerChunk(cb);
              return () => {};
          },
          onStatus: (cb: (status: string) => void) => {
              electronAPI.onStatus(cb);
              return () => {};
          },
      }
    : {
          isElectron: false,
          startRecording: async () => {
              initBrowserWebSocket();
              if (browserWs && browserWs.readyState === WebSocket.OPEN) {
                  browserWs.send(JSON.stringify({ action: 'start' }));
                  return { success: true };
              }
              const err = 'Speech service not connected';
              notifyStatus(`Error: ${err}`);
              return { success: false, error: err };
          },
          stopRecording: async () => {
              if (browserWs && browserWs.readyState === WebSocket.OPEN) {
                  browserWs.send(JSON.stringify({ action: 'stop' }));
                  return { success: true };
              }
              return { success: false, error: 'Speech service not connected' };
          },
          suggestAnswer: async (question: string) => {
              const trimmed = question?.trim();
              if (!trimmed) {
                  notifyStatus('Please provide a valid question');
                  return { success: false, error: 'Empty prompt' };
              }
              notifyStatus('Generating');
              try {
                  const res = await fetch('http://127.0.0.1:11434/api/generate', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                          model: 'qwen2.5:3b',
                          system: ASSISTANT_SYSTEM_PROMPT,
                          prompt: trimmed,
                          stream: true,
                          options: {
                              temperature: 0.3,
                              top_p: 0.85,
                              num_predict: 350,
                          },
                      }),
                  });

                  if (!res.ok) {
                      const err = await res.text();
                      notifyStatus(`Ollama error: ${err}`);
                      return { success: false, error: err };
                  }

                  const reader = res.body?.getReader();
                  if (!reader) {
                      notifyStatus('Ollama streaming unavailable');
                      return { success: false, error: 'No reader' };
                  }

                  const decoder = new TextDecoder('utf-8');
                  while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      const chunk = decoder.decode(value);
                      const lines = chunk.split('\n').filter((l) => l.trim());
                      for (const line of lines) {
                          try {
                              const parsed = JSON.parse(line);
                              if (parsed.response) {
                                  notifyAnswerChunk(parsed.response);
                              }
                          } catch {}
                      }
                  }
                  notifyStatus('Ready');
                  return { success: true };
              } catch (err: any) {
                  console.error('[Web] Ollama fetch error:', err);
                  notifyStatus(`Ollama request failed: ${err.message}`);
                  return { success: false, error: err.message };
              }
          },
          onTranscription: (cb: (text: string) => void) => {
              transcriptionListeners.add(cb);
              initBrowserWebSocket();
              return () => transcriptionListeners.delete(cb);
          },
          onAnswerChunk: (cb: (chunk: string) => void) => {
              answerListeners.add(cb);
              return () => answerListeners.delete(cb);
          },
          onStatus: (cb: (status: string) => void) => {
              statusListeners.add(cb);
              initBrowserWebSocket();
              return () => statusListeners.delete(cb);
          },
      };
