const express = require('express');
const cors = require('cors');
const { Redis } = require('@upstash/redis');

const kv = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const KEYS = { cmd: 'i:cmd', vta: 'i:vta', mes: 'i:mes', canc: 'i:canc', ts: 'i:lastUpdate' };
const PIN = process.env.PIN_ADMIN || '1234';
const API_SECRET = process.env.API_SECRET;

// Middleware de autenticación — solo activo si API_SECRET está configurado en Vercel
function requireAuth(req, res, next) {
  if (!API_SECRET) return next();
  if (req.headers['x-api-key'] !== API_SECRET) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── Cargar todos los datos ──
app.get('/api/datos', async (req, res) => {
  try {
    const [cmd, vta, mes, canc] = await Promise.all([
      kv.get(KEYS.cmd),
      kv.get(KEYS.vta),
      kv.get(KEYS.mes),
      kv.get(KEYS.canc),
    ]);
    res.json({ cmd: cmd || [], vta: vta || [], mes: mes || [], canc: canc || [] });
  } catch (e) {
    console.error('Error /api/datos:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Guardar todos los datos ──
app.post('/api/guardar', requireAuth, async (req, res) => {
  try {
    const { cmd, vta, mes, canc } = req.body;
    await Promise.all([
      kv.set(KEYS.cmd, cmd || []),
      kv.set(KEYS.vta, vta || []),
      kv.set(KEYS.mes, mes || []),
      kv.set(KEYS.canc, canc || []),
      kv.set(KEYS.ts, Date.now()),
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error /api/guardar:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Timestamp para polling de sync ──
app.get('/api/lastUpdate', async (req, res) => {
  try {
    const ts = await kv.get(KEYS.ts);
    res.json({ ts: ts || 0 });
  } catch (e) {
    res.json({ ts: 0 });
  }
});

// ── Importar backup de localStorage (una sola vez) ──
app.post('/api/importar', requireAuth, async (req, res) => {
  try {
    const { pin, cmd, vta, mes, canc } = req.body;
    if (pin !== PIN) return res.status(401).json({ error: 'PIN incorrecto' });
    await Promise.all([
      kv.set(KEYS.cmd, cmd || []),
      kv.set(KEYS.vta, vta || []),
      kv.set(KEYS.mes, mes || []),
      kv.set(KEYS.canc, canc || []),
      kv.set(KEYS.ts, Date.now()),
    ]);
    res.json({ ok: true, importados: { cmd: (cmd||[]).length, vta: (vta||[]).length, mes: (mes||[]).length, canc: (canc||[]).length } });
  } catch (e) {
    console.error('Error /api/importar:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Impresión en cocina / barra ──
const BARRA_CATS = ['Refrescos', 'Cervezas', 'Cervezas Artesanales', 'Preparados'];

app.post('/api/imprimir', requireAuth, async (req, res) => {
  try {
    const { mesa, mesero, items = [], hora } = req.body;
    const activos = items.filter(it => !it.cancelado);
    const cocina = activos.filter(it => !BARRA_CATS.includes(it.cat));
    const barra  = activos.filter(it =>  BARRA_CATS.includes(it.cat));
    const ts = Date.now();
    const jobs = [];
    if (cocina.length) jobs.push({ id: ts + 'c', destino: 'cocina', mesa, mesero, items: cocina, hora, ts });
    if (barra.length)  jobs.push({ id: ts + 'b', destino: 'barra',  mesa, mesero, items: barra,  hora, ts });
    if (jobs.length) await kv.rpush('i:printjobs', ...jobs.map(j => JSON.stringify(j)));
    res.json({ ok: true, enviados: jobs.length });
  } catch (e) {
    console.error('Error /api/imprimir:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Imprimir recibo de cuenta (preview o ticket final) ──
app.post('/api/imprimir-recibo', requireAuth, async (req, res) => {
  try {
    const job = { id: Date.now() + 'r', destino: 'recibo', ts: Date.now(), ...req.body };
    await kv.rpush('i:printjobs', JSON.stringify(job));
    res.json({ ok: true });
  } catch (e) {
    console.error('Error /api/imprimir-recibo:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/print-queue', async (req, res) => {
  try {
    const raw = await kv.lrange('i:printjobs', 0, -1);
    if (raw.length) await kv.del('i:printjobs');
    const jobs = raw.map(j => (typeof j === 'string' ? JSON.parse(j) : j));
    res.json({ jobs });
  } catch (e) {
    res.json({ jobs: [] });
  }
});

// ── Re-encolar jobs que fallaron al imprimir ──
app.post('/api/requeue', requireAuth, async (req, res) => {
  try {
    const { jobs = [] } = req.body;
    if (jobs.length) await kv.rpush('i:printjobs', ...jobs.map(j => JSON.stringify(j)));
    res.json({ ok: true, requeued: jobs.length });
  } catch (e) {
    console.error('Error /api/requeue:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Validar PIN (sin exponer el PIN en el cliente) ──
app.post('/api/validate-pin', async (req, res) => {
  const { pin } = req.body || {};
  if (pin === PIN) res.json({ ok: true });
  else res.status(401).json({ ok: false });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;
