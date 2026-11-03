import { StrictMode } from 'react';
import { ConfigProvider, theme } from 'antd';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';

import './i18n';
import './assets/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm }}>
      <div className="flex h-screen w-screen flex-col items-center justify-center overflow-hidden">
        <App />
      </div>
    </ConfigProvider>
  </StrictMode>
);
