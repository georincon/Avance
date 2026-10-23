import http from 'node:http';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = process.env.AVANCE_ROOT || '/home/geovani/Workspace/Avance';
const projectDir = path.dirname(fileURLToPath(import.meta.url));
const proxyDir = path.join(root, 'srv-nw-nginx', 'docker-compose');
const port = Number(process.env.PORT || 4173);
const token = process.env.CONTROL_PANEL_TOKEN || '';
if (token.length < 32) throw new Error('CONTROL_PANEL_TOKEN debe tener al menos 32 caracteres aleatorios.');

/**
 * Una aplicación de verifiers/<nombre> con su verifier.
 *
 * Son dos proyectos de Compose, cada uno con su .env (el de la app, y el de la instancia del
 * verifier en verifiers/_comun/instancias/<nombre>). Los .env los crea `levantar.sh` la primera
 * vez (claves, certificado de registro en el tl-publisher): el panel solo levanta y detiene lo
 * que ya existe, y avisa si falta.
 */
function verifierApp(nombre, titulo, description, icon) {
  const comun = 'verifiers/_comun';
  return {
    id:'verifier-' + nombre, name:titulo, group:'Verifiers', folder:'verifiers/' + nombre, compose:'compose.yml',
    url:'/' + nombre + '/', icon, description,
    containers:[nombre + '-' + nombre + '-1', 'verifier-' + nombre + '-haproxy-1', 'verifier-' + nombre + '-verifier-api-1', 'verifier-' + nombre + '-verifier-web-1'],
    stacks:[
      { project:'verifier-' + nombre, dir:comun, file:'compose.yml', env:'instancias/' + nombre + '/.env' },
      { project:nombre, dir:'verifiers/' + nombre, file:'compose.yml', env:'.env' },
    ],
  };
}

