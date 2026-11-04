import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AdminPage from './components/AdminPage';
import './styles.css';

const isAdminRoute = /^\/admin\/?$/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isAdminRoute ? <AdminPage /> : <App />}
  </React.StrictMode>,
);
