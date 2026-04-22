import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    base: '/pdftest/',
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      target: 'es2020',
      minify: 'esbuild',
      cssCodeSplit: true,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            'pdf-vendor': ['react-pdf', 'pdfjs-dist'],
            'ui-vendor': ['lucide-react'],
            'utils-vendor': ['localforage', 'uuid', 'jszip', 'jspdf', 'file-saver'],
            'virtual-vendor': ['react-virtuoso'],
          },
        },
      },
    },
  };
});
