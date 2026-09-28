import React from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import { Inbox } from './Inbox.js';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Inbox />
  </React.StrictMode>,
);
