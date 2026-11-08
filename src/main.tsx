import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

/** /admin 是旧版独立后台的入口，保留兼容：直接打开工作台并定位到「系统与审计」 */
const isAdminRoute = /^\/admin\/?$/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isAdminRoute ? <App initialAccountSection="system" /> : <App />}
  </React.StrictMode>,
);
