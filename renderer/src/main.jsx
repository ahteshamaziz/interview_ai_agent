import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Overlay from './Overlay.jsx';
import './styles.css';

const isOverlay = new URLSearchParams(window.location.search).get('overlay') === '1';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isOverlay ? <Overlay /> : <App />}
  </React.StrictMode>
);
