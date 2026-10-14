import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiUrl = process.env.API_URL;
if (!apiUrl) throw new Error('API_URL must be set to the API this web app talks to, such as http://127.0.0.1:41200');

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    proxy: {
      '/api': { target: apiUrl, rewrite: path => path.replace(/^\/api/, '') },
    },
  },
});
