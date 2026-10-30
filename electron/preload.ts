import { contextBridge, ipcRenderer } from 'electron';

// Expose safe APIs to the renderer process.
//
// FIX #7: Each onXxx registration now removes any previously-registered listener
// for that channel before adding the new one.  Without this, React StrictMode
// (which mounts/unmounts effects twice in development) or any re-render that calls
// these helpers would stack up multiple identical listeners, causing every event
// to be delivered N times and the transcript to accumulate duplicates.
contextBridge.exposeInMainWorld('electronAPI', {
    startRecording: () => ipcRenderer.invoke('start-recording'),
    stopRecording: () => ipcRenderer.invoke('stop-recording'),
    suggestAnswer: (question: string) => ipcRenderer.invoke('suggest-answer', question),

    onTranscription: (callback: (text: string) => void) => {
        ipcRenderer.removeAllListeners('transcription');
        ipcRenderer.on('transcription', (_event, text) => callback(text));
    },
    onAnswerChunk: (callback: (chunk: string) => void) => {
        ipcRenderer.removeAllListeners('answer-chunk');
        ipcRenderer.on('answer-chunk', (_event, chunk) => callback(chunk));
    },
    onStatus: (callback: (status: string) => void) => {
        ipcRenderer.removeAllListeners('status');
        ipcRenderer.on('status', (_event, status) => callback(status));
    },
});
