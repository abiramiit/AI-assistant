import React, { useState } from 'react';

interface Props {
    answer: string;
    question: string;
    setQuestion: (q: string) => void;
    onSuggest: () => void;
    status?: string;
}

const AnswerPanel: React.FC<Props> = ({ answer, question, setQuestion, onSuggest, status }) => {
    const [editing, setEditing] = useState(false);

    const isGenerating = status === 'Generating';
    const hasAnswer = answer.trim().length > 0;

    const handleEditToggle = () => setEditing((e) => !e);

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setQuestion(e.target.value);
    };

    return (
        <div className="panel answer-panel">
            {/* Panel header */}
            <div className="panel-header">
                <div className="panel-title-group">
                    <div className="panel-icon answer-icon" aria-hidden="true">
                        {/* Sparkle / AI icon */}
                        <svg viewBox="0 0 24 24">
                            <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5Z" />
                        </svg>
                    </div>
                    <h2>AI Answer</h2>
                </div>

                {/* Edit prompt toggle */}
                <button
                    id="btn-edit-prompt"
                    className="edit-btn"
                    onClick={handleEditToggle}
                    type="button"
                    aria-pressed={editing}
                    aria-label={editing ? 'Finish editing prompt' : 'Edit AI prompt'}
                >
                    {editing ? (
                        /* Check icon */
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                    ) : (
                        /* Pencil icon */
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" />
                        </svg>
                    )}
                    {editing ? 'Done' : 'Edit Prompt'}
                </button>
            </div>

            {/* ── Prompt area ──────────────────────────────── */}
            <div className="question-area">
                <div className="question-header">
                    <span className="question-label">Prompt</span>
                </div>

                {editing ? (
                    <textarea
                        id="question-input"
                        className="question-input"
                        value={question}
                        onChange={handleChange}
                        rows={3}
                        placeholder="Type or speak a question, then click Suggest Answer…"
                        aria-label="AI prompt input"
                        autoFocus
                    />
                ) : (
                    <div
                        id="question-display"
                        className={`question-text${question.trim() ? '' : ' empty'}`}
                        onClick={handleEditToggle}
                        role="button"
                        tabIndex={0}
                        aria-label="Click to edit AI prompt"
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleEditToggle(); }}
                        title="Click to edit prompt"
                    >
                        {question.trim() || 'No prompt set — speak or click Edit Prompt to type one.'}
                    </div>
                )}
            </div>

            {/* ── Suggest Answer CTA ──────────────────────── */}
            <div className="action-row">
                <button
                    id="btn-suggest-answer"
                    className={`suggest-btn${isGenerating ? ' generating' : ''}`}
                    onClick={onSuggest}
                    disabled={!question.trim() || isGenerating}
                    type="button"
                    aria-label={isGenerating ? 'Generating answer…' : 'Generate AI answer'}
                    aria-busy={isGenerating}
                >
                    {isGenerating ? (
                        <>
                            {/* Spinner-ish dots */}
                            <div className="loading-dots" aria-hidden="true">
                                <span /><span /><span />
                            </div>
                            Generating Answer…
                        </>
                    ) : (
                        <>
                            {/* Send / sparkle icon */}
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5Z" />
                            </svg>
                            Suggest Answer
                        </>
                    )}
                </button>
            </div>

            {/* ── Answer output ─────────────────────────────── */}
            <div
                className="answer-output"
                aria-live="polite"
                aria-label="AI generated answer"
            >
                {hasAnswer ? (
                    <pre>{answer}</pre>
                ) : (
                    <div className="answer-empty">
                        <div className="answer-empty-icon">
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5Z" />
                            </svg>
                        </div>
                        <p>
                            <strong>No answer yet</strong>
                            Set a prompt above and click <em>Suggest Answer</em> to get a response from your local AI.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AnswerPanel;
