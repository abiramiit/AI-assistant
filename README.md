# Local AI Assistant

A complete local desktop assistant built with Electron, React, TypeScript, FastAPI (faster-whisper), and Ollama.

---

## Architecture & How It Works

1. **Frontend (React + Vite)**: Renders the interface with live transcription, question/answer controls, and status monitoring. Works seamlessly inside Electron and also directly in any browser at `http://localhost:5173/`.
2. **Desktop Shell (Electron)**: Hosts the Vite frontend and orchestrates background communication.
3. **Speech Service (Python + faster-whisper)**: Started automatically by Electron as a managed child process on `http://127.0.0.1:8765`, capturing audio chunks with `sounddevice` and transcribing them locally.
4. **Local LLM (Ollama)**: Streams prompts to local Ollama (`qwen2.5:3b`) on `http://127.0.0.1:11434/api/generate` and progressively yields answer chunks to the UI.

---

## Prerequisites

- **Node.js**: v18.0.0 or higher (v22.x tested and confirmed working)
- **Python**: 3.10 – 3.12 with `pip`
- **Ollama**: Installed and running locally with the `qwen2.5:3b` model:
  ```bash
  ollama pull qwen2.5:3b
  ```

---

## Installation

### 1. Install Node Dependencies
```bash
npm install
```

### 2. Install Python Speech Dependencies
Install the required Python audio and machine learning libraries:
```bash
python -m pip install -r python-service/requirements.txt
```
*(Or target your specific Python 3.12 installation if multiple Python versions exist on your system)*

### 3. Pre-download Whisper Model
Download and cache the `base.en` Whisper model locally:
```bash
npm run install-models
```

---

## Running the Application

To run the complete application in development mode with one command:
```bash
npm run dev
```

### What `npm run dev` does:
1. Compiles Electron's TypeScript files (`electron/main.ts` and `electron/preload.ts`) into `dist-electron/`.
2. Starts the Vite development server on `http://localhost:5173`.
3. Waits for Vite to be ready and launches Electron.
4. Electron automatically spawns and manages the Python speech service (`uvicorn python-service.main:app`), auto-reconnecting via WebSockets as soon as the service finishes initialising.
5. **No separate terminal is required for Python!** Electron starts and closes it cleanly.
6. The interface is accessible both via the native Electron desktop window and in your browser at `http://localhost:5173/`.

---

## Building for Production

To create a production build of the renderer and Electron processes:
```bash
npm run build
```

---

## Troubleshooting

- **Blank screen on `http://localhost:5173/`**:  
  Occurred when the React app previously assumed `window.electronAPI` existed unconditionally, throwing an unhandled `TypeError` in standard web browsers. Resolved with a universal API adapter in `src/api.ts` that supports both Electron IPC and direct WebSocket/HTTP browser fallbacks, alongside a React ErrorBoundary.
- **`Invalid Version` during `npm install`**:  
  Occurred when `package-lock.json` contained package definitions without version strings (e.g. from partial install scripts). Resolved by ensuring all packages in the lockfile have explicit valid versions.
- **`localhost refused to connect`**:  
  Occurred when Electron launched before Vite or Python services were listening, or when Vite lacked its HTML root. Resolved by introducing `index.html`, configuring proper port waiting, and adding resilient WebSocket auto-reconnect logic in Electron.
- **Ollama Connection Refused**:  
  Ensure the Ollama desktop service or server is running (`ollama serve`) before clicking **Suggest Answer**.
