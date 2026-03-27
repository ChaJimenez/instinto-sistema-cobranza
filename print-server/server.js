/**
 * INSTINTO — Servidor de Impresión Local
 * Corre en la computadora de la caja.
 * Pollea la nube cada 2s y manda tickets por TCP (puerto 9100) a las impresoras.
 *
 * Iniciar: node server.js
 */

const net = require('net');

const API_BASE = 'https://instinto-sistema-cobranza.vercel.app';

const PRINTERS = {
  cocina: { host: '192.168.3.166', port: 9100 },
  barra:  { host: '192.168.3.170', port: 9100 },
  recibo: { host: '192.168.101.100', port: 9100 },
};

const ESC = '\x1B';
const GS  = '\x1D';
const LINEA = '--------------------------------\n';

// ── Ticket de cocina / barra (sin precios) ──
function formatTicket(job) {
  let t = '';
  t += ESC + '@';
  t += ESC + 'a\x01';
  t += ESC + '!\x30';
  t += '=== ' + job.destino.toUpperCase() + ' ===\n';
  t += ESC + '!\x00';
  t += ESC + 'a\x00';
  t += LINEA;
  t += 'Mesa:    ' + job.mesa + '\n';
  t += 'Mesero:  ' + job.mesero + '\n';
  t += 'Hora:    ' + job.hora + '\n';
  t += LINEA;

  job.items.forEach(it => {
    t += ESC + 'E\x01';
    t += it.q + 'x  ' + it.n + '\n';
    t += ESC + 'E\x00';
    if (it.nota) t += '     > ' + it.nota + '\n';
  });

  t += LINEA + '\n\n\n';
  t += GS + 'V\x41\x00';
  return Buffer.from(t, 'latin1');
}

// ── Recibo de cuenta (con precios y total) ──
function formatRecibo(job) {
  const activos = (job.items || []).filter(it => !it.cancelado);
  const preview = job.preview;

  let t = '';
  t += ESC + '@';
  t += ESC + 'a\x01';
  t += ESC + '!\x30';
  t += 'INSTINTO\n';
  t += ESC + '!\x00';
  t += ESC + 'a\x00';
  t += LINEA;
  t += 'Mesa:    ' + job.mesa + '\n';
  t += 'Mesero:  ' + job.mesero + '\n';
  t += (job.fecha || '') + '  ' + (job.hora || '') + '\n';
  t += LINEA;

  activos.forEach(it => {
    const precio = it.cortesia ? 'CORTESIA' : '$' + (it.p * it.q).toLocaleString('es-MX');
    const nombre = it.q + 'x ' + it.n;
    const espacios = Math.max(1, 32 - nombre.length - precio.length);
    t += nombre + ' '.repeat(espacios) + precio + '\n';
    if (it.nota) t += '   > ' + it.nota + '\n';
  });

  t += LINEA;

  if ((job.cortesias || 0) > 0) {
    t += 'Cortesias:' + ' '.repeat(10) + '$' + job.cortesias.toLocaleString('es-MX') + '\n';
  }

  t += ESC + 'E\x01';
  t += 'TOTAL:' + ' '.repeat(18) + '$' + (job.total || 0).toLocaleString('es-MX') + '\n';
  t += ESC + 'E\x00';

  if (job.pago) t += 'Pago:    ' + job.pago + '\n';
  if ((job.propina || 0) > 0) t += 'Propina:' + ' '.repeat(11) + '$' + job.propina.toLocaleString('es-MX') + '\n';

  t += LINEA;
  t += ESC + 'a\x01';
  t += preview ? '-- cuenta previa --\n' : 'Gracias por su visita!\n';
  t += ESC + 'a\x00';
  t += '\n\n\n';
  t += GS + 'V\x41\x00';
  return Buffer.from(t, 'latin1');
}

// ── Enviar datos crudos a la impresora por TCP ──
function printRaw(host, port, data) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(5000);
    sock.connect(port, host, () => {
      sock.write(data, () => { sock.destroy(); resolve(); });
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('Timeout ' + host)); });
    sock.on('error', reject);
  });
}

// ── Pollear la API y procesar jobs ──
async function poll() {
  try {
    const res = await fetch(API_BASE + '/api/print-queue');
    if (!res.ok) return;
    const { jobs } = await res.json();
    const failed = [];

    for (const job of jobs) {
      const printer = PRINTERS[job.destino];
      if (!printer) { console.warn('⚠  Destino desconocido:', job.destino); continue; }
      try {
        const data = job.destino === 'recibo' ? formatRecibo(job) : formatTicket(job);
        await printRaw(printer.host, printer.port, data);
        console.log('✅ Impreso (' + job.destino + ')  Mesa ' + job.mesa + '  · ' + job.mesero + '  · ' + job.hora);
      } catch (e) {
        console.error('❌ Error en ' + job.destino + ' (' + printer.host + '):', e.message);
        failed.push(job);
      }
    }

    // Re-encolar los jobs que fallaron para no perderlos
    if (failed.length) {
      try {
        await fetch(API_BASE + '/api/requeue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobs: failed })
        });
        console.warn('🔄 Re-encolados ' + failed.length + ' job(s) fallidos — se reintentará');
      } catch (e) {
        console.error('❌ No se pudo re-encolar:', e.message);
      }
    }
  } catch (e) {
    // Silencioso — sin internet momentáneo
  }
}

console.log('');
console.log('🖨  INSTINTO — Servidor de Impresión v2');
console.log('   Cocina  → ' + PRINTERS.cocina.host + ':' + PRINTERS.cocina.port);
console.log('   Barra   → ' + PRINTERS.barra.host  + ':' + PRINTERS.barra.port);
console.log('   Recibo  → ' + PRINTERS.recibo.host + ':' + PRINTERS.recibo.port);
console.log('   Polling → ' + API_BASE);
console.log('   Intervalo: cada 2 segundos');
console.log('');

poll();
setInterval(poll, 2000);
