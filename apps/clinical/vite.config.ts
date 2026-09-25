import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

// When the API is down, answer 502 as a reverse proxy in front of it would, so
// the app sees an outage exactly as it will in a deployment.
// The browser tests start their own API on another port (sp6-plan.md, T25).
const toApi: ProxyOptions = {
  target: process.env.API_ORIGIN ?? 'http://localhost:3000',
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('error', (_error, _request, response) => {
      if ('headersSent' in response && !response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain' }).end('API unreachable');
      }
    });
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API sets CORS for this origin, but proxying keeps the browser
    // same-origin, which matters once refresh tokens move to cookies.
    proxy: {
      '/api': toApi,
      // Probed while offline to learn when the API is back.
      '/health': toApi,
    },
  },
});
