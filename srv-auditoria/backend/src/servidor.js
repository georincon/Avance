import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import pg from 'pg';
import { registrarEvento, ErrorValidacion } from './ingesta.js';
import * as q from './consultas.js';

pg.types.setTypeParser(1082, (v) => v);   // columnas DATE como texto AAAA-MM-DD, sin corrimiento de zona horaria
const PUERTO = Number(process.env.PUERTO || 8110);
const CLAVE_WALLET = process.env.AUDITORIA_CLAVE_WALLET;      // la usan las wallets para reportar
const TOKEN_PANEL = process.env.AUDITORIA_TOKEN_PANEL;        // la usa el dashboard (solo lectura)
const DIR_FRONT = process.env.DIR_FRONTEND || '/app/frontend';
if (!CLAVE_WALLET || !TOKEN_PANEL) { console.error('Faltan AUDITORIA_CLAVE_WALLET y AUDITORIA_TOKEN_PANEL'); process.exit(1); }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
// Las consultas del dashboard corren con un rol que solo puede leer.
const lectura = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, options: '-c search_path=auditoria,public -c default_transaction_read_only=on' });
pool.on('connect', (c) => c.query('SET search_path = auditoria, public'));

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp' };

const iguales = (a, b) => { const x = Buffer.from(a || ''); const y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); };
const json = (res, st, obj) => { res.writeHead(st, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const ip = (req) => (req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace('::ffff:', '') || null;

async function cuerpo(req, max = 1_000_000) {
  const partes = []; let n = 0;
  for await (const p of req) { n += p.length; if (n > max) throw new ErrorValidacion('cuerpo demasiado grande'); partes.push(p); }
  try { return JSON.parse(Buffer.concat(partes).toString('utf8') || '{}'); } catch { throw new ErrorValidacion('JSON inválido'); }
}

async function ingesta(req, res, ruta) {
  if (!iguales(req.headers['x-api-key'], CLAVE_WALLET)) return json(res, 401, { error: 'clave de wallet inválida' });
  const b = await cuerpo(req);
  const lista = ruta.endsWith('/lote') ? b.eventos : [b];
  if (!Array.isArray(lista) || lista.length > 200) throw new ErrorValidacion('lote inválido (máximo 200 eventos)');
  const resultados = [];
  for (const e of lista) {
    try { resultados.push({ evento_id: e?.evento_id, ...(await registrarEvento(pool, e, ip(req))) }); }
    catch (err) {
      if (!(err instanceof ErrorValidacion)) throw err;
      resultados.push({ evento_id: e?.evento_id, error: err.message });
    }
  }
  if (!ruta.endsWith('/lote') && resultados[0].error) return json(res, 400, resultados[0]);
  return json(res, 202, ruta.endsWith('/lote') ? { resultados } : resultados[0]);
}

async function panel(req, res, url) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!iguales(auth, TOKEN_PANEL)) return json(res, 401, { error: 'no autorizado' });
  const p = url.pathname.replace(/^\/api\/panel/, '');
  const f = Object.fromEntries(url.searchParams);
  pool.query('INSERT INTO auditoria.consulta_dashboard (direccion_ip, ruta, parametros) VALUES ($1,$2,$3)', [ip(req), p, JSON.stringify(f)]).catch(() => {});
  let m;
  if (p === '/resumen') return json(res, 200, await q.resumen(lectura, f.dias));
  if (p === '/series') return json(res, 200, await q.series(lectura, f.dias));
  if (p === '/distribucion') return json(res, 200, await q.distribucion(lectura, f.dias));
  if (p === '/catalogos') return json(res, 200, await q.catalogos(lectura));
  if (p === '/contrapartes') return json(res, 200, await q.contrapartes(lectura));
  if (p === '/actividades') return json(res, 200, await q.actividades(lectura, f));
  if (p === '/actividades.csv') {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="actividades.csv"' });
    return res.end('﻿' + await q.actividadesCsv(lectura, f));
  }
  if ((m = p.match(/^\/actividades\/(\d+)$/))) { const r = await q.actividad(lectura, m[1]); return r ? json(res, 200, r) : json(res, 404, { error: 'no existe' }); }
  if (p === '/wallets') return json(res, 200, await q.wallets(lectura, f));
  if ((m = p.match(/^\/wallets\/([0-9a-f-]{36})$/i))) { const r = await q.wallet(lectura, m[1]); return r ? json(res, 200, r) : json(res, 404, { error: 'no existe' }); }
  if (p === '/usuarios') return json(res, 200, await q.usuarios(lectura, f));
  if ((m = p.match(/^\/usuarios\/([0-9a-f-]{36})$/i))) { const r = await q.usuario(lectura, m[1]); return r ? json(res, 200, r) : json(res, 404, { error: 'no existe' }); }
  return json(res, 404, { error: 'ruta desconocida' });
}

async function estatico(res, ruta) {
  const rel = normalize(ruta === '/' ? '/index.html' : ruta).replace(/^(\.\.[/\\])+/, '');
  try {
    const dato = await readFile(join(DIR_FRONT, rel));
    res.writeHead(200, { 'content-type': MIME[extname(rel)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(dato);
  } catch { res.writeHead(404); res.end('no encontrado'); }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/salud') return json(res, 200, { estado: 'ok' });
    if (req.method === 'POST' && /^\/api\/v1\/eventos(\/lote)?$/.test(url.pathname)) return await ingesta(req, res, url.pathname);
    if (req.method === 'GET' && url.pathname.startsWith('/api/panel/')) return await panel(req, res, url);
    if (req.method === 'GET') return await estatico(res, url.pathname);
    json(res, 405, { error: 'método no permitido' });
  } catch (err) {
    if (err instanceof ErrorValidacion) return json(res, 400, { error: err.message });
    console.error(err);
    json(res, 500, { error: 'error interno' });
  }
}).listen(PUERTO, () => console.log(`srv-auditoria escuchando en :${PUERTO}`));
