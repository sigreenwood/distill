import { createRoot } from 'react-dom/client';
import { Settings } from './Settings.js';

const root = document.getElementById('root');
if (!root) throw new Error('Settings renderer: #root not found');

createRoot(root).render(<Settings />);
