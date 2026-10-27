const icons={wallet:'▣',shield:'⬡',badge:'◇',database:'▤',globe:'◎',bank:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8"/><path d="M3 20h18"/></svg>',briefcase:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18"/></svg>',nightlife:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',notary:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><circle cx="12.500" cy="15" r="2.500"/><path d="M11 17.300 10 21l2.500-1.300L15 21l-1-3.700"/></svg>',school:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11.500V16c0 1.500 3 3 6 3s6-1.500 6-3v-4.500"/><path d="M22 9v6"/></svg>','shield-check':'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.500-3.200 8-8 9-4.800-1-8-4.500-8-9V6z"/><path d="M8.500 12l2.500 2.500 4.500-5"/></svg>',plane:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12l20-9-6 19-5-8z"/><path d="M11 14 22 3"/></svg>',dumbbell:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/></svg>',health:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.6-9-9.2C1.8 8.2 3.9 5 7 5c2 0 3.4 1.1 5 3 1.6-1.9 3-3 5-3 3.1 0 5.2 3.200 4 6.800C19 16.400 12 21 12 21z"/><path d="M12 10v4M10 12h4"/></svg>'};
const colors={wallet:'',shield:'green',badge:'violet',database:'orange',bank:'blue',briefcase:'slate',nightlife:'pink',health:'teal',dumbbell:'orange',notary:'violet',school:'red',plane:'red','shield-check':'blue'};
let projects=[],busy=new Set(),toastTimer,accessToken=localStorage.getItem('avance-control-token')||'',globalBusy=false,globalAction=null;
const basePath='/';
const apiBase=basePath+'api/';
const $=s=>document.querySelector(s);
function toast(message,error=false){const el=$('#toast');el.textContent=message;el.className='toast show'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className='toast',3500);}
function label(state){return state==='running'?'Activo':state==='partial'?'Parcial':state==='unavailable'?'Docker sin conexión':'◉ Detenido';}
function conflicto(){const k=projects.filter(p=>p.keycloak&&p.keycloak.conflicto);return k.length?k[0]:null;}
function aviso(){
  const el=$('#aviso-keycloak');if(!el)return;const k=conflicto();
  if(!k){el.className='aviso';el.style.display='none';return;}
  el.style.display='flex';
  el.innerHTML='<span class="aviso-icono">ℹ</span><div><b>Las dos consolas de Keycloak están activas</b><br>'
    +'El proxy público deja el <code>Path</code> de todas las cookies en <code>/</code>, así que los dos Keycloak '
    +'comparten la sesión: si entras en una consola mientras usas la otra, se te cerrará. '
    +'Con <b>Activar consola</b> se deja una sola en pie (la otra consola no podrá usarse hasta que la vuelvas a activar).</div>';
}
function summary(){const active=projects.filter(p=>p.state==='running').length;$('#total-count').textContent=projects.length;$('#active-count').textContent=active;$('#stopped-count').textContent=projects.filter(p=>p.state==='stopped').length;$('#quick-count').textContent=projects.length;$('#side-count').textContent=projects.length;$('#updated-at').textContent=new Intl.DateTimeFormat('es-CO',{hour:'2-digit',minute:'2-digit'}).format(new Date());$('#project-nav').innerHTML=projects.map(p=>'<a class="nav-item" href="#project-'+p.id+'"><span class="mini-status '+p.state+'"></span>'+p.name+'</a>').join('');aviso();}
function render(){const q=$('#search').value.trim().toLocaleLowerCase('es'),f=$('#filter').value;const list=projects.filter(p=>(f==='all'||(f==='running'?p.state==='running':p.state==='stopped'))&&(p.name+' '+p.description+' '+p.group).toLocaleLowerCase('es').includes(q));$('#visible-count').textContent=list.length+' '+(list.length===1?'proyecto':'proyectos');if(!list.length){$('#cards').innerHTML='<div class="empty">No hay proyectos que coincidan con esta búsqueda.</div>';return;}const tarjeta=p=>{const canStop=p.state==='running'||p.state==='partial',isBusy=busy.has(p.id)||globalBusy;
const k=p.keycloak;
const kc=k?'<a class="open-link kc-link" href="'+k.url+'" target="_blank" rel="noreferrer"><span>🔑</span> '+k.name+'</a>'
  +'<button class="action-button kc-button" data-action="activate" title="Deja este Keycloak en pie y detiene el del otro emisor"'+(isBusy?' disabled':'')+'><span>⇄</span> Activar consola</button>'
  +(k.running?'<span class="kc-on">En pie</span>':'')+(k.conflicto?'<span class="kc-warn" title="El otro Keycloak tambien esta en pie: las consolas comparten sesion">comparten sesión</span>':''):'';
const act='<button class="action-button primary" data-action="up"'+(p.state==='running'||isBusy?' disabled':'')+'><span>▶</span> Levantar</button><button class="action-button" data-action="down"'+(!canStop||isBusy?' disabled':'')+'><span>■</span> Detener</button>';const meta=p.total?p.running+'/'+p.total+' contenedores activos':p.state==='unavailable'?'Inicia Docker para gestionar el stack':'Stack local disponible';
const abrir=p.url?'<a class="open-link" href="'+p.url+'" target="_blank" rel="noreferrer"><span>↗</span> Abrir proyecto</a>':'<span class="open-link muted"><span>·</span> Sin ruta publica</span>';
return '<article class="project-card '+p.state+'" id="project-'+p.id+'"><div class="card-top"><div class="project-icon '+(colors[p.icon]||'')+'">'+(icons[p.icon]||'◇')+'</div><div><div class="project-name">'+p.name+'</div><div class="project-description">'+p.description+'</div></div><span class="status-badge"><i class="status-light"></i>'+label(p.state)+'</span></div><div class="card-meta"><strong>'+p.group+'</strong> · '+meta+'</div>'+(kc?'<div class="card-keycloak">'+kc+'</div>':'')+'<div class="card-actions">'+abrir+act+'<button class="action-button" data-action="restart" title="Reiniciar stack"'+(isBusy?' disabled':'')+'><span>↻</span></button></div></article>';};$('#cards').innerHTML=seccionar(list,tarjeta);$('#cards').querySelectorAll('.project-card').forEach(card=>card.addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)operate(card.id.slice(8),b.dataset.action);}));}
function token(){if(!accessToken){accessToken=prompt('Ingresa el token de CONTROL_PANEL_TOKEN guardado en panel-control/.env')||'';if(accessToken)localStorage.setItem('avance-control-token',accessToken);}return accessToken;}
async function request(url,options={}){const response=await fetch(url,{...options,headers:{...(options.headers||{}),authorization:'Bearer '+token()}});if(response.status===401){accessToken='';localStorage.removeItem('avance-control-token');throw Error('Token incorrecto. Actualiza el estado para ingresarlo de nuevo.');}return response;}
async function refresh(){const b=$('#refresh');b.disabled=true;try{const r=await request(apiBase+'projects');if(!r.ok)throw Error('No fue posible consultar los proyectos.');projects=await r.json();summary();render();}catch(e){toast(e.message||'No hay conexión con el panel.',true);}finally{b.disabled=false;renderGlobal();}}
function limpiarCookiesKeycloak(){
  // El proxy publico deja el Path de las cookies en "/", asi que al cambiar de
  // Keycloak queda la KC_RESTART de la sesion anterior y el Keycloak nuevo no
  // la reconoce ("Restart login cookie not found"). El panel se sirve en el
  // mismo origen, asi que puede borrarlas.
  const cookies=['KC_RESTART','AUTH_SESSION_ID','KC_AUTH_SESSION_HASH','KEYCLOAK_IDENTITY','KEYCLOAK_3P_COOKIE','KEYCLOAK_3P_COOKIE_SAMESITE'];
  const paths=['/','/idp-reg','/idp-uis','/idp-reg/realms/master','/idp-uis/realms/master'];
  cookies.forEach(c=>paths.forEach(p=>{document.cookie=c+'=; Max-Age=0; path='+p;}));
}
async function operate(id,action){const p=projects.find(x=>x.id===id);if(!p||busy.has(id))return;
if(action==='down'&&!confirm('¿Detener todos los servicios de '+p.name+'?'))return;
if(action==='activate'&&!confirm('¿Dejar en pie el Keycloak de '+p.name+' y detener el del otro emisor?\n\nLas dos consolas comparten sesión: por eso no pueden estar las dos activas.'))return;
busy.add(id);render();
toast((action==='up'?'Levantando':action==='down'?'Deteniendo':action==='activate'?'Activando consola de':'Reiniciando')+' '+p.name+'…');
try{const r=await request(apiBase+'projects/'+id+'/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});const result=await r.json();if(!r.ok)throw Error(result.error||'La operación falló.');
if(result.limpiarCookies)limpiarCookiesKeycloak();
projects=projects.map(x=>x.id===id?result:x);summary();toast(p.name+' · '+(action==='activate'?'consola activada':label(result.state)));
if(action==='activate'&&p.keycloak)window.open(p.keycloak.url,'_blank');}catch(e){toast(e.message||'No se pudo ejecutar la operación.',true);}finally{busy.delete(id);render();}}
// ── Acción global: todo el ecosistema de una vez ───────────────────────────
// Un solo comando levanta (o baja) los diez stacks: los nueve del compose raíz
// y el issuer de la UIS, que va con su propio compose. En un "Detener todo" el
// panel se queda en pie: el que ejecuta la orden es el propio panel.
function renderGlobal(){const s=$('#start-all'),d=$('#stop-all');
 if(s){s.disabled=globalBusy||globalAction==='down';s.innerHTML=globalAction==='up'?'<span>◌</span> Levantando…':'<span>▶</span> Levantar todo';}
 if(d){d.disabled=globalBusy||globalAction==='up';d.innerHTML=globalAction==='down'?'<span>◌</span> Deteniendo…':'<span>■</span> Detener todo';}}
async function accionGlobal(action){
 if(globalBusy)return;
 if(action==='down'&&!confirm('¿Detener TODOS los stacks del ecosistema?\n\nEl panel sigue en pie para poder volver a levantarlos. Los volúmenes no se tocan.'))return;
 globalBusy=true;globalAction=action;render();renderGlobal();
 toast(action==='up'?'Levantando todo el ecosistema…':'Deteniendo todo el ecosistema…');
 try{
  const r=await request(apiBase+'all/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
  const result=await r.json();
  if(!r.ok)throw Error(result.error||'La operación falló.');
  const fallos=(result.results||[]).filter(x=>!x.ok);
  projects=await (await request(apiBase+'projects')).json();
  summary();render();
  if(fallos.length)toast(fallos.length+' stack(s) con problema: '+fallos.map(f=>f.name).join(', '),true);
  else toast(action==='up'?'Ecosistema completo en pie ('+(result.results||[]).length+' stacks)':'Ecosistema detenido');
 }catch(e){toast(e.message||'No se pudo ejecutar la operación.',true);}
 finally{globalBusy=false;globalAction=null;render();renderGlobal();}}
$('#search').addEventListener('input',render);$('#filter').addEventListener('change',render);$('#refresh').addEventListener('click',refresh);$('#start-all').addEventListener('click',()=>accionGlobal('up'));$('#stop-all').addEventListener('click',()=>accionGlobal('down'));$('#today').textContent=new Intl.DateTimeFormat('es-CO',{weekday:'short',day:'numeric',month:'short'}).format(new Date());refresh();setInterval(refresh,15000);

// --- Secciones de los accesos rápidos -------------------------------------------------------------
// Cada proyecto cae en una sección por su id; lo que no figure aquí va a "Infraestructura".
const SECCIONES=[
 {id:'confianza',titulo:'Confianza',desc:'La base: listas de confianza firmadas con la PKI del ecosistema, un validador que las consulta y el prestador de firma remota.',ids:['tl-publisher','trust-validator','andes-scd']},
 {id:'wallet',titulo:'Wallet',desc:'La app del ciudadano y los servicios que certifican que cada instalación y su clave son legítimas.',ids:['wallet-provider','app-new-wallet','onboarding']},
 {id:'emisores',titulo:'Emisores',desc:'Quienes entregan documentos (PID y atestaciones) a la wallet por OpenID4VCI. Varios también verifican.',ids:['issuer-registraduria','issuer-uis','verifier-eps','verifier-notaria','verifier-gym','verifier-aerolinea','verifier-cancilleria']},
 {id:'verificacion',titulo:'Verificación',desc:'Quienes piden datos a la wallet por OpenID4VP (QR o enlace) y validan firma, emisor y estado.',prefijo:'verifier-'},
 {id:'infra',titulo:'Infraestructura',desc:'El proxy que publica todo el ecosistema bajo un solo dominio.'}];
function seccionDe(p){return (SECCIONES.find(s=>s.ids&&s.ids.includes(p.id))||SECCIONES.find(s=>s.prefijo&&p.id.startsWith(s.prefijo))||SECCIONES[SECCIONES.length-1]).id;}
function seccionar(list,tarjeta){
 return SECCIONES.map(s=>{const items=list.filter(p=>seccionDe(p)===s.id);if(!items.length)return '';
  const activos=items.filter(p=>p.state==='running').length;
  return '<section class="seccion s-'+s.id+'"><div class="seccion-cab"><h3><i></i>'+s.titulo+'<span class="seccion-cuenta">'+activos+'/'+items.length+' activos</span></h3><p>'+s.desc+'</p></div><div class="cards">'+items.map(tarjeta).join('')+'</div></section>';}).join('');
}

// --- Descarga de la wallet (APK + QR) --------------------------------------------------------------
async function cargarApk(){
 try{
  const r=await fetch('/descargas/apk.json');if(!r.ok)throw Error();const a=await r.json();
  $('#apk-archivo').textContent=a.archivo;
  $('#apk-tamano').textContent=(a.tamano/1048576).toFixed(1).replace('.',',')+' MB';
  $('#apk-subido').textContent=new Intl.DateTimeFormat('es-CO',{dateStyle:'medium',timeStyle:'short'}).format(new Date(a.subido));
  $('#apk-sha').textContent=a.sha256.slice(0,16)+'…';$('#apk-sha').title=a.sha256;
  $('#apk-boton').innerHTML='<span>⭳</span> Descargar APK ('+(a.tamano/1048576).toFixed(1).replace('.',',')+' MB)';
 }catch{$('#apk-archivo').textContent='Todavía no hay un APK compilado';$('#apk-boton').classList.add('desactivado');$('#apk-qr').style.opacity='.25';}
}

// --- Esquema de confianza: quién está registrado en cada lista -------------------------------------
const LISTAS=[['WP','Wallet providers'],['PID','Emisores de PID'],['QEAA','Emisores QEAA'],['PUBEAA','Emisores públicos (Pub-EAA)'],['RPREG','Registro de verifiers']];
const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function cargaUtil(jwt){const p=jwt.trim().split('.')[1].replace(/-/g,'+').replace(/_/g,'/');return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p),c=>c.charCodeAt(0))));}
async function cargarRegistro(){
 const cajas=await Promise.all(LISTAS.map(async([sigla,titulo])=>{
  try{
   const r=await fetch('/tl-publisher/TL/'+sigla+'/current.json');if(!r.ok)throw Error();
   const d=cargaUtil(await r.text());const nombres=(d.services||[]).map(s=>(s.service_name&&s.service_name[0]&&s.service_name[0].text)||'(sin nombre)').map(n=>n.replace(/\s*\((?:CN|O)=.*\)$/,''));
   return '<div class="reg-caja"><div class="reg-cab"><b>'+sigla+'</b><span>'+nombres.length+' '+(nombres.length===1?'servicio':'servicios')+'</span></div><small>'+titulo+'</small><ul>'+(nombres.map(n=>'<li>'+esc(n)+'</li>').join('')||'<li class="vacio">Sin servicios</li>')+'</ul></div>';
  }catch{return '<div class="reg-caja"><div class="reg-cab"><b>'+sigla+'</b><span>sin datos</span></div><small>'+titulo+'</small><ul><li class="vacio">No se pudo leer la lista</li></ul></div>';}
 }));
 $('#registro').innerHTML=cajas.join('');
}
cargarApk();cargarRegistro();setInterval(cargarRegistro,60000);
