const express = require('express');
const cors = require('cors');
const { kv } = require('@vercel/kv');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const KEYS = { cmd: 'i:cmd', vta: 'i:vta', mes: 'i:mes', canc: 'i:canc', ts: 'i:lastUpdate' };
const PIN = process.env.PIN_ADMIN || '1234';

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
app.post('/api/guardar', async (req, res) => {
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
app.post('/api/importar', async (req, res) => {
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

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;
