import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';
import { securityHeaders } from '@health24/shared';

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


/*
 * The headers a browser is told to enforce (sp7-plan.md, T10).
 *
 * Set here as well as by the static server in front of the built app, so that
 * a policy which would break a screen breaks it on a laptop and in the browser
 * tests, rather than in production where somebody would be tempted to switch
 * it off.
 */
const headers = securityHeaders('portal', { development: true });

export default defineConfig({
  plugins: [react()],
  server: {
    // The clinical app is on 5173.
    port: 5174,
    proxy: { '/api': toApi },
    headers,
  },
  preview: { headers: securityHeaders('portal') },
});
