/**
 * Üretim: statik dosya + OpenAI API proxy (CORS olmadan tarayıcıdan çağrı için).
 * Kullanım: npm run build && npm start
 */
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const dist = path.join(__dirname, 'dist');

app.use(
  '/openai',
  createProxyMiddleware({
    target: 'https://api.openai.com',
    changeOrigin: true,
    pathRewrite: { '^/openai': '' },
  })
);

app.use(express.static(dist));

app.use((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(404).end();
    return;
  }
  res.sendFile(path.join(dist, 'index.html'));
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Excel çeviri: http://localhost:${port}`);
});
