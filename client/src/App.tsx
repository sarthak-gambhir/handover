import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Home } from './routes/Home';
import { Waiting } from './routes/Waiting';
import { Session } from './routes/Session';
import { NotFound } from './routes/NotFound';
import { ToastProvider } from './components/ui/Toast';

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/w/:slug" element={<Waiting />} />
          <Route path="/s/:slug" element={<Session />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
