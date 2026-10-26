import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { ConfirmProvider, ToastProvider } from './components/ui';
import { ApiError } from './lib/api';
import { applyTheme } from './lib/workstation';
import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/600.css';
import '@fontsource/open-sans/700.css';
import './styles/index.css';

applyTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && n < 2, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
