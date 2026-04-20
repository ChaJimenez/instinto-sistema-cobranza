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

// ── Gerentes autorizadores ──
const GERENTES_KEY = 'i:gerentes';

// Nombres de gerentes (sin PINs)
app.get('/api/gerentes', async (req, res) => {
  try {
    const lista = await kv.get(GERENTES_KEY) || [];
    res.json({ gerentes: lista.map(x => x.nombre) });
  } catch(e) { res.json({ gerentes: [] }); }
});

// Validar PIN de un gerente específico
app.post('/api/gerentes/validar', async (req, res) => {
  try {
    const { nombre, pin } = req.body || {};
    if (!nombre || !pin) return res.json({ ok: false });
    const lista = await kv.get(GERENTES_KEY) || [];
    const ok = lista.some(x => x.nombre === nombre && x.pin === String(pin));
    res.json({ ok });
  } catch(e) { res.status(500).json({ ok: false }); }
});

// Guardar lista de gerentes (requiere PIN admin)
// Si un gerente tiene pin '___keep___', se preserva el PIN existente de Redis
app.post('/api/gerentes/guardar', async (req, res) => {
  try {
    const { pin_admin, gerentes } = req.body || {};
    if (pin_admin !== PIN) return res.status(401).json({ error: 'PIN incorrecto' });
    if (!Array.isArray(gerentes)) return res.status(400).json({ error: 'Formato inválido' });
    const existentes = await kv.get(GERENTES_KEY) || [];
    const pinMap = {};
    existentes.forEach(g => { pinMap[g.nombre] = g.pin; });
    const nuevaLista = gerentes.map(g => ({
      nombre: g.nombre,
      pin: g.pin === '___keep___' ? (pinMap[g.nombre] || '') : String(g.pin)
    }));
    await kv.set(GERENTES_KEY, nuevaLista);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Alertas de inventario (lee inv:insumos + proyecta consumo de i:vta) ──
app.get('/api/inv-alertas', async (req, res) => {
  try {
    const [insumosRaw, recetasRaw, posVentas, cortesRaw, configRaw, toteatDias] = await Promise.all([
      kv.get('inv:insumos'),
      kv.get('inv:recetas'),
      kv.get(KEYS.vta),
      kv.get('inv:cortes'),
      kv.get('inv:config'),
      kv.get('inv:toteatDias'),
    ]);

    const insumos   = insumosRaw  || [];
    const recetas   = recetasRaw  || [];
    const ventas    = posVentas   || [];
    const cortes    = cortesRaw   || [];
    const config    = configRaw   || {};
    const toteatArr = toteatDias  || [];

    const fechaInicio     = config.fechaInicioVentas || '2000-01-01';
    const fechasProcesadas = new Set(cortes.map(c => c.fecha));

    const normFecha = (v) => {
      if (v.fecha) {
        const f = v.fecha;
        if (f.includes('/')) {
          const [d,m,y] = f.split('/');
          return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        }
        return f.slice(0,10);
      }
      return new Date(v.id).toISOString().slice(0,10);
    };

    const recetaMap = {};
    recetas.forEach(r => { recetaMap[r.platillo] = r.ingredientes || []; });

    // Consumo proyectado de ventas no procesadas en corte
    const consumo = {};
    ventas.filter(v => {
      if (v.excluida) return false;
      const fv = normFecha(v);
      return fv >= fechaInicio && !fechasProcesadas.has(fv);
    }).forEach(v => {
      (v.items || []).filter(it => !it.cancelado).forEach(item => {
        const receta = recetaMap[item.n];
        if (!receta) return;
        const qty = item.q || 1;
        receta.forEach(ing => {
          consumo[ing.insumoId] = (consumo[ing.insumoId] || 0) + ing.cantidad * qty;
        });
      });
    });

    // Insumos bajo mínimo (stock proyectado)
    const alertas = insumos
      .filter(ins => ins.stockMin > 0)
      .map(ins => {
        const proyectado = Math.max(0, ins.stock - (consumo[ins.id] || 0));
        return { id: ins.id, nombre: ins.nombre, unidad: ins.unidad,
                 stock: ins.stock, proyectado, stockMin: ins.stockMin,
                 critico: proyectado <= ins.stockMin * 0.5 };
      })
      .filter(ins => ins.proyectado <= ins.stockMin);

    // Días faltantes de Toteat (últimos 3 días excluido hoy)
    const diasFaltantes = [];
    if (config.fechaInicioVentas) {
      for (let i = 1; i <= 3; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0,10);
        if (d >= config.fechaInicioVentas && !toteatArr.includes(d)) {
          diasFaltantes.push(d);
        }
      }
    }

    res.json({ alertas, diasFaltantes, totalAlertas: alertas.length + diasFaltantes.length });
  } catch (e) {
    console.error('/api/inv-alertas', e);
    res.json({ alertas: [], diasFaltantes: [], totalAlertas: 0 });
  }
});

// ── Toteat días (proxy al key compartido inv:toteatDias) ──
app.get('/api/toteat-dias', async (req, res) => {
  try {
    const dias = await kv.get('inv:toteatDias') || [];
    res.json({ dias });
  } catch (e) { res.json({ dias: [] }); }
});

app.post('/api/toteat-dias', async (req, res) => {
  try {
    const { fecha } = req.body || {};
    if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
    const dias = await kv.get('inv:toteatDias') || [];
    if (!dias.includes(fecha)) { dias.push(fecha); dias.sort(); await kv.set('inv:toteatDias', dias); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Menú configurable ──
const MENU_KEY = 'i:menu';

app.get('/api/menu', async (req, res) => {
  try {
    const menu = await kv.get(MENU_KEY);
    res.json({ menu: menu || null });
  } catch (e) {
    res.json({ menu: null });
  }
});

app.post('/api/menu', async (req, res) => {
  try {
    const { pin, categorias, extras, log86 } = req.body || {};
    if (pin !== PIN) return res.status(401).json({ error: 'PIN incorrecto' });
    if (!categorias || typeof categorias !== 'object') return res.status(400).json({ error: 'Formato inválido' });
    await kv.set(MENU_KEY, { categorias, extras: extras || [] });
    if (Array.isArray(log86) && log86.length) {
      await kv.rpush('i:86log', ...log86.map(e => JSON.stringify(e)));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/menu POST:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Reporte 86 — historial de ítems desactivados/reactivados ──
app.get('/api/86log', async (req, res) => {
  try {
    const raw = await kv.lrange('i:86log', -200, -1);
    const entries = raw.map(e => (typeof e === 'string' ? JSON.parse(e) : e));
    res.json({ entries: entries.reverse() });
  } catch(e) { res.json({ entries: [] }); }
});

// ── Empleados (todos: meseros, cocineros, gerentes, etc.) ──
const EMPLEADOS_KEY = 'i:empleados';

app.get('/api/empleados', async (req, res) => {
  try {
    const lista = await kv.get(EMPLEADOS_KEY) || [];
    res.json({ empleados: lista });
  } catch(e) { res.json({ empleados: [] }); }
});

app.post('/api/empleados', async (req, res) => {
  try {
    const { pin, empleados } = req.body || {};
    if (pin !== PIN) return res.status(401).json({ error: 'PIN incorrecto' });
    if (!Array.isArray(empleados)) return res.status(400).json({ error: 'Formato inválido' });
    await kv.set(EMPLEADOS_KEY, empleados);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Turnos — check-in / check-out ──
// Cada turno: { id, nombre, rol, salarioDia, fecha, entrada, salida }
// Key diario: i:turnos:YYYY-MM-DD (expira en 90 días)

function fechaHoy() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' });
}

app.post('/api/turno/entrada', async (req, res) => {
  try {
    const { nombre } = req.body || {};
    if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
    const fecha = fechaHoy();
    const key = `i:turnos:${fecha}`;
    const turnos = await kv.get(key) || [];
    // Verificar que no tenga entrada activa sin salida
    const activo = turnos.find(t => t.nombre === nombre && !t.salida);
    if (activo) return res.json({ ok: false, yaEntro: true });
    const turno = { id: Date.now(), nombre, fecha, entrada: new Date().toISOString(), salida: null };
    turnos.push(turno);
    await kv.set(key, turnos, { ex: 60 * 60 * 24 * 90 });
    res.json({ ok: true, turno });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/turno/salida', async (req, res) => {
  try {
    const { nombre } = req.body || {};
    if (!nombre) return res.status(400).json({ error: 'Falta nombre' });
    const fecha = fechaHoy();
    const key = `i:turnos:${fecha}`;
    const turnos = await kv.get(key) || [];
    const turno = turnos.find(t => t.nombre === nombre && !t.salida);
    if (!turno) return res.json({ ok: false, noEntrada: true });
    turno.salida = new Date().toISOString();
    const mins = Math.round((new Date(turno.salida) - new Date(turno.entrada)) / 60000);
    turno.minutos = mins;
    await kv.set(key, turnos, { ex: 60 * 60 * 24 * 90 });
    res.json({ ok: true, turno, minutos: mins });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/turno/hoy', async (req, res) => {
  try {
    const fecha = fechaHoy();
    const [turnos, empleados] = await Promise.all([
      kv.get(`i:turnos:${fecha}`) || [],
      kv.get(EMPLEADOS_KEY) || [],
    ]);
    const turnosReal = turnos || [];
    // Enriquecer con salarioDia del catálogo
    const empMap = {};
    (empleados || []).forEach(e => { empMap[e.nombre] = e; });
    const enriquecidos = turnosReal.map(t => ({
      ...t,
      rol: empMap[t.nombre]?.rol || '',
      salarioDia: empMap[t.nombre]?.salarioDia || 0,
    }));
    res.json({ fecha, turnos: enriquecidos });
  } catch(e) { res.json({ fecha: fechaHoy(), turnos: [] }); }
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

module.exports = app;
