import React, { useCallback, useEffect, useRef, useState } from 'react';
import Header from './components/Header';
import RecordingControls from './components/RecordingControls';
import TranscriptPanel from './components/TranscriptPanel';
import AnswerPanel from './components/AnswerPanel';
import { api } from './api';
import './styles/global.css';

const App: React.FC = () => {
    const [status, setStatus] = useState('Ready');
    const [transcript, setTranscript] = useState('');
    const [answer, setAnswer] = useState('');
    const [question, setQuestion] = useState('');

    // FIX: Keep a ref to the last appended transcription so we can deduplicate
    // at the UI layer as a final safety net (the backend already deduplicates,
    // but network hiccups can cause the same message to be re-delivered).
    const lastTranscriptSegmentRef = useRef<string>('');

    useEffect(() => {
        const unsubStatus = api.onStatus((s: string) => setStatus(s));

        const unsubTranscription = api.onTranscription((text: string) => {
            // Ignore empty strings or exact duplicate of the last segment
            if (!text.trim()) return;
            if (text.trim() === lastTranscriptSegmentRef.current) return;

            lastTranscriptSegmentRef.current = text.trim();
            setTranscript((prev) => (prev ? `${prev}\n${text}` : text));
        });

        const unsubAnswer = api.onAnswerChunk((chunk: string) => {
            setAnswer((prev) => prev + chunk);
        });

        return () => {
            unsubStatus();
            unsubTranscription();
            unsubAnswer();
        };
    }, []);

    // When a transcript is generated and user hasn't explicitly written a different question,
    // keep question in sync with the full transcript.
    useEffect(() => {
        if (transcript && !question) {
            setQuestion(transcript);
        }
    }, [transcript]);

    const handleStart = async () => {
        // FIX: Clear transcript and reset the dedup ref before starting a new session
        // so stale text from the previous session does not show up.
        setTranscript('');
        setQuestion('');
        lastTranscriptSegmentRef.current = '';

        const res = await api.startRecording();
        if (res.success) {
            setStatus('Listening');
        } else if (res.error) {
            setStatus(`Error: ${res.error}`);
        }
    };

    const handleStop = async () => {
        const res = await api.stopRecording();
        if (res.success) {
            setStatus('Ready');
        }
    };

    const handleSuggest = async () => {
        const q = question.trim() || transcript.trim();
        if (!q) return;
        setAnswer('');
        setStatus('Generating');
        await api.suggestAnswer(q);
    };

    const handleClear = () => {
        setTranscript('');
        setAnswer('');
        setQuestion('');
        lastTranscriptSegmentRef.current = '';
        setStatus('Ready');
    };

    const isListening = status === 'Listening';

    return (
        <div className="app-container">
            <Header status={status} />
            <RecordingControls
                onStart={handleStart}
                onStop={handleStop}
                onClear={handleClear}
                status={status}
            />
            <div className="section-divider" aria-hidden="true" />
            <div className="panels-container">
                <TranscriptPanel
                    transcript={transcript}
                    setQuestion={setQuestion}
                    isListening={isListening}
                />
                <AnswerPanel
                    answer={answer}
                    onSuggest={handleSuggest}
                    question={question}
                    setQuestion={setQuestion}
                    status={status}
                />
            </div>
        </div>
    );
};

export default App;
