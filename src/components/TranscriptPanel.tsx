import React from 'react';

interface Props {
    transcript: string;
    setQuestion: (q: string) => void;
    isListening?: boolean;
}

const TranscriptPanel: React.FC<Props> = ({ transcript, setQuestion, isListening }) => {
    const hasTranscript = transcript.trim().length > 0;

    const handleUseAsPrompt = () => {
        if (hasTranscript) setQuestion(transcript.trim());
    };

    return (
        <div className="panel transcript-panel">
            {/* Panel header */}
            <div className="panel-header">
                <div className="panel-title-group">
                    <div className="panel-icon transcript-icon" aria-hidden="true">
                        {/* Waveform / mic icon */}
                        <svg viewBox="0 0 24 24">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" x2="12" y1="19" y2="23" />
                            <line x1="8"  x2="16" y1="23" y2="23" />
                        </svg>
                    </div>
                    <h2>Live Transcription</h2>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {/* Listening pill — only shown when mic is on */}
                    <div
                        className={`transcript-live-badge${isListening ? ' visible' : ''}`}
                        aria-live="polite"
                        aria-label={isListening ? 'Microphone active' : undefined}
                    >
                        <span className="live-dot" aria-hidden="true" />
                        Live
                    </div>

                    {/* Use as Prompt button */}
                    {hasTranscript && (
                        <button
                            id="btn-use-as-prompt"
                            className="copy-btn"
                            onClick={handleUseAsPrompt}
                            type="button"
                            title="Copy transcript to AI prompt"
                            aria-label="Use transcript as AI prompt"
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                            </svg>
                            Use as Prompt
                        </button>
                    )}
                </div>
            </div>

            {/* Transcript content area */}
            <div
                className="transcript-box"
                onClick={hasTranscript ? handleUseAsPrompt : undefined}
                role={hasTranscript ? 'button' : undefined}
                tabIndex={hasTranscript ? 0 : undefined}
                aria-label={hasTranscript ? 'Transcript — click to use as prompt' : undefined}
                onKeyDown={hasTranscript ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleUseAsPrompt(); } : undefined}
            >
                {hasTranscript ? (
                    <pre className="transcript-text">{transcript}</pre>
                ) : (
                    /* Empty state */
                    <div className="transcript-empty">
                        <div className="transcript-empty-icon">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" x2="12" y1="19" y2="23" />
                                <line x1="8"  x2="16" y1="23" y2="23" />
                            </svg>
                        </div>
                        <p>
                            <strong>Nothing transcribed yet</strong>
                            Press <em>Start Recording</em> and speak — your words will appear here in real time.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TranscriptPanel;
