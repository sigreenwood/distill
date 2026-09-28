import { createRoot } from 'react-dom/client';
import { Setup } from './Setup.js';

const root = document.getElementById('root');
if (!root) throw new Error('Setup renderer: #root not found');

createRoot(root).render(<Setup />);
