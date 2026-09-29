import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/api.js';
import { MeetingReader } from './MeetingReader.js';
import './reader.css';

function App() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const params = new URLSearchParams(hash.slice(1));
  const recordingId = params.get('recordingId') ?? '';
  const scope = params.get('scope') === 'transcript' ? 'transcript' : 'summary';
  return <MeetingReader key={`${recordingId}:${scope}`} recordingId={recordingId} initialScope={scope} />;
}

createRoot(document.getElementById('root')!).render(<App />);