const entries = [
  // Los dos emisores tienen su PROPIO Keycloak. El panel ofrece "Activar consola"
  // para dejar solo uno en pie: el proxy publico reescribe el Path de todas las
  // cookies a "/", asi que dos instancias de Keycloak en el mismo dominio
  // comparten AUTH_SESSION_ID y KC_RESTART, y la segunda consola pisa a la
  // primera. Ver README.md, seccion "Los dos Keycloak".
  { id:'issuer-registraduria', name:'Issuer Registraduría', group:'Servicios de identidad', folder:'eudi-srv-issuer-pid-registraduria/docker-compose', compose:'docker-compose.yaml', url:'/pid-registraduria/', icon:'badge', description:'Emisión de identidad PID', keycloakService:'keycloak', keycloakUrl:'/idp-reg/admin/master/console/', keycloakName:'Keycloak de la Registraduría', peerId:'issuer-uis', peerName:'Issuer UIS', containers:['haproxy-reg','keycloak-reg','pid-issuer-reg','postgres-reg','status-list-reg'], services:['haproxy','keycloak','pid-issuer','postgres','status-list'] },
  { id:'issuer-uis', name:'Issuer UIS', group:'Servicios de identidad', folder:'eudi-srv-issuer-pid-uis/docker-compose', compose:'docker-compose.yaml', url:'/uis-issuer/', icon:'badge', description:'Emisión de credenciales PuB-EAA (UIS)', keycloakService:'keycloak-uis', keycloakUrl:'/idp-uis/admin/master/console/', keycloakName:'Keycloak de la UIS', peerId:'issuer-registraduria', peerName:'Issuer Registraduría', containers:['haproxy-uis','keycloak-uis','uis-issuer','postgres-uis-issuer','postgres-uis-academic','status-list-uis'], services:['haproxy-uis','keycloak-uis','uis-issuer','postgres-uis-issuer','postgres-uis-academic','status-list-uis'] },
  { id:'wallet-provider', name:'Wallet Provider (único)', group:'Servicios de wallet', folder:'eudi-srv-wallet-provider/docker-compose', compose:'docker-compose.yaml', url:'/wallet-provider/', icon:'database', description:'Proveedor de wallet: emite WUA y Key Attestations', containers:['spartans-wallet-provider','postgres-spartans','status-list-spartans'], services:['spartans-wallet-provider','postgres-spartans','status-list-spartans'] },
  { id:'onboarding', name:'Onboarding', group:'Aplicaciones', folder:'srv-onboarding/docker-compose', compose:'docker-compose.yaml', url:'/onboarding/', icon:'wallet', description:'Onboarding de usuario (identity proofing)', containers:['onboarding-backend','onboarding-biometrics','onboarding-postgres'], services:['onboarding-backend','onboarding-biometrics','onboarding-postgres'] },
  { id:'app-new-wallet', name:'App New Wallet (ancla)', group:'Aplicaciones', folder:'app-new-wallet/docker-compose', compose:'docker-compose.yaml', url:'', icon:'wallet', description:'Ancla de la app Android en la red compartida: sin ella la app no alcanza al ecosistema', containers:['newwallet-anchor'], services:['network-anchor'] },
  // Las aplicaciones de ejemplo de verifiers/ (una por sector). Cada una son DOS proyectos
  // de Compose: la app (verifiers/<n>/compose.yml) y su verifier propio (verifiers/_comun,
  // instancia <n>). No estan en el compose raiz, asi que se manejan con `stacks`, igual que la
  // UIS tiene su propio compose. El orden importa: el verifier va primero.
  verifierApp('banco', 'Verifier Banco', 'Banco Cívica: ingreso y apertura de cuenta presentando el PID', 'bank'),
  verifierApp('contratacion', 'Verifier Contratación', 'Contratación: comprueba la formación académica de una persona candidata y le hace firmar el contrato de trabajo desde su wallet', 'briefcase'),
  verifierApp('discoteca', 'Verifier Discoteca', 'Discoteca: comprueba la mayoría de edad sin guardar ningún dato', 'nightlife'),
  verifierApp('notaria', 'Notaría', 'Notaría de ejemplo: verifica el PID y emite 6 documentos notariales (poder, fe de vida, autenticación de firma, permiso de menor…)', 'notary'),
  verifierApp('eps', 'Verifier EPS', 'EPS: carné de afiliado e historia clínica con la wallet; portal médico', 'health'),
  verifierApp('aerolinea', 'Aerolínea (Páramo Air)', 'Aerolínea de ejemplo: verifica nombre, documento, edad y foto, vende el pasaje y emite el tiquete a la wallet', 'plane'),
  verifierApp('acceso', 'Verifier Control de acceso', 'Portería: foto, nombre y documento del PID para que un guardia decida el ingreso', 'shield-check'),
  verifierApp('pensiones', 'Verifier Fondo de pensiones', 'Prueba de supervivencia: acepta la fe de vida notarial y la cruza con el PID', 'health'),
  verifierApp('cancilleria', 'Verifier Cancillería', 'Pasaportes: identifica con el PID y emite el pasaporte digital (PuB-EAA)', 'globe'),
  verifierApp('beca', 'Verifier Inscripción y becas', 'Admisiones y becas: pre-evalúa con PID + credencial académica sin saber quién es la persona', 'school'),
  { id:'trust-validator', name:'Trust Validator', group:'Servicios de confianza', folder:'eudi-srv-trust-validator/docker-compose', compose:'docker-compose.yaml', url:'/trust-validator/actuator/health', icon:'shield', description:'Validador de confianza (LoTE/TSL)', containers:['trust-validator'], services:['trust-validator'] },
  // Simulador del prestador de firma remota (estilo Andes SCD): API CSC v2, certificados de firma de la
  // sub-CA QTSP y sellado de tiempo. Un solo proyecto de Compose con su .env, como las apps de verifiers/.
  { id:'andes-scd', name:'Servicio de firma (Andes SCD)', group:'Servicios de confianza', folder:'srv-andes-scd', compose:'compose.yml', url:'/andes-scd/', icon:'shield', description:'Simulador del prestador de firma remota: identifica con el PID, emite certificados de firma (sub-CA QTSP), firma (CSC v2) y sella el tiempo', levantar:'srv-andes-scd/levantar.sh', containers:['andes-scd','verifier-firma-haproxy-1','verifier-firma-verifier-api-1','verifier-firma-verifier-web-1'], stacks:[
    // Primero su verifier (identifica al firmante con el PID); `down` los recorre al revés.
    { project:'verifier-firma', dir:'verifiers/_comun', file:'compose.yml', env:'instancias/firma/.env' },
    { project:'andes-scd', dir:'srv-andes-scd', file:'compose.yml', env:'.env' },
  ] },
  { id:'tl-publisher', name:'Publicador de listas', group:'Servicios de confianza', folder:'srv-tl-publisher/docker-compose', compose:'docker-compose.yaml', url:'/tl-publisher/tl-api/v1/lists', icon:'shield', description:'Publica las Trusted Lists locales (ETSI TS 119 612)', containers:['tl-publisher','tl-publisher-pki','tlp-db'], services:['tl-publisher','pki','tlp-db'] },
  { id:'proxy-nginx', name:'Proxy Nginx (único)', group:'Gateway', folder:'srv-nw-nginx/docker-compose', compose:'docker-compose.yaml', url:'/', icon:'globe', description:'Punto de entrada único del ecosistema', service:'nw-nginx', isProxy:true, alwaysUp:true, containers:['nw-nginx','nw-certbot-renew'], services:['nw-nginx','certbot-renew'] }
];

