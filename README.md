# Local AI Assistant

A private speech-to-text and question-answering assistant for both Windows
desktop use and self-hosted web deployment. Speech recognition runs with
faster-whisper and answer generation runs with the local Ollama model
`qwen2.5:3b`; the application does not send audio or prompts to an external AI
provider.

## Features

- Start and stop microphone recording.
- Live transcription with faster-whisper.
- Use a transcript as the answer prompt, or edit the prompt directly.
- Stream generated answer text progressively from Ollama.
- Run as an Electron desktop app using the computer's microphone, or in a
  browser using browser microphone capture.
- Deploy the browser app and inference services to a private NVIDIA GPU server.

## Technology

- React, TypeScript, Vite
- Electron with context-isolated preload IPC
- FastAPI, WebSockets, faster-whisper, NumPy
- Ollama with `qwen2.5:3b`
- Docker Compose, Nginx, and Caddy-managed HTTPS

## Architecture

```text
Desktop mode
Electron UI --IPC--> Electron main process --WebSocket--> FastAPI
     |                                                   |-- sounddevice microphone
     |                                                   |-- faster-whisper
     |                          Electron main ---------->|-- private Ollama
     +-- (answer streaming back through IPC) <-----------+

Self-hosted web mode
Browser (HTTPS, microphone permission)
   |-- HTTPS /api/generate and WSS /ws
   v
Caddy (public ports 80/443; obtains and renews TLS certificates)
   v
Nginx (shared Basic Auth, request limits, WebSocket and API reverse proxy)
   |-- static React/Vite frontend
   v
Private Docker network
   |-- FastAPI: independent browser audio sessions and streamed API responses
   |      |-- faster-whisper (NVIDIA GPU)
   |      +-- Ollama (NVIDIA GPU, qwen2.5:3b; no public port)
   +-- persistent Whisper and Ollama model volumes
```

In web mode, microphone samples are captured by the browser and sent as
short-lived 16 kHz float audio frames over WSS. The server does not need or
access a physical microphone. Audio is held in session memory only for
transcription and is not written to disk or included in application logs.
Prompt text is sent only to the self-hosted Ollama service.

## Local Development

### Prerequisites

- Node.js 18 or newer and npm
- Python 3.10–3.12 with pip
- Ollama installed and running locally
- A microphone for desktop capture (or a browser microphone for web testing)

Install dependencies and download the local models:

```powershell
npm install
python -m pip install -r python-service/requirements.txt
ollama pull qwen2.5:3b
python -c "from faster_whisper import WhisperModel; WhisperModel('base.en')"
```

For the Electron desktop application, run:

```powershell
npm run dev
```

Electron starts its local FastAPI speech service automatically. The application
uses the local sounddevice microphone for this desktop mode.

For browser development, start Ollama, then run the backend and Vite in separate
terminals:

```powershell
# Terminal 1
npm run start-py

# Terminal 2
npm run vite
```

Open `http://localhost:5173`. Vite proxies `/ws` and `/api` to the local backend
at `http://127.0.0.1:8765` by default. The browser requests microphone
permission and streams its audio to that backend. Browsers allow microphone
capture on localhost; remote sites require HTTPS.

Build both the web frontend and Electron main/preload code with:

```powershell
npm run build
```

### Development Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `VITE_DEV_BACKEND_URL` | Vite proxy target for `/api` and `/ws` | `http://127.0.0.1:8765` |
| `VITE_API_BASE_URL` | Browser API origin/path; blank uses same-origin routes | blank |
| `VITE_WS_URL` | Optional explicit browser WebSocket URL | derived from current origin |
| `PYTHON_EXECUTABLE` | Python executable Electron should launch | `python` |
| `PYTHON_SERVICE_URL` | Electron's local speech health endpoint | `http://127.0.0.1:8765` |
| `PYTHON_WS_URL` | Electron's local speech WebSocket endpoint | `ws://127.0.0.1:8765/ws` |
| `OLLAMA_BASE_URL` | Ollama endpoint for Electron local mode | `http://127.0.0.1:11434` |

The loopback defaults above are for local Vite/Electron development only.
Production browser builds require public `VITE_API_BASE_URL` (`https://...`)
and `VITE_WS_URL` (`wss://.../ws`) values and reject loopback URLs.

