import React from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import { Tag } from './Tag.js';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Tag />
  </React.StrictMode>,
);