// El compose raiz (`include`) funde los proyectos en uno: los contenedores
// viven bajo el proyecto `avance`. Por eso las ACCIONES se hacen con el compose
// raiz, no con el de cada stack (que crearia contenedores duplicados con el
// mismo nombre). La UIS es la excepcion: no esta en el compose raiz y usa el suyo.
const composeRaiz = path.resolve(root, 'docker-compose.yaml');

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
function publicProject(project, state, running, total, error, keycloak) {
  return { id:project.id, name:project.name, group:project.group, url:project.url, icon:project.icon, description:project.description, state, running, total, ...(keycloak ? {keycloak} : {}), ...(error ? {error} : {}) };
}

/**
 * Estado del Keycloak de un emisor y del Keycloak del otro.
 *
 * El proxy publico reescribe el Path de todas las cookies a "/", asi que dos
 * instancias de Keycloak en el mismo dominio comparten AUTH_SESSION_ID y
 * KC_RESTART: entrar en una consola invalida la sesion de la otra. El panel
 * avisa cuando las dos estan en pie a la vez.
 */
async function keycloakState(project) {
  if (!project.keycloakService) return null;
  const propio = await serviceRunning(project, project.keycloakService);
  const par = projects.find((item) => item.id === project.peerId);
  const parActivo = par ? await serviceRunning(par, par.keycloakService) : false;
  return {
    service: project.keycloakService,
    name: project.keycloakName,
    url: project.keycloakUrl,
    running: propio,
    peerId: project.peerId,
    peerName: project.peerName,
    peerRunning: parActivo,
    // Las dos a la vez es exactamente el estado que rompe la sesion.
    conflicto: propio && parActivo,
  };
}

async function serviceRunning(project, service) {
  try {
    // Por nombre de contenedor: el compose del stack ya no ve los contenedores
    // que levantó el compose raiz (los proyectos quedan fundidos en uno).
    const consulta = ['ps','--all','--format','json','--filter',`name=^/${service}$`];
    const containers = parseContainers(await run(consulta, project.directory, 15_000));
    return containers.some((container) => String(container.State || '').toLowerCase() === 'running');
  } catch {
    return false;
  }
}

/**
 * El estado de un stack, preguntando a Docker por el NOMBRE de sus contenedores.
 *
 * POR QUÉ NO POR `docker compose ps`
 *
 * El compose raiz (`include`) funde los proyectos en uno: los contenedores pasan
 * a estar bajo el proyecto de la raiz, y el `ps` del compose de cada stack deja
 * de verlos. Preguntar por nombre de contenedor es independiente de quien lo
 * haya levantado: funciona igual bajo el proyecto de la raiz que bajo el del
 * stack.
 */
async function status(project) {
  try {
    const nombres = project.containers || [];
    const consulta = ['ps','--all','--format','json'];
    for (const nombre of nombres) consulta.push('--filter', `name=^/${nombre}$`);
    const salida = await run(consulta, project.directory, 15_000);
    const containers = parseContainers(salida).filter((c) => nombres.includes(c.Names || c.Name || ''));
    const running = containers.filter((container) => String(container.State || '').toLowerCase() === 'running').length;
    const state = running === 0 ? 'stopped' : running === containers.length ? 'running' : 'partial';
    return publicProject(project, state, running, containers.length, null, await keycloakState(project));
  } catch (error) {
    const unavailable = /cannot connect|daemon|is the docker daemon running|permission denied/i.test(error.message);
    return publicProject(project, unavailable ? 'unavailable' : 'stopped', 0, 0, error.message, await keycloakState(project));
  }
}
/**
 * El compose con el que se actúa sobre un proyecto.
 *
 * El compose raiz (`include`) funde los proyectos en uno solo: los contenedores
 * viven bajo el proyecto `avance`. Si se usara el compose de cada stack se
 * crearían contenedores duplicados con el mismo nombre. La UIS es la excepción:
 * no esta en el compose raiz y usa el suyo.
 */
function composeDe(project) {
  return project.id === 'issuer-uis'
    ? [path.resolve(project.directory, project.compose)]
    : [composeRaiz];
}

/**
 * Crea las redes externas que falten.
 *
 * Los composes declaran sus redes como `external: true` (para que `down` no las
 * borre y para que los stacks no compartan red), así que Compose NO las crea:
 * si falta alguna, los contenedores no arrancan. Se leen de los propios
 * ficheros de compose, para no mantener una lista escrita a mano que se queda
 * vieja.
 */