## Self-Hosted Docker Deployment

### GPU Server Requirements

Recommended starting host:

- Ubuntu Server 22.04 or 24.04, x86-64
- NVIDIA GPU with **12 GB or more VRAM recommended** (8 GB is a constrained
  minimum for this model combination and concurrent use)
- NVIDIA driver compatible with CUDA 12.4; use a current production driver
  (550 or newer recommended)
- NVIDIA Container Toolkit, Docker Engine, and Docker Compose v2 plugin
- 4 or more CPU cores, 32 GB RAM recommended, and 100 GB SSD free space
- DNS A/AAAA records for the public domain; inbound TCP ports 80 and 443 and
  UDP 443 reachable for TLS/HTTP3

`qwen2.5:3b` and `base.en` are the initial models. Larger models, higher
concurrency, or larger Whisper models need more GPU memory and storage.

### Prepare DNS, authentication, and configuration

1. Provision the Linux host and NVIDIA drivers/Container Toolkit. Verify GPU
   access with `nvidia-smi` and the NVIDIA Docker sample before starting this
   stack.
2. Point a DNS name (for example `assistant.example.com`) at the server.
   Caddy needs public DNS and inbound port 80/443 to obtain and renew a
   publicly trusted certificate.
3. Clone the already-pushed repository onto the server and enter the repository
   directory:

   ```bash
   git clone https://github.com/abiramiit/AI-assistant.git
   cd AI-assistant
   ```
4. Create and edit the ignored environment file:

   ```bash
   cp .env.example .env
   nano .env
   ```

   Set `PUBLIC_DOMAIN` to the real DNS name. Keep the API base and WebSocket
   URL blank to use same-origin requests. Do not commit `.env`.
5. Create the Nginx Basic Auth file. This command prompts for the password;
   only a bcrypt hash is stored in the ignored file:

   ```bash
   docker run --rm -it \
     -v "$PWD/deploy:/out" \
     httpd:2.4-alpine \
     htpasswd -B -c /out/.htpasswd YOUR_USERNAME
   ```

   Use a strong, unique password and protect the server/repository checkout.
   The `.htpasswd` file must exist before starting Compose.

### Start, inspect, and stop

Validate the rendered configuration, then build and start:

```bash
docker compose --env-file .env -f deploy/compose.yaml config
docker compose --env-file .env -f deploy/compose.yaml up --build -d
docker compose --env-file .env -f deploy/compose.yaml ps
docker compose --env-file .env -f deploy/compose.yaml logs -f
```

The first startup downloads the CUDA container layers, Whisper model, and
Ollama model; it can take a while. Caddy serves the site at
`https://<PUBLIC_DOMAIN>` and manages TLS certificates. Only Caddy publishes
ports 80 and 443. FastAPI, Nginx, and Ollama do not publish their internal
ports. Application containers use an unexposed bridge network with outbound
access for first-run model downloads. Model files persist in named Docker
volumes when containers are recreated.

Stop the stack without deleting models:

```bash
docker compose --env-file .env -f deploy/compose.yaml down
```

To remove model data too, explicitly remove the volumes (this deletes the
downloaded models):

```bash
docker compose --env-file .env -f deploy/compose.yaml down --volumes
```

### Docker Services

| Service | Purpose | Publicly exposed |
|---|---|---|
| `caddy` | HTTPS certificate issuance/renewal and public TLS entrypoint | TCP 80/443, UDP 443 |
| `frontend` | Static UI, Nginx Basic Auth, API/WebSocket proxy and request limits | No; edge network only |
| `speech` | FastAPI, per-client audio buffering, faster-whisper, and Ollama proxy | No; internal network only |
| `ollama` | Local `qwen2.5:3b` inference on the NVIDIA GPU | No; internal network only |
| `ollama-model` | One-shot download of the configured Ollama model | No; internal network only |

The Whisper and Ollama model caches are persisted in `whisper_models` and
`ollama_models`. Caddy certificate state is persisted in `caddy_data` and
`caddy_config`.

### Deployment Environment Variables

Values are read from `.env` by Docker Compose. `.env.example` contains
non-secret defaults.

