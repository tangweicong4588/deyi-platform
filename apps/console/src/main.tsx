import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles/tokens.css';
import './styles/base.css';

async function boot() {
  // F0：本地开发默认走 MSW mock（.env.development）；联调时关掉并配 VITE_API_BASE_URL
  if (import.meta.env.VITE_USE_MOCK === 'true') {
    const { startMock } = await import('./mocks/browser');
    await startMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

void boot();