async function asegurarRedes(composeFiles, cwd, opciones = []) {
  const config = JSON.parse(await run(composeArgs({composeFiles}, [...opciones, 'config','--format','json']), cwd, 60_000));
  const faltan = [];
  for (const [clave, red] of Object.entries(config.networks || {})) {
    if (!red.external) continue;
    const nombre = red.name || clave;
    const existe = await run(['network','inspect',nombre], cwd, 10_000).then(() => true, () => false);
    if (!existe) faltan.push(nombre);
  }
  for (const nombre of faltan) {
    await run(['network','create',nombre], cwd, 30_000);
  }
  return faltan;
}

/**
 * ACCIÓN GLOBAL: todo el ecosistema de una vez.
 *
 * `up` levanta los diez stacks: los nueve del compose raiz y el issuer de la
 * UIS, que va con su propio compose.
 *
 * - Primero se intenta una sola llamada para todos los stacks del compose raiz:
 *   es lo rápido y Compose resuelve las dependencias entre ellos. Si esa
 *   llamada falla (una imagen que no compila, un volumen con permisos raros),
 *   se reintenta proyecto por proyecto, para que un stack roto no se lleve por
 *   delante a los demás.
 *
 * - `down` va proyecto por proyecto quitando solo sus contenedores (`rm -f -s`,
 *   sin `-v`: los volúmenes se conservan) y deja en pie el panel, que es quien
 *   está ejecutando la operación.
 */
/**
 * Levanta, detiene o reinicia una aplicación de verifiers/ (sus `stacks`, en orden).
 * `down` los recorre al revés: primero la app y luego su verifier. Sin tocar volúmenes.
 */
async function accionStacks(project, action) {
  const stacks = action === 'down' ? [...project.stacks].reverse() : project.stacks;
  for (const stack of stacks) {
    const cwd = path.resolve(root, stack.dir);
    const env = path.resolve(cwd, stack.env);
    try {
      await access(env);
    } catch {
      throw new Error('Falta ' + path.relative(root, env) + ': se crea la primera vez con ' + (project.levantar || 'verifiers/' + project.id.slice(9) + '/levantar.sh') + '.');
    }
    const base = ['compose', '-p', stack.project, '--env-file', env, '-f', path.resolve(cwd, stack.file)];
    if (action === 'up') {
      await asegurarRedes([path.resolve(cwd, stack.file)], cwd, ['-p', stack.project, '--env-file', env]);
      await run([...base, 'up', '-d'], cwd, 10 * 60_000);
    } else if (action === 'down') {
      await run([...base, 'rm', '-f', '-s'], cwd, 10 * 60_000);
    } else {
      await run([...base, 'restart'], cwd, 10 * 60_000);
    }
  }
}

async function accionGlobal(action) {
  const resultados = [];
  const delRaiz = projects.filter((project) => project.id !== 'issuer-uis' && !project.stacks);
  const verifiers = projects.filter((project) => project.stacks);
  const uis = projects.find((project) => project.id === 'issuer-uis');

  if (action === 'up') {
    // Las redes externas: sin ellas no arranca nada.
    await asegurarRedes([composeRaiz], root);
    const servicios = delRaiz.flatMap((project) => project.services || []);
    try {
      await run(composeArgs({composeFiles:[composeRaiz]}, ['up','-d', ...servicios]), root, 20 * 60_000);
    } catch (error) {
      // Un stack roto no debe dejar abajo los demás: se reintenta uno a uno.
      for (const project of delRaiz) {
        try {
          await run(composeArgs({composeFiles:[composeRaiz]}, ['up','-d', ...(project.services || [])]), project.directory, 10 * 60_000);
        } catch (fallo) {
          resultados.push({id:project.id, name:project.name, error:fallo.message});
        }
      }
    }
    if (uis) {
      try {
        await asegurarRedes(composeDe(uis), uis.directory);
        await run(composeArgs({composeFiles:composeDe(uis)}, ['up','-d', ...(uis.services || [])]), uis.directory, 15 * 60_000);
      } catch (error) {
        resultados.push({id:uis.id, name:uis.name, error:error.message});
      }
    }
    for (const project of verifiers) {
      try { await accionStacks(project, 'up'); }
      catch (error) { resultados.push({id:project.id, name:project.name, error:error.message}); }
    }
  } else {
    // Al bajar, el proxy se queda en pie: es por donde se entra al panel, y si
    // cae, la orden se pierde a medio hacer (la respuesta nunca llega al
    // navegador). Se para todo lo demas; el proxy devuelve 502 en lo que este
    // caido, que es justo lo que se quiere ver.
    const todos = (uis ? [...delRaiz, uis] : delRaiz).filter((project) => !project.alwaysUp);
    for (const project of verifiers) {
      try { await accionStacks(project, action); }
      catch (error) { resultados.push({id:project.id, name:project.name, error:error.message}); }
    }
    for (const project of todos) {
      const servicios = project.services || [];
      const args = action === 'down' ? ['rm','-f','-s', ...servicios] : ['restart', ...servicios];
      try {
        await run(composeArgs({composeFiles:composeDe(project)}, args), project.directory, 10 * 60_000);
      } catch (error) {
        resultados.push({id:project.id, name:project.name, error:error.message});
      }
    }
  }

  // Lo que quedó en pie, proyecto por proyecto.
  const fallos = new Map(resultados.map((item) => [item.id, item]));
  const estados = await Promise.all(projects.map(status));
  const results = estados.map((estado) => {
    const fallo = fallos.get(estado.id);
    return {id:estado.id, name:estado.name, state:estado.state, running:estado.running, total:estado.total, ok:!fallo, ...(fallo ? {error:fallo.error} : {})};
  });
  return {action, results, ok:results.every((item) => item.ok)};
}

