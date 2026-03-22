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
  cocina: { host: '192.168.3.1',   port: 9100 },  // ← confirmar IP con self-test
  barra:  { host: '192.168.3.170', port: 9100 },
};

// ── Formatear ticket ESC/POS para Star TSP100 ──
function formatTicket(job) {
  const ESC = '\x1B';
  const GS  = '\x1D';

  let t = '';
  t += ESC + '@';         // Inicializar impresora
  t += ESC + 'a\x01';    // Centrar
  t += ESC + '!\x30';    // Doble tamaño
  t += '=== ' + job.destino.toUpperCase() + ' ===\n';
  t += ESC + '!\x00';    // Normal
  t += ESC + 'a\x00';    // Izquierda
  t += '--------------------------------\n';
  t += 'Mesa:    ' + job.mesa + '\n';
  t += 'Mesero:  ' + job.mesero + '\n';
  t += 'Hora:    ' + job.hora + '\n';
  t += '--------------------------------\n';

  job.items.forEach(it => {
    t += ESC + 'E\x01';  // Bold on
    t += it.q + 'x  ' + it.n + '\n';
    t += ESC + 'E\x00';  // Bold off
    if (it.nota) t += '     > ' + it.nota + '\n';
  });

  t += '--------------------------------\n';
  t += '\n\n\n';
  t += GS + 'V\x41\x00'; // Corte completo

  return Buffer.from(t, 'latin1');
}

// ── Enviar datos crudos a la impresora por TCP ──
function printRaw(host, port, data) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(5000);
    sock.connect(port, host, () => {
      sock.write(data, () => {
        sock.destroy();
        resolve();
      });
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('Timeout conectando a ' + host)); });
    sock.on('error', reject);
  });
}

// ── Pollear la API y procesar jobs ──
async function poll() {
  try {
    const res = await fetch(API_BASE + '/api/print-queue');
    if (!res.ok) return;
    const { jobs } = await res.json();

    for (const job of jobs) {
      const printer = PRINTERS[job.destino];
      if (!printer) {
        console.warn('⚠️  Destino desconocido:', job.destino);
        continue;
      }
      try {
        const data = formatTicket(job);
        await printRaw(printer.host, printer.port, data);
        console.log('✅ Impreso (' + job.destino + ')  Mesa ' + job.mesa + '  · ' + job.mesero + '  · ' + job.hora);
      } catch (e) {
        console.error('❌ Error en ' + job.destino + ' (' + printer.host + '):', e.message);
      }
    }
  } catch (e) {
    // Silencioso — puede ser sin internet momentáneo
  }
}

console.log('');
console.log('🖨  INSTINTO — Servidor de Impresión');
console.log('   Cocina → ' + PRINTERS.cocina.host + ':' + PRINTERS.cocina.port);
console.log('   Barra  → ' + PRINTERS.barra.host  + ':' + PRINTERS.barra.port);
console.log('   Polling → ' + API_BASE);
console.log('   Intervalo: cada 2 segundos');
console.log('');

poll(); // Primera llamada inmediata
setInterval(poll, 2000);