| Variable | Purpose | Default |
|---|---|---|
| `PUBLIC_DOMAIN` | Required DNS name for Caddy TLS and WebSocket origin checks | required |
| `HTTP_PORT`, `HTTPS_PORT` | Public Caddy listener ports | `80`, `443` |
| `VITE_API_BASE_URL` | Frontend API origin or prefix, compiled into the UI | `https://${PUBLIC_DOMAIN}` |
| `VITE_WS_URL` | Browser WebSocket URL, compiled into the UI | `wss://${PUBLIC_DOMAIN}/ws` |
| `OLLAMA_MODEL` | Ollama model to pull and use | `qwen2.5:3b` |
| `OLLAMA_TIMEOUT_SECONDS` | Backend model request timeout | `180` |
| `ENABLE_DEVICE_CAPTURE` | Allow the legacy Electron/local service to use server-side sounddevice capture | `true` locally, `false` in Compose |
| `WHISPER_MODEL` | faster-whisper model name | `base.en` |
| `WHISPER_DEVICE` | Inference device | `cuda` |
| `WHISPER_COMPUTE_TYPE` | faster-whisper compute type | `float16` |
| `MAX_CONCURRENT_SESSIONS` | Maximum active WebSocket sessions | `8` |

For a Vercel frontend, set both URL variables in the Vercel project settings to
the public FastAPI backend, for example `https://api.example.com` and
`wss://api.example.com/ws`. They are compiled into the browser bundle, so
redeploy after changing them. Do not set these URLs to Ollama. Ollama must
remain on the private Docker network; generation requests go through FastAPI.

## Privacy and Security

- Web deployment is protected by shared Nginx Basic Auth; provision a bcrypt
  `.htpasswd` file and rotate its password by replacing that file and restarting
  the frontend.
- Caddy terminates HTTPS/WSS. Do not publish Nginx, FastAPI, or Ollama ports
  directly or place them on a public-facing network.
- FastAPI rejects unapproved WebSocket origins, caps active sessions and audio
  frame sizes, disables server-side microphone capture in the Compose
  deployment, and does not save/log raw audio or prompt contents.
- Nginx limits generation requests and WebSocket connections. These are
  operational controls, not protection against a determined denial-of-service
  attack; also use host firewalling and monitor resource usage.
- Audio is transmitted to the self-hosted GPU server for transcription. Prompt
  text is sent to Ollama on that same host. Review access and retention policies
  before allowing other users.
- Keep Docker, the host OS, NVIDIA drivers, and images updated. Restrict SSH
  access and keep `.env` and `.htpasswd` out of source control and backups that
  are not access-controlled.
- Remote browser microphone access requires HTTPS. Do not use the development
  Vite server as a public production server.

## Troubleshooting

- **Caddy does not obtain a certificate:** Confirm the domain resolves to the
  server and inbound TCP 80/443 plus UDP 443 are allowed. Review Caddy logs.
- **The frontend container does not start:** Create `deploy/.htpasswd` first
  and check its ownership/permissions. Review `docker compose ... logs frontend`.
- **Speech health is unhealthy:** Inspect speech logs, confirm the GPU is
  available to Docker, verify the configured CUDA/compute type, and allow time
  for the first Whisper download/model initialization.
- **Ollama is unavailable or model missing:** Check `ollama` and
  `ollama-model` logs and the `ollama_models` volume. The backend reports a
  safe model-unavailable error when generation cannot start.
- **Browser microphone permission fails:** Use HTTPS (or localhost during
  development), grant permission to the site, and check browser microphone
  selection.
- **WebSocket origin rejected:** Make `PUBLIC_DOMAIN` match the browser URL
  exactly, including `https://`, and recreate the speech service.
- **Browser build uses an old endpoint:** Vite environment URLs are build-time
  values; rebuild the frontend image after changing them.
- **Local desktop microphone fails:** Check the OS microphone permission,
  `sounddevice` installation, and `PYTHON_EXECUTABLE` path. Browser capture
  does not depend on server-side `sounddevice`.

## Validation and Deployment Status

`npm run build` validates the Vite production frontend and Electron TypeScript
build. Python syntax, Compose configuration, and container builds should be
checked on the deployment machine as part of setup. A healthy local build does
not mean the application has been deployed online; there is no public URL until
the GPU server is provisioned, the stack is started, and its HTTPS site is
verified.
