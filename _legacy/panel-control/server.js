import http from 'node:http';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = process.env.AVANCE_ROOT || '/home/geovani/Workspace/Avance';
const projectDir = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.join(root, 'proxy-nginx');
const port = Number(process.env.PORT || 4173);
const token = process.env.CONTROL_PANEL_TOKEN || '';
if (token.length < 32) throw new Error('CONTROL_PANEL_TOKEN debe tener al menos 32 caracteres aleatorios.');

const entries = [
  { id:'issuer-registraduria', name:'Issuer Registraduría', group:'Servicios de identidad', folder:'eudi-srv-issuer-pid-registraduria/docker-compose', compose:'docker-compose.yaml', overlay:'registraduria.yaml', url:'/issuer/pid-registraduria/', icon:'badge', description:'Emisión de identidad PID' },
  { id:'issuer-uis', name:'Issuer UIS', group:'Servicios de identidad', folder:'eudi-srv-issuer-pid-uis/docker-compose', compose:'docker-compose.yaml', overlay:'uis.yaml', url:'/issuer/pid-uis/', icon:'badge', description:'Emisión de credenciales UIS' },
  { id:'verifier', name:'Verifier', group:'Servicios de confianza', folder:'eudi-srv-verifier-generic/docker-compose', compose:'docker-compose.yaml', overlay:'verifier.yaml', url:'/verifier/actuator/health', icon:'shield', description:'Verificación de credenciales digitales' },
  { id:'newwallet', name:'New Wallet', group:'Aplicaciones', folder:'eudi-app-wallet-new_wallet/docker-compose', compose:'docker-compose.yaml', overlay:'newwallet.yaml', url:'/onboarding/', icon:'wallet', description:'Onboarding y servicios de wallet' },
  { id:'spartans', name:'Wallet Provider Spartans', group:'Servicios de wallet', folder:'eudi-srv-wallet-provider/docker', compose:'docker-compose.yaml', overlay:'spartans.yaml', url:'/spartans/', icon:'database', description:'Proveedor de wallet Spartans' },
  { id:'pid-issuer', name:'PID Issuer', group:'Servicios de identidad', folder:'otros/eudi-srv-pid-issuer/docker-compose', compose:'docker-compose.yaml', overlay:'pid-issuer.yaml', url:'/pid-issuer/', icon:'badge', description:'Emisor PID adicional' },
  { id:'onboarding-addi', name:'Onboarding Addi', group:'Aplicaciones', folder:'otros/addi/OnboardingAddi/docker-compose', compose:'docker-compose.yaml', overlay:'onboarding.yaml', url:'/addi/onboarding/', icon:'wallet', description:'Onboarding y servicio biométrico' },
  { id:'proxy-nginx', name:'Proxy Nginx', group:'Gateway', folder:'proxy-nginx', compose:'docker-compose.yaml', url:'/', icon:'globe', description:'Enrutamiento de aplicaciones locales', service:'proxy-nginx', isProxy:true }
];

const projects = (await Promise.all(entries.map(async (item) => {
  const directory = path.resolve(root, item.folder);
  const composePath = path.resolve(directory, item.compose);
  const overlayPath = item.overlay ? path.join(proxyDir, 'overrides', item.overlay) : null;
  try {
    await access(composePath);
    if (overlayPath) await access(overlayPath);
    return { ...item, directory, composeFiles:[composePath, ...(overlayPath ? [overlayPath] : [])] };
  } catch {
    return null;
  }
}))).filter(Boolean);

function composeArgs(project, args) {
  return ['compose', ...project.composeFiles.flatMap((file) => ['-f', file]), ...args];
}
function run(args, cwd, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd, stdio:['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('Docker tardó demasiado en responder.'));
    }, timeout);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('No se pudo ejecutar Docker: ' + error.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || 'Docker terminó con código ' + code + '.'));
    });
  });
}
function parseContainers(output) {
  if (!output) return [];
  if (output.trim().startsWith('[')) return JSON.parse(output);
  return output.split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line));
}
function publicProject(project, state, running, total, error) {
  return { id:project.id, name:project.name, group:project.group, url:project.url, icon:project.icon, description:project.description, state, running, total, ...(error ? {error} : {}) };
}
async function status(project) {
  try {
    const args = ['ps','--all','--format','json', ...(project.service ? [project.service] : [])];
    const containers = parseContainers(await run(composeArgs(project, args), project.directory, 15_000));
    const running = containers.filter((container) => String(container.State || '').toLowerCase() === 'running').length;
    const state = running === 0 ? 'stopped' : running === containers.length ? 'running' : 'partial';
    return publicProject(project, state, running, containers.length);
  } catch (error) {
    const unavailable = /cannot connect|daemon|is the docker daemon running|permission denied/i.test(error.message);
    return publicProject(project, unavailable ? 'unavailable' : 'stopped', 0, 0, error.message);
  }
}
function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(body);
}
function authorized(req) {
  const value = req.headers.authorization || '';
  const supplied = value.startsWith('Bearer ') ? Buffer.from(value.slice(7)) : Buffer.alloc(0);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (part) => {
      data += part;
      if (data.length > 2048) reject(new Error('Solicitud demasiado grande.'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(new Error('JSON no válido.')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) {
    if (!authorized(req)) return send(res, 401, {error:'Token de acceso incorrecto o ausente.'});
    if (pathname === '/api/projects' && req.method === 'GET') return send(res, 200, await Promise.all(projects.map(status)));
    const parts = pathname.split('/');
    const isAction = parts.length === 5 && parts[1] === 'api' && parts[2] === 'projects' && parts[4] === 'action';
    if (isAction && req.method === 'POST') {
      const project = projects.find((item) => item.id === parts[3]);
      if (!project) return send(res, 404, {error:'No se encontró ese proyecto.'});
      try {
        const {action} = await readBody(req);
        if (!['up','down','restart'].includes(action)) return send(res, 400, {error:'Acción no permitida.'});
        let args;
        if (project.isProxy) {
          args = action === 'up' ? ['up','-d','proxy-nginx'] : action === 'down' ? ['stop','proxy-nginx'] : ['restart','proxy-nginx'];
        } else {
          args = action === 'up' ? ['up','-d','--build'] : action === 'down' ? ['down'] : ['restart'];
        }
        await run(composeArgs(project, args), project.directory, 10 * 60_000);
        return send(res, 200, await status(project));
      } catch (error) {
        return send(res, 500, {error:error.message});
      }
    }
    return send(res, 404, {error:'Ruta no encontrada.'});
  }

  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(projectDir, relative);
  if (!file.startsWith(projectDir + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const content = await readFile(file);
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, {'content-type':type + '; charset=utf-8','x-content-type-options':'nosniff'});
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
server.listen(port, '0.0.0.0', () => console.log('Control Avance disponible en puerto ' + port + ' · ' + projects.length + ' stacks enlazados'));