/**
 * RECURSOS: todo lo que Docker tiene del ecosistema, en una sola foto.
 *
 * Es el `docker ps` mejorado de la vista "Recursos": contenedores (con su tarjeta del panel, host, puertos,
 * tiempo de actividad y salud), redes y volúmenes. Se pregunta por `docker inspect` de todos los ids de una vez.
 *
 * Los cambios llegan por `docker events`: el servidor lo escucha una sola vez, espera 400 ms a que se calme la
 * ráfaga (un `up` genera decenas de eventos) y manda la foto nueva a cada navegador abierto.
 */
const tarjetaDe = new Map(entries.flatMap((item) => (item.containers || []).map((nombre) => [nombre, item])));
tarjetaDe.set('avance-control-panel', { id:'panel-control', name:'Panel de control', group:'Panel', url:'/' });

function puertos(contenedor) {
  const publicados = [];
  const enlazados = contenedor.HostConfig?.PortBindings || {};
  for (const [clave, enlaces] of Object.entries(enlazados)) {
    const [interno, protocolo] = clave.split('/');
    for (const enlace of enlaces || []) {
      const ip = enlace.HostIp && enlace.HostIp !== '0.0.0.0' && enlace.HostIp !== '::' ? enlace.HostIp : '';
      publicados.push({ ip, host:enlace.HostPort || '', interno, protocolo:protocolo || 'tcp' });
    }
  }
  const publicadosInternos = new Set(publicados.map((p) => `${p.interno}/${p.protocolo}`));
  const expuestos = Object.keys(contenedor.Config?.ExposedPorts || contenedor.NetworkSettings?.Ports || {});
  const internos = [...new Set(expuestos.filter((p) => !publicadosInternos.has(p)).map((p) => p.replace(/\/tcp$/, '')))];
  const dedup = [...new Map(publicados.map((p) => [`${p.ip}|${p.host}|${p.interno}|${p.protocolo}`, p])).values()];
  return { publicados:dedup, internos };
}

const MOTORES = [[/postgres/i, 'PostgreSQL', 5432], [/mysql/i, 'MySQL', 3306], [/mariadb/i, 'MariaDB', 3306], [/mongo/i, 'MongoDB', 27017], [/redis/i, 'Redis', 6379]];
/** Si el contenedor es una base de datos: motor, base y usuario (nunca la contraseña). */
function datosBase(contenedor, publicados) {
  const imagen = contenedor.Config?.Image || '';
  const motor = MOTORES.find(([patron]) => patron.test(imagen.split('/').pop()));
  if (!motor) return null;
  const entorno = Object.fromEntries((contenedor.Config?.Env || []).map((linea) => { const k = linea.indexOf('='); return [linea.slice(0, k), linea.slice(k + 1)]; }));
  const base = entorno.POSTGRES_DB || entorno.MYSQL_DATABASE || entorno.MONGO_INITDB_DATABASE || '';
  const usuario = entorno.POSTGRES_USER || entorno.MYSQL_USER || entorno.MONGO_INITDB_ROOT_USERNAME || '';
  const interno = String(motor[2]);
  const publicado = publicados.find((p) => p.interno === interno);
  const esquema = motor[1] === 'PostgreSQL' ? 'postgresql' : motor[1] === 'MySQL' ? 'mysql' : motor[1] === 'MariaDB' ? 'mariadb' : '';
  return {
    motor:motor[1], base, usuario, puertoInterno:interno, puertoLocal:publicado?.host || '', ipLocal:publicado ? (publicado.ip || '127.0.0.1') : '',
    jdbc:publicado && esquema ? `jdbc:${esquema}://${publicado.ip || '127.0.0.1'}:${publicado.host}/${base}` : '',
  };
}

