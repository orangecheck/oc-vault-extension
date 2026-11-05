import React from 'react';
import ReactDOM from 'react-dom/client';

import { followColorScheme } from '@/lib/theme';
import { PasskeyPage } from './PasskeyPage';
import '@/assets/app.css';

followColorScheme();

const root = document.getElementById('root');
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <PasskeyPage />
        </React.StrictMode>
    );
}
