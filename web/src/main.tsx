import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { FiltersProvider } from './state';
import { TooltipProvider } from '@/components/kit/tooltip';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FiltersProvider>
        <BrowserRouter>
          <MotionConfig reducedMotion="user">
            <TooltipProvider delayDuration={250}>
              <App />
            </TooltipProvider>
          </MotionConfig>
        </BrowserRouter>
      </FiltersProvider>
    </QueryClientProvider>
  </StrictMode>,
);