/** A qué parte del ecosistema pertenece: Issuer, Verifier, Portal, Base de datos, Wallet… */
function tipoDe(nombre, tarjeta, base) {
  if (base) return 'Base de datos';
  const id = tarjeta?.id || '';
  if (id.startsWith('issuer-')) return 'Issuer';
  if (id === 'wallet-provider' || id === 'app-new-wallet') return 'Wallet';
  if (id === 'onboarding') return 'Onboarding';
  if (id === 'trust-validator' || id === 'tl-publisher' || id === 'andes-scd') return 'Confianza';
  if (id === 'proxy-nginx') return 'Gateway';
  if (id === 'panel-control') return 'Panel';
  if (id.startsWith('verifier-')) return nombre.startsWith('verifier-') ? 'Verifier' : 'Portal';
  if (nombre.includes('verifier')) return 'Verifier';
  return 'Otro';
}


/**
 * Enlaces de cada contenedor, para la última columna de «Recursos».
 *
 * Son rutas del proxy único (relativas: se abren en el mismo origen desde el que se abre el panel). Solo se
 * listan páginas que responden. Lo que no tiene página propia (una base de datos, una lista de estado) cae al
 * enlace del proyecto al que pertenece.
 */
const L = (texto, url) => ({ texto, url });
const ENLACES_FIJOS = {
  'haproxy-reg': [L('Emisor PID', '/pid-registraduria/'), L('Metadatos', '/pid-registraduria/.well-known/openid-credential-issuer')],
  'keycloak-reg': [L('Consola Keycloak', '/idp-reg/admin/master/console/')],
  'haproxy-uis': [L('Emisor UIS', '/uis-issuer/')],
  'keycloak-uis': [L('Consola Keycloak', '/idp-uis/admin/master/console/')],
  'spartans-wallet-provider': [L('Wallet Provider', '/wallet-provider/'), L('JWKS', '/jwks'), L('Metadatos', '/.well-known/oauth-protected-resource')],
  'onboarding-backend': [L('Onboarding', '/onboarding/')],
  'trust-validator': [L('Salud', '/trust-validator/actuator/health')],
  'tl-publisher': [L('Listas publicadas', '/tl-publisher/tl-api/v1/lists')],
  'nw-nginx': [L('Inicio', '/')],
  'avance-control-panel': [L('Panel', '/'), L('Recursos', '/recursos')],
};
const CON_SALUD = new Set(['banco', 'contratacion', 'discoteca', 'notaria', 'eps', 'aerolinea', 'acceso', 'beca', 'pensiones', 'cancilleria']);
const ENLACES_EXTRA = { eps: [L('Administración', '/eps/admin'), L('Portal médico', '/eps/medico')] };

function enlacesDe(nombre, servicio, stack, tarjeta) {
  if (ENLACES_FIJOS[nombre]) return ENLACES_FIJOS[nombre];
  if (tarjeta?.stacks?.length) {
    const verifier = tarjeta.stacks[0], aplicacion = tarjeta.stacks[tarjeta.stacks.length - 1];
    const instancia = verifier.project.replace(/^verifier-/, '');
    if (stack === verifier.project) {
      if (/haproxy|verifier-web/.test(servicio)) return [L('Verifier (interfaz)', `/verifier-${instancia}/`)];
      if (/verifier-api/.test(servicio)) return [L('Salud del verifier', `/verifier-${instancia}/actuator/health`)];
    } else if (stack === aplicacion.project) {
      return [L('Portal', tarjeta.url), ...(CON_SALUD.has(aplicacion.project) ? [L('Salud', tarjeta.url + 'salud')] : []), ...(ENLACES_EXTRA[aplicacion.project] || [])];
    }
  }
  if (tarjeta?.url && tarjeta.url !== '/') return [L('Proyecto', tarjeta.url)];
  return [];
}

