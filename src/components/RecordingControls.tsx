import React from 'react';

type Props = {
    onStart: () => void;
    onStop: () => void;
    onClear: () => void;
    status: string;
};

const RecordingControls: React.FC<Props> = ({ onStart, onStop, onClear, status }) => {
    const isListening  = status === 'Listening';
    const isGenerating = status === 'Generating';

    return (
        <div className="controls" role="toolbar" aria-label="Recording controls">
            {/* ── Start / Listening button ───────────────────── */}
            <button
                id="btn-start-recording"
                className={`btn-mic start${isListening ? ' listening' : ''}`}
                onClick={onStart}
                disabled={isListening || isGenerating}
                type="button"
                aria-pressed={isListening}
                aria-label={isListening ? 'Recording — microphone active' : 'Start recording'}
            >
                {isListening ? (
                    /* Mic-on icon while recording */
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" x2="12" y1="19" y2="23" />
                        <line x1="8"  x2="16" y1="23" y2="23" />
                    </svg>
                ) : (
                    /* Mic-off icon while idle */
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" x2="12" y1="19" y2="23" />
                        <line x1="8"  x2="16" y1="23" y2="23" />
                    </svg>
                )}
                {isListening ? 'Listening…' : 'Start Recording'}
            </button>

            {/* Animated waveform bars — only shown while listening */}
            {isListening && (
                <div
                    className="waveform-bars active"
                    aria-hidden="true"
                    title="Microphone active"
                >
                    <span style={{ height: '12px' }} />
                    <span style={{ height: '18px' }} />
                    <span style={{ height: '24px' }} />
                    <span style={{ height: '18px' }} />
                    <span style={{ height: '12px' }} />
                </div>
            )}

            {/* ── Stop button ─────────────────────────────────── */}
            <button
                id="btn-stop-recording"
                className="btn-stop"
                onClick={onStop}
                disabled={!isListening}
                type="button"
                aria-label="Stop recording"
            >
                {/* Square stop icon */}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
                Stop
            </button>

            {/* ── Clear button ─────────────────────────────────── */}
            <button
                id="btn-clear"
                className="btn-clear"
                onClick={onClear}
                disabled={isListening || isGenerating}
                type="button"
                aria-label="Clear transcript and answer"
            >
                {/* Trash icon */}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6M14 11v6" />
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                Clear
            </button>
        </div>
    );
};

export default RecordingControls;
