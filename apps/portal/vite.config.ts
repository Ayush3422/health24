import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

// When the API is down, answer 502 as a reverse proxy in front of it would.
// The browser tests start their own API on another port (sp5-plan.md, T23).
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
    // The clinical app is on 5173.
    port: 5174,
    proxy: { '/api': toApi },
  },
});
