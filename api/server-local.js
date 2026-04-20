// Servidor local para preview — no requiere Vercel CLI
const path = require('path');
const fs   = require('fs');

// Cargar .env.local si existe (credenciales Redis en local)
const envFile = path.join(__dirname, '../.env.local');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) return;
    const k = trimmed.slice(0, eqIdx).trim();
    let v = trimmed.slice(eqIdx + 1).trim();
    // Quitar comillas simples o dobles
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k && !process.env[k]) process.env[k] = v;
  });
}
const app  = require('./index');

const PORT = process.env.PORT || 3001;
const PUB  = path.join(__dirname, '../public');

// Rutas estáticas con mapping igual al vercel.json
const PAGES = {
  '/cocina': 'cocina.html',
  '/turnos': 'turnos.html',
};

app.get('/cocina', (_req, res) => res.sendFile(path.join(PUB, 'cocina.html')));
app.get('/turnos', (_req, res) => res.sendFile(path.join(PUB, 'turnos.html')));

// Archivos estáticos (sw.js, etc.)
const { static: staticMw } = require('express');
app.use(staticMw(PUB));

// Catch-all → POS principal
app.get('*', (_req, res) => res.sendFile(path.join(PUB, 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  ✓ POS       → http://localhost:${PORT}`);
  console.log(`  ✓ Cocina    → http://localhost:${PORT}/cocina`);
  console.log(`  ✓ Turnos    → http://localhost:${PORT}/turnos`);
  console.log(`\n  Ctrl+C para detener\n`);
});