async function recursos() {
  const ids = (await run(['ps','-a','-q','--no-trunc'], root, 15_000)).split('\n').filter(Boolean);
  const inspeccionados = ids.length ? JSON.parse(await run(['inspect', ...ids], root, 30_000)) : [];
  const contenedores = inspeccionados.map((c) => {
    const nombre = c.Name.replace(/^\//, '');
    const etiquetas = c.Config?.Labels || {};
    const tarjeta = tarjetaDe.get(nombre);
    const redes = Object.entries(c.NetworkSettings?.Networks || {}).map(([red, datos]) => ({
      red, ip: datos.IPAddress || '', alias: (datos.Aliases || []).filter((a) => !c.Id.startsWith(a) && a !== nombre),
    }));
    const compartida = redes.find((r) => r.red === 'avance-eudi');
    const hosts = [...new Set([...(compartida?.alias || []), ...redes.flatMap((r) => r.alias)])];
    const { publicados, internos } = puertos(c);
    const base = datosBase(c, publicados);
    return {
      nombre, id:c.Id.slice(0, 12), imagen:c.Config?.Image || '',
      enlaces:enlacesDe(nombre, etiquetas['com.docker.compose.service'] || '', etiquetas['com.docker.compose.project'] || '', tarjeta),
      tipo:tipoDe(nombre, tarjeta, base), proyecto:tarjeta?.name || etiquetas['com.docker.compose.project'] || nombre, base,
      estado:c.State.Status, salud:c.State.Health?.Status || '', reinicios:c.RestartCount || 0, codigo:c.State.ExitCode,
      inicio:c.State.StartedAt, fin:c.State.FinishedAt, creado:c.Created,
      host:hosts[0] || nombre, hosts, redes,
      publicados, internos,
      stack:etiquetas['com.docker.compose.project'] || '',
      servicio:etiquetas['com.docker.compose.service'] || '',
      tarjeta:tarjeta ? { id:tarjeta.id, nombre:tarjeta.name, grupo:tarjeta.group, url:tarjeta.url || '' } : null,
      volumenes:(c.Mounts || []).filter((m) => m.Type === 'volume').map((m) => m.Name),
    };
  }).sort((a, b) => (a.tarjeta?.grupo || 'zz').localeCompare(b.tarjeta?.grupo || 'zz') || (a.tarjeta?.nombre || a.nombre).localeCompare(b.tarjeta?.nombre || b.nombre) || a.nombre.localeCompare(b.nombre));

  const idsRedes = (await run(['network','ls','-q'], root, 15_000)).split('\n').filter(Boolean);
  const redes = (idsRedes.length ? JSON.parse(await run(['network','inspect', ...idsRedes], root, 30_000)) : []).map((r) => ({
    nombre:r.Name, controlador:r.Driver, ambito:r.Scope, subred:r.IPAM?.Config?.[0]?.Subnet || '',
    contenedores:Object.values(r.Containers || {}).map((c) => c.Name).sort(), externa:!r.Labels?.['com.docker.compose.network'],
  })).sort((a, b) => b.contenedores.length - a.contenedores.length || a.nombre.localeCompare(b.nombre));

  const nombresVolumenes = (await run(['volume','ls','-q'], root, 15_000)).split('\n').filter(Boolean);
  const volumenes = nombresVolumenes.map((nombre) => ({ nombre, usadoPor:contenedores.filter((c) => c.volumenes.includes(nombre)).map((c) => c.nombre) }))
    .sort((a, b) => b.usadoPor.length - a.usadoPor.length || a.nombre.localeCompare(b.nombre));

  return { ahora:new Date().toISOString(), contenedores, redes, volumenes };
}

const oyentes = new Set();
let ultimaFoto = null, escuchando = false, pendiente = null;
async function difundir() {
  try { ultimaFoto = JSON.stringify(await recursos()); }
  catch (error) { ultimaFoto = JSON.stringify({ error:error.message, ahora:new Date().toISOString() }); }
  for (const res of oyentes) res.write(`data: ${ultimaFoto}\n\n`);
}
function programar() { clearTimeout(pendiente); pendiente = setTimeout(difundir, 400); }
function escucharDocker() {
  if (escuchando) return;
  escuchando = true;
  const hijo = spawn('docker', ['events','--format','{{json .}}','--filter','type=container','--filter','type=network','--filter','type=volume'], { stdio:['ignore','pipe','ignore'] });
  setInterval(programar, 60_000); // red de seguridad: si se pierde un evento, la foto se renueva sola
  const relevantes = /^(create|start|stop|die|destroy|kill|pause|unpause|rename|restart|oom|connect|disconnect|remove|health_status)/;
  let resto = '';
  hijo.stdout.on('data', (datos) => {
    resto += datos;
    const lineas = resto.split('\n'); resto = lineas.pop();
    for (const linea of lineas) { try { if (relevantes.test(JSON.parse(linea).Action || '')) programar(); } catch { /* línea parcial */ } }
  });
  const reintentar = () => { escuchando = false; setTimeout(() => oyentes.size && escucharDocker(), 3000); };
  hijo.on('close', reintentar); hijo.on('error', reintentar);
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
    if (pathname === '/api/recursos' && req.method === 'GET') {
      try { return send(res, 200, await recursos()); } catch (error) { return send(res, 500, {error:error.message}); }
    }
    // Canal en vivo (text/event-stream): una foto al abrir, otra por cada cambio de Docker y un latido cada 15 s.
    if (pathname === '/api/recursos/stream' && req.method === 'GET') {
      res.writeHead(200, {'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no','connection':'keep-alive','x-content-type-options':'nosniff'});
      oyentes.add(res);
      escucharDocker();
      if (!ultimaFoto) await difundir(); else res.write(`data: ${ultimaFoto}\n\n`);
      const latido = setInterval(() => res.write(': latido\n\n'), 15_000);
      req.on('close', () => { clearInterval(latido); oyentes.delete(res); });
      return;
    }
    // Un solo comando para todo el ecosistema.
    if (pathname === '/api/all/action' && req.method === 'POST') {
      try {
        const {action} = await readBody(req);
        if (!['up','down','restart'].includes(action)) return send(res, 400, {error:'Acción no permitida.'});
        return send(res, 200, await accionGlobal(action));
      } catch (error) {
        return send(res, 500, {error:error.message});
      }
    }
    const parts = pathname.split('/');
    const isAction = parts.length === 5 && parts[1] === 'api' && parts[2] === 'projects' && parts[4] === 'action';
    if (isAction && req.method === 'POST') {
      const project = projects.find((item) => item.id === parts[3]);
      if (!project) return send(res, 404, {error:'No se encontró ese proyecto.'});
      try {
        const {action} = await readBody(req);
        if (!['up','down','restart','activate'].includes(action)) return send(res, 400, {error:'Acción no permitida.'});
        if (action === 'activate') {
          if (!project.keycloakService) return send(res, 400, {error:'Este proyecto no tiene un Keycloak que activar.'});
          // 1) Se detiene el Keycloak del OTRO emisor. Es lo que evita que las dos
          //    consolas compartan sesion: el proxy publico deja el Path de las
          //    cookies en "/", asi que un AUTH_SESSION_ID compartido invalida la
          //    sesion del otro Keycloak en cuanto se entra en su consola.
          const par = projects.find((item) => item.id === project.peerId);
          if (par) {
            await run(composeArgs({ ...par, composeFiles: composeDe(par) }, ['stop', par.keycloakService]), par.directory, 5 * 60_000);
          }
          // 2) Se levanta el Keycloak de este emisor.
          await run(composeArgs({ ...project, composeFiles: composeDe(project) }, ['up','-d', project.keycloakService]), project.directory, 10 * 60_000);
          // 3) El navegador guarda la KC_RESTART de la sesion anterior. Como el
          //    proxy publico deja el Path de las cookies en "/", esa cookie sigue
          //    ahi despues del cambio y el Keycloak nuevo no la reconoce
          //    ("Restart login cookie not found"). El panel se sirve en el MISMO
          //    origen, asi que puede limpiarla: se le pide que borre las cookies
          //    de sesion de Keycloak antes de abrir la consola.
          const estado = await status(project);
          return send(res, 200, { ...estado, limpiarCookies: true });
        }
        if (project.stacks) {
          await accionStacks(project, action);
          return send(res, 200, await status(project));
        }
        const ficheros = composeDe(project);
        const servicios = project.services || [];
        let args;
        if (action === 'up') {
          args = ['up','-d', ...servicios];
        } else if (action === 'down') {
          // Parar y quitar los contenedores, SIN tocar los volumenes: es lo que
          // hacia `docker compose down` sin el `-v`.
          args = ['rm','-f','-s', ...servicios];
        } else {
          args = ['restart', ...servicios];
        }
        // Levantar un emisor NO apaga el Keycloak del otro: por defecto los dos
        // emisores quedan operativos y la app puede pedir PID y credencial
        // academica a la vez. El intercambio de consolas es una accion
        // explicita ("Activar consola"), porque apagar el Keycloak del otro deja
        // a ese emisor sin servidor de autorizacion.
        await run(composeArgs({ ...project, composeFiles: ficheros }, args), project.directory, 10 * 60_000);
        return send(res, 200, await status(project));
      } catch (error) {
        return send(res, 500, {error:error.message});
      }
    }
    return send(res, 404, {error:'Ruta no encontrada.'});
  }

  const relative = pathname === '/' ? 'index.html' : pathname === '/recursos' ? 'recursos.html' : decodeURIComponent(pathname.slice(1));
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
