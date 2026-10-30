import React from 'react';

interface HeaderProps {
    status: string;
}

/** Maps the raw status string to a stable data-status attribute and display label. */
function resolveStatus(status: string): { key: string; label: string } {
    const s = status.toLowerCase();
    if (s === 'listening')  return { key: 'listening',  label: 'Listening' };
    if (s === 'generating') return { key: 'generating', label: 'Generating' };
    if (s.startsWith('error')) return { key: 'error', label: status };
    return { key: 'ready', label: 'Ready' };
}

const Header: React.FC<HeaderProps> = ({ status }) => {
    const { key, label } = resolveStatus(status);

    return (
        <header className="header">
            {/* Brand */}
            <div className="header-brand">
                <div className="header-icon" aria-hidden="true">
                    {/* Microphone waveform icon */}
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" x2="12" y1="19" y2="23" />
                        <line x1="8"  x2="16" y1="23" y2="23" />
                    </svg>
                </div>
                <div>
                    <h1>Local AI Assistant</h1>
                    <div className="header-subtitle">Private · Offline · On-Device</div>
                </div>
            </div>

            {/* Status badge */}
            <div
                className="status-badge"
                data-status={key}
                role="status"
                aria-live="polite"
                aria-label={`Status: ${label}`}
            >
                <span className="status-dot" aria-hidden="true" />
                {label}
            </div>
        </header>
    );
};

export default Header;
