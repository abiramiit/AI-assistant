import asyncio
import json
import logging
import queue
import threading
import time
from typing import List, Optional

import numpy as np
import sounddevice as sd
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("speech-service")

app = FastAPI(title="Local Speech-to-Text Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------------------------------------------
# 1. Device Selection & Model Initialization
# -------------------------------------------------------------
def get_input_device():
    """Identify and validate a working microphone device."""
    devices = sd.query_devices()
    default_input = sd.default.device[0]

    # Validate default input device
    if default_input is not None and default_input >= 0 and default_input < len(devices):
        dev = devices[default_input]
        if dev.get("max_input_channels", 0) > 0:
            logger.info(
                f"Using default input device [{default_input}]: {dev['name']} "
                f"(Channels: {dev['max_input_channels']}, Default SR: {dev['default_samplerate']})"
            )
            return default_input

    # Fallback: Find first device with input channels
    for idx, dev in enumerate(devices):
        if dev.get("max_input_channels", 0) > 0:
            logger.info(
                f"Fallback input device [{idx}]: {dev['name']} "
                f"(Channels: {dev['max_input_channels']}, Default SR: {dev['default_samplerate']})"
            )
            return idx

    logger.error("No valid audio input device found!")
    return None

INPUT_DEVICE = get_input_device()

logger.info("Initializing faster-whisper (base.en) on CPU...")
model = WhisperModel("base.en", device="cpu", compute_type="float32")
logger.info("faster-whisper model loaded and ready.")

# -------------------------------------------------------------
# 2. Audio Capture State & Settings
# -------------------------------------------------------------
SAMPLE_RATE = 16000
MIN_CHUNK_SECONDS = 2.0      # Minimum speech duration before evaluating sentence boundary
MAX_CHUNK_SECONDS = 8.0      # Maximum chunk duration before forcing transcription
PAUSE_THRESHOLD_SECONDS = 0.6 # Silence duration indicating a pause in speech

# FIX #3: Raised energy threshold so microphone noise / HVAC rumble (typical RMS ~0.001-0.003)
# does not pass as speech. Real speech usually has RMS >= 0.010 for a close-talking mic.
SPEECH_ENERGY_THRESHOLD = 0.010  # RMS energy threshold for speech vs ambient silence

audio_queue: queue.Queue = queue.Queue()
recording = False
stream: Optional[sd.InputStream] = None
connections: List[WebSocket] = []
processing_task: Optional[asyncio.Task] = None
lock = threading.Lock()

# FIX #5: Session counter lets the worker detect a new recording session and reset its state.
_session_id: int = 0

def audio_callback(indata, frames, time_info, status):
    """Real-time sounddevice callback running on PortAudio OS thread."""
    if status:
        logger.warning(f"Audio buffer status flag: {status}")
    if not recording:
        return
    # Extract mono channel 0 as float32
    mono = indata[:, 0].copy()
    audio_queue.put_nowait(mono)

def start_recording() -> tuple[bool, str]:
    """Start the audio capture stream safely."""
    global recording, stream, INPUT_DEVICE, _session_id
    with lock:
        if recording and stream and stream.active:
            return True, "Already recording"

        # FIX #5: Purge any leftover audio from a previous session BEFORE incrementing the
        # session counter so the worker can detect the transition and wipe its own buffer.
        while not audio_queue.empty():
            try:
                audio_queue.get_nowait()
            except queue.Empty:
                break

        _session_id += 1
        logger.info(f"Recording session #{_session_id} starting.")

        if INPUT_DEVICE is None:
            INPUT_DEVICE = get_input_device()
            if INPUT_DEVICE is None:
                return False, "No audio input device found on system"

        try:
            stream = sd.InputStream(
                device=INPUT_DEVICE,
                samplerate=SAMPLE_RATE,
                channels=1,
                dtype="float32",
                blocksize=1024,
                callback=audio_callback
            )
            stream.start()
            recording = True
            logger.info(f"Microphone stream started on device [{INPUT_DEVICE}] at {SAMPLE_RATE}Hz mono.")
            return True, "Recording started"
        except Exception as e:
            logger.error(f"Failed to start sounddevice InputStream: {e}", exc_info=True)
            recording = False
            stream = None
            return False, f"Microphone error: {str(e)}"

def stop_recording() -> tuple[bool, str]:
    """Stop and release the audio stream safely."""
    global recording, stream
    with lock:
        if not recording:
            return True, "Already stopped"
        recording = False
        if stream:
            try:
                stream.stop()
                stream.close()
            except Exception as e:
                logger.warning(f"Error stopping audio stream: {e}")
            stream = None
        logger.info("Microphone stream stopped and closed.")
        return True, "Recording stopped"

# -------------------------------------------------------------
# 3. High-Accuracy Transcription Worker
# -------------------------------------------------------------
def transcribe_chunk_sync(audio_data: np.ndarray) -> tuple[str, float, str]:
    """
    Run Whisper CPU inference with settings tuned to minimize hallucination.

    Key choices:
      - condition_on_previous_text=False : each chunk is transcribed independently,
        preventing Whisper from "continuing" a previous (possibly hallucinated) sentence.
      - NO initial_prompt : an initial_prompt acts as a seed context. When audio is near-
        silent, Whisper tries to "continue" that prompt and repeats it. Removing it
        eliminates the primary hallucination source.
      - vad_filter=True with sensible parameters: Silero VAD will mask non-speech
        frames inside the chunk before Whisper sees them, drastically reducing phantom
        transcriptions from silence.
      - beam_size=5, temperature=0.0 : deterministic, high-quality decoding.
      - FIX #4: Removed optimize_audio_amplitude() which was amplifying silence up to 3.5x.
        Audio is passed at its natural level. Whisper handles quiet speech internally
        via its own normalization (it expects float32 in [-1,1], which sounddevice gives us).
    """
    start_t = time.perf_counter()
    try:
        segments, info = model.transcribe(
            audio_data,
            language="en",
            beam_size=5,
            best_of=5,
            temperature=0.0,
            condition_on_previous_text=False,   # FIX #1: no cross-chunk context
            vad_filter=True,
            vad_parameters=dict(
                threshold=0.45,                 # VAD confidence needed to declare speech
                min_silence_duration_ms=500,    # silence gap to split utterances
                speech_pad_ms=200,              # padding around detected speech edges
                min_speech_duration_ms=250,     # ignore very short (<250 ms) noise bursts
            ),
            # FIX #2: initial_prompt removed — it was the primary hallucination seed.
        )

        texts = []
        for seg in segments:
            cleaned = seg.text.strip()
            # Drop punctuation-only segments and very short filler tokens
            if cleaned and cleaned not in {".", ",", "!", "?", "...", "…", "( )"}:
                texts.append(cleaned)

        result_text = " ".join(texts).strip()
        elapsed = time.perf_counter() - start_t
        return result_text, elapsed, info.language
    except Exception as e:
        logger.error(f"Whisper transcription error: {e}", exc_info=True)
        return "", 0.0, "en"


def _normalize_for_dedup(text: str) -> str:
    """
    Collapse whitespace and strip trailing punctuation so that
    'Hello.' and 'Hello' do not slip past the duplicate guard.
    """
    import re
    text = text.lower().strip()
    text = re.sub(r"[^\w\s]", "", text)   # strip punctuation
    text = re.sub(r"\s+", " ", text)      # collapse whitespace
    return text


async def audio_processing_worker():
    """Smart pause-aware audio segmentation worker."""
    logger.info("Smart pause-aware audio processing worker started.")

    buffer: List[np.ndarray] = []
    accumulated_samples = 0
    silence_samples = 0

    # FIX #1 & #6: Per-session dedup state.  Reset when a new session begins.
    last_transcribed_norm = ""
    worker_session_id = _session_id   # snapshot of session at start

    min_samples = int(MIN_CHUNK_SECONDS * SAMPLE_RATE)
    max_samples = int(MAX_CHUNK_SECONDS * SAMPLE_RATE)
    pause_samples = int(PAUSE_THRESHOLD_SECONDS * SAMPLE_RATE)

    while True:
        try:
            # --- Detect new recording session and reset worker-local state ---
            current_session = _session_id
            if current_session != worker_session_id:
                logger.info(
                    f"New recording session #{current_session} detected — resetting worker state."
                )
                buffer.clear()
                accumulated_samples = 0
                silence_samples = 0
                last_transcribed_norm = ""
                worker_session_id = current_session

            # --- Drain incoming chunks from the queue ---
            while True:
                try:
                    chunk = audio_queue.get_nowait()
                    buffer.append(chunk)
                    accumulated_samples += len(chunk)

                    # Track silence / pause duration
                    chunk_rms = float(np.sqrt(np.mean(chunk ** 2)))
                    if chunk_rms < SPEECH_ENERGY_THRESHOLD:
                        silence_samples += len(chunk)
                    else:
                        silence_samples = 0  # reset pause clock on any speech energy
                except queue.Empty:
                    break

            # --- Segmentation decision logic ---
            # 1. Natural pause detected after sufficient speech
            is_natural_pause = (accumulated_samples >= min_samples) and (silence_samples >= pause_samples)
            # 2. Maximum segment limit reached
            is_max_length = accumulated_samples >= max_samples
            # 3. User clicked Stop and there is at least 0.5 s of accumulated audio
            is_stop_flush = (not recording) and (accumulated_samples >= int(SAMPLE_RATE * 0.5))

            # Discard residual sub-500ms noise if recording was stopped without sufficient speech
            if (not recording) and buffer and not is_stop_flush:
                logger.debug(
                    f"Discarding {accumulated_samples / SAMPLE_RATE:.2f}s of sub-threshold "
                    f"audio after Stop."
                )
                buffer.clear()
                accumulated_samples = 0
                silence_samples = 0

            if buffer and (is_natural_pause or is_max_length or is_stop_flush):
                audio_data = np.concatenate(buffer)
                buffer.clear()
                accumulated_samples = 0
                silence_samples = 0

                peak = float(np.max(np.abs(audio_data)))
                rms = float(np.sqrt(np.mean(audio_data ** 2)))
                duration = len(audio_data) / SAMPLE_RATE

                # FIX #3: Use the raised threshold — only send audio with genuine speech energy.
                # The check now uses SPEECH_ENERGY_THRESHOLD directly (not * 0.7).
                if rms >= SPEECH_ENERGY_THRESHOLD or peak >= (SPEECH_ENERGY_THRESHOLD * 3.0):
                    text, elapsed, lang = await asyncio.to_thread(transcribe_chunk_sync, audio_data)
                    word_count = len(text.split()) if text else 0

                    logger.info(
                        f"Transcribed {duration:.2f}s audio in {elapsed:.2f}s | "
                        f"Peak: {peak:.4f}, RMS: {rms:.5f} | Words: {word_count} | '{text}'"
                    )

                    if text:
                        norm = _normalize_for_dedup(text)
                        # FIX #6: Compare normalised forms to catch punctuation variants
                        if norm and norm != last_transcribed_norm:
                            last_transcribed_norm = norm
                            logger.info(f"Broadcasting transcription: '{text}'")
                            await broadcast({"type": "transcription", "text": text})
                        else:
                            logger.debug(f"Suppressed duplicate transcription: '{text}'")
                else:
                    logger.debug(
                        f"Skipped silent/noise audio: duration={duration:.2f}s, "
                        f"rms={rms:.5f}, peak={peak:.4f}"
                    )

            await asyncio.sleep(0.08)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in audio processing worker: {e}", exc_info=True)
            await asyncio.sleep(0.4)

async def broadcast(message: dict):
    """Send JSON message to all connected clients."""
    dead = []
    for ws in list(connections):
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in connections:
            connections.remove(ws)

# -------------------------------------------------------------
# 4. FastAPI Endpoints & WebSocket Handler
# -------------------------------------------------------------
@app.on_event("startup")
async def startup_event():
    global processing_task
    processing_task = asyncio.create_task(audio_processing_worker())

@app.on_event("shutdown")
async def shutdown_event():
    global processing_task
    stop_recording()
    if processing_task:
        processing_task.cancel()

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    connections.append(ws)
    logger.info(f"WebSocket client connected. Total connections: {len(connections)}")

    try:
        await ws.send_json({"type": "status", "status": "listening" if recording else "ready"})
    except Exception:
        pass

    try:
        while True:
            raw = await ws.receive_text()
            try:
                data = json.loads(raw)
            except Exception:
                continue

            action = data.get("action")
            if action == "start":
                success, msg = start_recording()
                if success:
                    await broadcast({"type": "status", "status": "listening"})
                else:
                    await ws.send_json({"type": "error", "message": msg})
                    await broadcast({"type": "status", "status": "ready"})
            elif action == "stop":
                stop_recording()
                await broadcast({"type": "status", "status": "ready"})
            elif action == "status":
                await ws.send_json({"type": "status", "status": "listening" if recording else "ready"})
    except WebSocketDisconnect:
        if ws in connections:
            connections.remove(ws)
        logger.info(f"WebSocket client disconnected. Total connections: {len(connections)}")
    except Exception as e:
        logger.error(f"WebSocket connection exception: {e}")
        if ws in connections:
            connections.remove(ws)

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "recording": recording,
        "input_device": INPUT_DEVICE,
        "connections": len(connections)
    }

@app.get("/devices")
async def list_devices():
    devices = sd.query_devices()
    result = []
    for idx, d in enumerate(devices):
        result.append({
            "index": idx,
            "name": d.get("name"),
            "max_input_channels": d.get("max_input_channels"),
            "max_output_channels": d.get("max_output_channels"),
            "default_samplerate": d.get("default_samplerate"),
            "is_default_input": idx == sd.default.device[0],
            "is_selected": idx == INPUT_DEVICE
        })
    return {"devices": result, "selected_input": INPUT_DEVICE}
