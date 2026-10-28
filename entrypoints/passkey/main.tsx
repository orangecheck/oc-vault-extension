import React from 'react';
import ReactDOM from 'react-dom/client';

import { PasskeyPage } from './PasskeyPage';
import '../popup/style.css';

const root = document.getElementById('root');
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <PasskeyPage />
        </React.StrictMode>
    );
}
