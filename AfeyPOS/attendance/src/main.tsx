import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/600.css';
import '@fontsource/open-sans/700.css';
import '../../web/src/styles/index.css';
import { AttendanceApp } from './AttendanceApp';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AttendanceApp />
  </React.StrictMode>,
);
