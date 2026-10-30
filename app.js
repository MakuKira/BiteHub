const GUEST_ORDER_STORAGE_KEY='bitehub-guest-order-access-v1';
function savedGuestOrderAccess(){
  try{
    const records=JSON.parse(localStorage.getItem(GUEST_ORDER_STORAGE_KEY)||'[]');
    return Array.isArray(records)?records.filter(item=>Number.isSafeInteger(item?.id)&&item.id>0&&typeof item.token==='string'&&/^[A-Za-z0-9_-]{40,100}$/.test(item.token)).slice(-12):[];
  }catch{return[]}
}
const hasSavedGuestOrders=savedGuestOrderAccess().length>0;
let guestOrderAccess=savedGuestOrderAccess();
const state={user:null,publicBrowse:new URLSearchParams(location.search).has('stall')||hasSavedGuestOrders,products:[],featuredProducts:[],heroFeaturedIndex:0,featuredScroll:0,featuredPaused:false,featuredTimer:null,orders:[],overview:null,adminReports:null,reportRange:'30',reachAnalytics:null,paused:false,cart:new Map(),cartNote:'',guestName:'',guestSessionId:null,guestSchoolRole:'',guestGrade:'',guestSection:'',fulfillment:'pickup',deliveryLocation:null,mapZoom:1,trackingWatch:null,lastLocationSent:0,runnerLinks:{},filter:'All',query:'',sort:'featured',stallFilter:'All',dietaryFilter:'All',allergenFilter:'All',filterPanelOpen:false,buyerView:'menu',ownerView:'dashboard',adminView:'overview',authRole:'buyer',pushEnabled:false,pushAvailable:false,sidebarOpen:false,sidebarSettingsOpen:false,sidebarProfileOpen:false};
const $=s=>document.querySelector(s), root=$('#view-content'), toastNode=$('#toast'), openingSplash=$('#opening-splash'), openingSplashStartedAt=performance.now();
function dismissOpeningSplash(){
  if(!openingSplash?.isConnected)return;
  openingSplash.classList.add('is-exiting');
  setTimeout(()=>openingSplash.remove(),460);
}
let slowLoadCount=0,slowLoadTimer=null;
function beginSlowLoadFeedback(){
  slowLoadCount++;
  if(slowLoadCount===1)slowLoadTimer=setTimeout(()=>{
    if(!slowLoadCount)return;
    const skeleton=$('#slow-load-skeleton');
    if(skeleton){skeleton.hidden=false;skeleton.setAttribute('aria-hidden','false')}
    document.querySelector('#app')?.classList.add('is-slow-loading');
    dismissOpeningSplash();
  },600);
  let finished=false;
  return()=>{
    if(finished)return;
    finished=true;
    slowLoadCount=Math.max(0,slowLoadCount-1);
    if(slowLoadCount)return;
    clearTimeout(slowLoadTimer);slowLoadTimer=null;
    const skeleton=$('#slow-load-skeleton');
    if(skeleton){skeleton.hidden=true;skeleton.setAttribute('aria-hidden','true')}
    document.querySelector('#app')?.classList.remove('is-slow-loading');
  };
}
let refreshTimer;
let publicRunnerTracking=null,runnerShareTimer=null,runnerShareBusy=false;
let orderBaselineUserId=null;
let refreshInFlight=false;
let googleMapsPromise=null;
const googleCampusMaps=new WeakMap();
let lastMenuRefresh=0,lastOverviewRefresh=0,lastReachRefresh=0,lastReportsRefresh=0;
const money=n=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2}).format(n||0);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roleLabel={buyer:'School customer',owner:'Stall owner',runner:'School runner',admin:'Administrator'};
let themeMode='light';
try{themeMode=localStorage.getItem('bitehub-theme')==='dark'?'dark':'light'}catch{}
function applyTheme(){
  document.documentElement.dataset.theme=themeMode;
  const toggle=$('#theme-toggle'),status=$('#theme-status');
  if(toggle)toggle.setAttribute('aria-checked',String(themeMode==='dark'));
  if(status)status.textContent=themeMode==='dark'?'On':'Off';
}
applyTheme();
const statusLabel={placed:'New order',confirmed:'Accepted',preparing:'Preparing',ready:'Ready',out:'On the way',completed:'Completed',declined:'Declined'};
const dietaryLabels={vegetarian:'Vegetarian',vegan:'Vegan',halal:'Halal','gluten-free':'Gluten-free','dairy-free':'Dairy-free','nut-free':'Nut-free'};
const allergenLabels={peanuts:'Peanuts','tree-nuts':'Tree nuts',milk:'Milk',eggs:'Eggs',soy:'Soy',wheat:'Wheat',fish:'Fish',shellfish:'Shellfish',sesame:'Sesame'};
const dietaryOptions=Object.entries(dietaryLabels), allergenOptions=Object.entries(allergenLabels);
let toastTimer;
const campusMusicTracks=['bawat piyesa.mp3','life time.mp3','pahina.mp3','Panaginip.mp3'];
const campusMusicAudio=new Audio();
campusMusicAudio.preload='none';
let campusMusicQueue=[],campusMusicIndex=0,campusMusicEnabled=false,campusLastTrack='';
function shuffleCampusMusic(){
  campusMusicQueue=[...campusMusicTracks];
  for(let i=campusMusicQueue.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[campusMusicQueue[i],campusMusicQueue[j]]=[campusMusicQueue[j],campusMusicQueue[i]]}
  if(campusMusicQueue.length>1&&campusMusicQueue[0]===campusLastTrack)[campusMusicQueue[0],campusMusicQueue[1]]=[campusMusicQueue[1],campusMusicQueue[0]];
  campusMusicIndex=0;
}
async function playCampusMusic(){
  if(!campusMusicEnabled)return;
  if(campusMusicIndex>=campusMusicQueue.length)shuffleCampusMusic();
  const track=campusMusicQueue[campusMusicIndex++];campusLastTrack=track;
  campusMusicAudio.src=`background%20music%20assets/${encodeURIComponent(track)}`;
  $('#music-track').textContent=track.replace(/\.mp3$/i,'');
  try{await campusMusicAudio.play()}catch{$('#music-track').textContent='Tap Play to allow music';campusMusicEnabled=false;$('#music-toggle').setAttribute('aria-pressed','false');$('#music-toggle').setAttribute('aria-label','Play soft background music');$('#music-label').textContent='Play soft music'}
}
campusMusicAudio.volume=.08;
campusMusicAudio.addEventListener('ended',playCampusMusic);
$('#music-volume').addEventListener('input',e=>{campusMusicAudio.volume=Number(e.target.value)/100});
$('#music-toggle').addEventListener('click',async()=>{
  campusMusicEnabled=!campusMusicEnabled;
  $('#music-toggle').setAttribute('aria-pressed',String(campusMusicEnabled));
  $('#music-toggle').setAttribute('aria-label',campusMusicEnabled?'Pause soft background music':'Play soft background music');
  $('#music-label').textContent=campusMusicEnabled?'Pause music':'Play soft music';
  if(!campusMusicEnabled){campusMusicAudio.pause();$('#music-track').textContent='Off';return}
  if(campusMusicAudio.src&&campusMusicAudio.currentTime>0){try{await campusMusicAudio.play()}catch{await playCampusMusic()}}
  else{shuffleCampusMusic();await playCampusMusic()}
});
const LEGACY_SCHOOL_LOCATIONS={pns:{center:{latitude:9.738599,longitude:118.738974},radius:1500}};
// The georeferenced BiteHub campus raster's bounds are printed in assets/ATTRIBUTION.txt.
// Keep GPS conversion, map clicks, and all rendered pins on that same coordinate surface.
const PNS_MAP={north:9.740445,south:9.736753,west:118.737108,east:118.740839,width:1024,height:1024};
const PNS_METERS_PER_PIXEL=((PNS_MAP.east-PNS_MAP.west)*111320*Math.cos(((PNS_MAP.north+PNS_MAP.south)/2)*Math.PI/180)/PNS_MAP.width+(PNS_MAP.north-PNS_MAP.south)*111320/PNS_MAP.height)/2;
// Campus routes traced from the blue pedestrian paths in the PNS campus guide.
const PNS_WALK_PATHS=[
  [[112,100],[112,195],[151,195],[180,199],[201,217],[204,240],[203,280],[255,282],[322,284],[365,288],[391,301],[410,325],[431,350],[452,362],[482,351],[513,330],[547,287],[576,298],[598,330],[626,350],[668,374],[712,406],[759,435],[808,462],[864,490],[943,515]],
  [[112,100],[110,194],[103,300],[91,407],[82,474],[80,635],[67,759],[42,882],[143,896],[252,910],[364,925],[476,940],[517,948]],
  [[82,474],[164,474],[203,475],[260,476],[321,478],[399,479],[469,480],[505,480],[523,491],[523,523],[506,540],[520,551]],
  [[203,475],[202,420],[203,363],[204,319],[203,280]],
  [[321,478],[327,434],[334,384],[339,337],[322,284]],
  [[399,479],[401,443],[407,408],[424,370],[452,362]],
  [[452,362],[462,401],[482,438],[505,480]],
  [[547,287],[546,333],[535,374],[520,411],[511,445],[505,480]],
  [[520,551],[540,549],[551,536],[567,527],[600,520],[642,520],[684,528],[725,545],[760,573],[789,612],[810,660],[822,710],[825,766],[818,818],[800,866],[775,905],[739,934],[699,950],[659,952],[621,940],[589,917],[567,880],[551,834],[540,785],[537,730],[537,675],[540,624],[546,580],[551,536],[520,551]],
  [[517,948],[527,917],[543,890],[559,872],[567,880]],
  [[943,515],[938,552],[918,583],[892,604],[864,619],[844,649],[836,700],[839,750],[825,766]]
];
const PNS_WALK_GRAPH=(()=>{const nodes=new Map(),edges=[];for(const path of PNS_WALK_PATHS){for(const point of path)nodes.set(`${point[0]},${point[1]}`,point);for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],distance=Math.hypot(b[0]-a[0],b[1]-a[1]);edges.push({a:`${a[0]},${a[1]}`,b:`${b[0]},${b[1]}`,distance})}}const links=new Map([...nodes.keys()].map(key=>[key,[]]));for(const edge of edges){links.get(edge.a).push({key:edge.b,distance:edge.distance});links.get(edge.b).push({key:edge.a,distance:edge.distance})}return{nodes,links,edges}})();
function activeCampus(){
  const schoolId=state.user?.school_id||'pns',legacy=LEGACY_SCHOOL_LOCATIONS[schoolId],hasSavedPin=state.user?.school_latitude!=null&&state.user?.school_longitude!=null,configured=hasSavedPin||Boolean(legacy),latitude=Number(hasSavedPin?state.user.school_latitude:legacy?.center.latitude??12.8797),longitude=Number(hasSavedPin?state.user.school_longitude:legacy?.center.longitude??121.774),radius=Number(state.user?.delivery_radius_m)||legacy?.radius||1500;
  const latSpan=radius/111320,lonSpan=radius/(111320*Math.max(.2,Math.cos(latitude*Math.PI/180)));
  return{configured,center:{latitude,longitude},radius,south:latitude-latSpan,north:latitude+latSpan,west:longitude-lonSpan,east:longitude+lonSpan};
}
function googleMapsPointUrl(point=null){const location=point||activeCampus().center;const params=new URLSearchParams({api:'1',query:`${location.latitude},${location.longitude}`});return `https://www.google.com/maps/search/?${params.toString()}`}
function googleMapsRouteUrl(origin,destination){const params=new URLSearchParams({api:'1',destination:`${destination.latitude},${destination.longitude}`,travelmode:'walking'});if(origin)params.set('origin',`${origin.latitude},${origin.longitude}`);return `https://www.google.com/maps/dir/?${params.toString()}`}
function mapXY(latitude,longitude){return{x:((Number(longitude)-PNS_MAP.west)/(PNS_MAP.east-PNS_MAP.west))*PNS_MAP.width,y:((PNS_MAP.north-Number(latitude))/(PNS_MAP.north-PNS_MAP.south))*PNS_MAP.height}}
function mapLatLon(x,y){return{latitude:PNS_MAP.north-(y/PNS_MAP.height)*(PNS_MAP.north-PNS_MAP.south),longitude:PNS_MAP.west+(x/PNS_MAP.width)*(PNS_MAP.east-PNS_MAP.west)}}
function pnsMapContains(point){return point&&point.latitude>=PNS_MAP.south&&point.latitude<=PNS_MAP.north&&point.longitude>=PNS_MAP.west&&point.longitude<=PNS_MAP.east}
function nearestWalkProjection(point){
  const p=mapXY(point.latitude,point.longitude);let best=null,bestDistance=Infinity;
  for(const edge of PNS_WALK_GRAPH.edges){const a=PNS_WALK_GRAPH.nodes.get(edge.a),b=PNS_WALK_GRAPH.nodes.get(edge.b),dx=b[0]-a[0],dy=b[1]-a[1],lengthSquared=dx*dx+dy*dy,t=lengthSquared?Math.max(0,Math.min(1,((p.x-a[0])*dx+(p.y-a[1])*dy)/lengthSquared)):0,projected=[a[0]+dx*t,a[1]+dy*t],distance=Math.hypot(p.x-projected[0],p.y-projected[1]);if(distance<bestDistance){bestDistance=distance;best={point:projected,a:edge.a,b:edge.b}}}
  return best;
}
function campusRoute(from,to){
  if(!from||!to)return null;
  const startPoint=mapXY(from.latitude,from.longitude),endPoint=mapXY(to.latitude,to.longitude),start=[startPoint.x,startPoint.y],end=[endPoint.x,endPoint.y],startSnap=nearestWalkProjection(from),endSnap=nearestWalkProjection(to);
  if(!startSnap||!endSnap)return{points:[start,end],meters:distanceMeters(from,to)};
  const startKey='__delivery_start__',endKey='__delivery_end__',coords=new Map(PNS_WALK_GRAPH.nodes);coords.set(startKey,startSnap.point);coords.set(endKey,endSnap.point);
  const links=new Map([...PNS_WALK_GRAPH.links].map(([key,value])=>[key,[...value]]));links.set(startKey,[]);links.set(endKey,[]);
  const connect=(virtual,snap)=>{for(const key of [snap.a,snap.b]){const distance=Math.hypot(snap.point[0]-coords.get(key)[0],snap.point[1]-coords.get(key)[1]);links.get(virtual).push({key,distance});links.get(key).push({key:virtual,distance})}};
  connect(startKey,startSnap);connect(endKey,endSnap);
  if((startSnap.a===endSnap.a&&startSnap.b===endSnap.b)||(startSnap.a===endSnap.b&&startSnap.b===endSnap.a)){const distance=Math.hypot(startSnap.point[0]-endSnap.point[0],startSnap.point[1]-endSnap.point[1]);links.get(startKey).push({key:endKey,distance});links.get(endKey).push({key:startKey,distance})}
  const distances=new Map([[startKey,0]]),previous=new Map(),open=new Set(links.keys());
  while(open.size){let current=null,currentDistance=Infinity;for(const key of open){const distance=distances.get(key)??Infinity;if(distance<currentDistance){current=key;currentDistance=distance}}if(current===null||!Number.isFinite(currentDistance))break;open.delete(current);if(current===endKey)break;for(const edge of links.get(current)||[]){if(!open.has(edge.key))continue;const next=currentDistance+edge.distance,cost=distances.get(edge.key)??Infinity;if(next<cost){distances.set(edge.key,next);previous.set(edge.key,current)}}}
  const keys=[];for(let key=endKey;key;key=previous.get(key)){keys.unshift(key);if(key===startKey)break}
  if(keys[0]!==startKey)return{points:[start,end],meters:distanceMeters(from,to)};
  const points=[start,startSnap.point,...keys.slice(1,-1).map(key=>coords.get(key)),endSnap.point,end].filter((point,index,list)=>index===0||Math.hypot(point[0]-list[index-1][0],point[1]-list[index-1][1])>.5),pixels=points.slice(1).reduce((sum,p,index)=>sum+Math.hypot(p[0]-points[index][0],p[1]-points[index][1]),0);
  return{points,meters:pixels*PNS_METERS_PER_PIXEL};
}
function distanceMeters(from,to){
  const radians=value=>value*Math.PI/180,lat1=radians(from.latitude),lat2=radians(to.latitude),dLat=lat2-lat1,dLon=radians(to.longitude-from.longitude);
  const a=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function deliveryEta(order,gpsAge){
  if(gpsAge>180000||order.driver_latitude==null||order.delivery_latitude==null)return'';
  const remaining=distanceMeters({latitude:order.driver_latitude,longitude:order.driver_longitude},{latitude:order.delivery_latitude,longitude:order.delivery_longitude});
  if(remaining<=18)return'Runner is at the handoff point';
  // Add a campus walking-route allowance because the map line cannot account for every building or obstruction.
  const routeMeters=Math.max(remaining,campusRoute({latitude:order.driver_latitude,longitude:order.driver_longitude},{latitude:order.delivery_latitude,longitude:order.delivery_longitude})?.meters||remaining),fast=Math.max(1,Math.ceil(routeMeters/(1.25*60))),slow=Math.max(fast,Math.ceil(routeMeters/(0.85*60)));
  return fast===slow?`Estimated arrival · about ${fast} min`:`Estimated arrival · about ${fast}–${slow} min`;
}
function setMapZoom(action){state.mapZoom=action==='reset'?1:Math.max(1,Math.min(4,state.mapZoom*(action==='in'?1.5:1/1.5)));document.querySelectorAll('.campus-map-scene').forEach(scene=>scene.style.transform=`scale(${state.mapZoom})`)}
function campusMap(order,interactive=false){
  const destination=interactive?state.deliveryLocation:(order?.delivery_latitude!=null?{latitude:order.delivery_latitude,longitude:order.delivery_longitude}:null);
  const driver=order?.driver_latitude!=null?{latitude:order.driver_latitude,longitude:order.driver_longitude,heading:order.driver_heading}:null;
  const stall=order?.stall_latitude!=null?{latitude:order.stall_latitude,longitude:order.stall_longitude}:null;
  const pin=(point,label,kind)=>{if(!point)return'';const p=mapXY(point.latitude,point.longitude),heading=kind==='driver'&&Number.isFinite(Number(point.heading))?Number(point.heading):0;return `<g class="map-marker map-marker-${kind}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><circle class="map-marker-halo" r="25"/><circle class="map-marker-core" r="17"><title>${label}</title></circle><text y="5" text-anchor="middle" aria-hidden="true" ${kind==='driver'?`transform="rotate(${heading})"`:''}>${kind==='stall'?'S':kind==='driver'?'▲':'H'}</text></g>`};
  const route=driver&&destination?campusRoute(driver,destination):null;
  const routePath=route?`<path class="map-route-shadow" d="M${route.points.map(p=>`${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')}"/><path class="map-route" d="M${route.points.map(p=>`${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L')}"/>`:'';
  // The updated campus guide already prints the blue walkways; only overlay the live route.
  const network='';
  const pointData=(point,name)=>point?`data-${name}-latitude="${point.latitude}" data-${name}-longitude="${point.longitude}"`:'';
  return `<div class="campus-map-shell" data-campus-map="true" data-map-mode="${interactive?'picker':'tracking'}" ${pointData(stall,'stall')} ${pointData(destination,'destination')} ${pointData(driver,'driver')}><div class="campus-map-scene" style="transform:scale(${state.mapZoom})"><img class="campus-map-image" src="assets/pns-campus-safe-routes.jpg" alt="PNS campus map with blue marked walking paths"><svg class="campus-map ${interactive?'is-picker':''}" viewBox="0 0 ${PNS_MAP.width} ${PNS_MAP.height}" preserveAspectRatio="none" role="${interactive?'button':'img'}" ${interactive?'data-map-picker tabindex="0" aria-label="Choose a handoff point on the PNS campus map"':'aria-label="PNS campus delivery map showing the stall, runner location, handoff point, and campus walking route"'}><path class="map-walkway" d="${network}"/>${routePath}${pin(stall,'Stall pickup','stall')}${pin(destination,'Handoff point','destination')}${pin(driver,'Runner location','driver')}</svg></div><div class="map-zoom-controls" aria-label="Map zoom controls"><button type="button" data-map-zoom="in" aria-label="Zoom in">+</button><button type="button" data-map-zoom="out" aria-label="Zoom out">−</button><button type="button" data-map-zoom="reset" aria-label="Reset zoom">Reset</button></div></div>`;
}
function toast(message){toastNode.textContent=message;toastNode.classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastNode.classList.remove('is-visible'),2800)}
async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body.error||`Request failed (${response.status}).`);
  return body;
}
const json=data=>JSON.stringify(data);
function saveGuestOrderAccess(record){
  const records=guestOrderAccess.filter(item=>item.id!==Number(record.id));
  records.push({id:Number(record.id),token:record.token,code:String(record.code||'')});
  guestOrderAccess=records.slice(-12);
  try{localStorage.setItem(GUEST_ORDER_STORAGE_KEY,JSON.stringify(guestOrderAccess))}catch{toast('This browser could not save the private order link. Keep this tab open to follow your order.')}
}
function guestOrderToken(orderId){return guestOrderAccess.find(item=>item.id===Number(orderId))?.token||''}
async function refreshGuestOrders(){
  if(state.user||!state.publicBrowse)return[];
  const records=guestOrderAccess;
  const results=await Promise.all(records.map(async record=>{
    try{return (await api(`/api/guest/orders/${record.id}`,{method:'POST',body:json({token:record.token})})).order}
    catch{return null}
  }));
  state.orders=results.filter(Boolean).sort((a,b)=>b.id-a.id);
  return state.orders;
}
function renderRunnerSharePage(orderId,tokenValid=true){
  document.body.classList.add('runner-tracking-page');
  root.innerHTML=`<section class="runner-share-page"><header class="runner-share-brand"><a href="/" aria-label="BiteHub home"><img src="assets/bitehub-icon.png" alt=""><span><strong>BiteHub</strong><small>PALAWAN NATIONAL SCHOOL</small></span></a><span class="runner-share-live"><i></i>Delivery tracking</span></header><main class="runner-share-card"><span class="eyebrow">PNS RUNNER LINK · ORDER #${Number(orderId)||'—'}</span><div class="runner-share-illustration" aria-hidden="true"><span>📍</span><i></i><b>↗</b></div><h1>Share your live location</h1><p class="runner-share-lead">The customer can follow your delivery on the PNS campus map while you bring their order over.</p><div class="runner-share-status" id="runner-share-status" role="status" aria-live="polite">${tokenValid?'Tap start when you are ready. Your phone will ask to use its location.':'This runner link is incomplete. Ask the stall owner for a new link.'}</div><div class="runner-share-actions"><button type="button" class="button button-primary" data-runner-share-start ${tokenValid?'':'disabled'}>Start sharing location <span aria-hidden="true">→</span></button><button type="button" class="button button-outline" data-runner-share-stop hidden>Pause sharing</button></div><p class="runner-share-guidance">Updates about every 5 seconds while this page is open. Keep GPS enabled and leave this screen open during delivery. Phone location sharing requires a secure HTTPS connection.</p><div class="runner-share-privacy">🔒 Location is shared only with the customer and stall for this active order.</div></main><footer>Made for the PNS community · BiteHub</footer></section>`;
}
function runnerTrackingFromHash(){
  const match=location.hash.match(/^#runner-track=(\d+)\.([A-Za-z0-9_-]{40,100})$/);
  return match?{orderId:Number(match[1]),token:match[2]}:null;
}
function getRunnerGpsFix(){
  return new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,error=>{
    const message=error.code===1?'Allow location access to share this delivery.':error.code===3?'Location is taking too long. Check GPS and try again.':'Your phone could not read its location. Check GPS and try again.';
    reject(new Error(message));
  },{enableHighAccuracy:true,maximumAge:0,timeout:15000}));
}
async function sendAnonymousRunnerPosition(){
  if(!publicRunnerTracking||runnerShareBusy)return false;
  runnerShareBusy=true;
  try{
    const position=await getRunnerGpsFix(),coords=position.coords;
    const result=await api('/api/runner-location',{method:'POST',body:json({order_id:publicRunnerTracking.orderId,token:publicRunnerTracking.token,latitude:coords.latitude,longitude:coords.longitude,accuracy:Math.min(coords.accuracy||0,1000),heading:Number.isFinite(coords.heading)?coords.heading:null})});
    const status=$('#runner-share-status');if(status)status.textContent=`Location shared · last update ${new Date(result.updated_at||Date.now()).toLocaleTimeString('en-PH',{hour:'numeric',minute:'2-digit',second:'2-digit'})}`;
    return true;
  }catch(error){
    const status=$('#runner-share-status');if(status)status.textContent=error.message;
    if(/runner link is no longer active/i.test(error.message)){clearInterval(runnerShareTimer);runnerShareTimer=null;const start=$('[data-runner-share-start]');if(start){start.disabled=true;start.textContent='Link no longer active'}}
    return false;
  }finally{runnerShareBusy=false}
}
async function startAnonymousRunnerSharing(){
  if(!publicRunnerTracking)return;
  if(!window.isSecureContext||!navigator.geolocation){const status=$('#runner-share-status');if(status)status.textContent='This device needs HTTPS and location permission before it can share GPS.';return}
  const start=$('[data-runner-share-start]'),stop=$('[data-runner-share-stop]');if(start){start.disabled=true;start.textContent='Finding your location…'}
  const ok=await sendAnonymousRunnerPosition();
  if(ok){if(start)start.hidden=true;if(stop)stop.hidden=false;clearInterval(runnerShareTimer);runnerShareTimer=setInterval(sendAnonymousRunnerPosition,5000)}
  else if(start){start.disabled=false;start.innerHTML='Try sharing again <span aria-hidden="true">→</span>'}
}
function stopAnonymousRunnerSharing(){clearInterval(runnerShareTimer);runnerShareTimer=null;const start=$('[data-runner-share-start]'),stop=$('[data-runner-share-stop]'),status=$('#runner-share-status');if(start){start.hidden=false;start.disabled=false;start.innerHTML='Resume sharing location <span aria-hidden="true">→</span>'}if(stop)stop.hidden=true;if(status)status.textContent='Location sharing paused. Resume it when you continue the delivery.'}
function setDeliveryPoint(latitude,longitude,shell=null){
  const campus=activeCampus();
  if(!campus.configured){toast('Campus delivery is not available until your school location is set. Choose pickup for now.');return}
  if(!pnsMapContains({latitude,longitude})){toast('Choose a handoff point inside the PNS campus map.');return}
  state.deliveryLocation={latitude:Number(latitude),longitude:Number(longitude)};
  const mapShell=shell||$('#delivery-map-wrap .campus-map-shell');
  if(mapShell?.querySelector('.campus-map'))mapShell.outerHTML=campusMap(null,true);
  const status=$('#delivery-map-status');if(status)status.textContent='Handoff point selected';
  const googleLink=$('#delivery-google-link');if(googleLink){googleLink.href=googleMapsPointUrl(state.deliveryLocation);googleLink.innerHTML='Open handoff point in Google Maps <span aria-hidden="true">↗</span>'}
  updateCartCheckoutButton();
}
async function enhanceGoogleCampusMaps(){
  // Preserve the calibrated PNS raster and traced paths for both selecting and tracking.
}
function fileAsBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read the image.'));reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.readAsDataURL(file)})}
function productMetadataFields(product={}){
  const stock=product.stock_count??'';
  const dietary=new Set(product.dietary_tags||[]),allergens=new Set(product.allergen_tags||[]);
  const picker=(name,title,options,selected)=>`<details class="tag-picker"><summary>${title}</summary><div class="tag-checkboxes">${options.map(([value,label])=>`<label><input type="checkbox" name="${name}" value="${value}" ${selected.has(value)?'checked':''}><span>${label}</span></label>`).join('')}</div></details>`;
  return `<div class="photo-preview ${product.photo_url?'has-photo':''}"><img ${product.photo_url?`src="${esc(product.photo_url)}"`:''} alt="Current food photo" ${product.photo_url?'':'hidden'}><span>${product.photo_url?'Current menu photo':'Emoji artwork will be used until you add a photo.'}</span></div><label>Food photo <span class="field-hint">Optional · JPG, PNG, or WebP · max 2 MB</span><input name="photo_file" type="file" accept="image/jpeg,image/png,image/webp"></label>${product.photo_url?'<label class="photo-remove"><input name="remove_photo" type="checkbox" value="true"><span>Remove current photo</span></label>':''}<label>Stock remaining <span class="field-hint">Leave blank for unlimited</span><input name="stock_count" type="number" min="0" max="1000000" step="1" value="${stock}" placeholder="Unlimited"></label>${picker('dietary_tags','Dietary labels',dietaryOptions,dietary)}${picker('allergen_tags','Contains allergens',allergenOptions,allergens)}<p class="helper-text">Labels are provided by the stall. Please confirm allergy details directly.</p>`;
}
function addProductMetadataFields(form,product={}){
  const submit=form?.querySelector('button[type="submit"],button:not([type])');
  if(submit)submit.insertAdjacentHTML('beforebegin',productMetadataFields(product));
}
function productTags(product){
  const dietary=(product.dietary_tags||[]).map(tag=>dietaryLabels[tag]).filter(Boolean);
  const allergens=(product.allergen_tags||[]).map(tag=>allergenLabels[tag]).filter(Boolean);
  return `${dietary.map(tag=>`<span class="product-tag dietary-tag">${esc(tag)}</span>`).join('')}${allergens.length?`<span class="product-tag allergen-tag">Contains ${esc(allergens.join(', '))}</span>`:''}`;
}
function addCatalogControls(){
  const container=$('.catalog-filter-options');if(!container)return;
  const stalls=[...new Map(state.products.map(product=>[product.stall_id,product.stall_name])).entries()];
  const stallOptions=stalls.map(([id,name])=>`<option value="${id}" ${state.stallFilter===String(id)?'selected':''}>${esc(name)}</option>`).join('');
  container.innerHTML=`<label class="catalog-select">Stall<select id="stall-filter"><option value="All">All stalls</option>${stallOptions}</select></label><label class="catalog-select">Dietary<select id="dietary-filter"><option value="All">Any</option>${dietaryOptions.map(([value,label])=>`<option value="${value}" ${state.dietaryFilter===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="catalog-select">Avoid<select id="allergen-filter"><option value="All">No filter</option>${allergenOptions.map(([value,label])=>`<option value="${value}" ${state.allergenFilter===value?'selected':''}>${label}</option>`).join('')}</select></label>`;
}
function decorateProductCards(){
  root.querySelectorAll('.product-card').forEach(card=>{
    const trigger=card.querySelector('[data-product-details]');
    const product=state.products.find(item=>item.id===Number(trigger?.dataset.productDetails));
    if(!product)return;
    if(product.photo_url){const art=card.querySelector('.product-art-trigger');art?.classList.add('has-photo');art?.querySelector('span')?.remove();art?.insertAdjacentHTML('afterbegin',`<img class="product-photo" src="${esc(product.photo_url)}" alt="Photo of ${esc(product.name)}" loading="lazy" decoding="async">`)}
    const stall=card.querySelector('.product-stall');
    if(stall){stall.setAttribute('role','button');stall.setAttribute('tabindex','0');stall.setAttribute('data-stall-profile',product.stall_id);stall.setAttribute('aria-label',`Open ${product.stall_name} stall profile`);stall.innerHTML=`<span class="stall-mini-logo">${product.stall_logo_url?`<img src="${esc(product.stall_logo_url)}" alt="">`:`${esc(product.stall_name.trim().charAt(0).toUpperCase())}`}</span><span>${esc(product.stall_name)}</span>`;stall.insertAdjacentHTML('afterend',`<small class="product-service-note">${product.stall_open?`Open now · ${esc(product.opens_at)}–${esc(product.closes_at)} PHT`:`Closed · opens ${esc(product.opens_at)} PHT`}</small>`)}
    const footer=card.querySelector('.product-bottom');
    if(productTags(product))footer?.insertAdjacentHTML('beforebegin',`<div class="product-tag-summary">${productTags(product)}</div>`);
    const stock=Number(product.stock_count),artwork=card.querySelector('.product-art-trigger');
    if(product.available&&Number.isFinite(stock)&&stock>0&&stock<3&&artwork&&!artwork.querySelector('.product-stock-urgency'))artwork.insertAdjacentHTML('afterbegin','<small class="product-stock-urgency" aria-label="Almost sold out. Only '+stock+' left. Buy now"><b>ALMOST GONE</b><span>Buy now · '+stock+' left</span></small>');
    const add=card.querySelector('[data-add]');
    if(add){
      const closed=!product.stall_open;
      const soldOut=!product.available;
      add.disabled=state.paused||closed||soldOut;
      add.textContent=state.paused?'Paused':closed?'Closed':soldOut?'Sold out':'Add +';
      if(closed)add.title=`Opens ${product.opens_at}`;
      if(product.stock_count!==null&&product.stock_count>0)card.querySelector('.product-bottom')?.insertAdjacentHTML('afterbegin',`<small class="stock-note">${product.stock_count} left</small>`);
    }
  });
}
function renderMarketCategories(){
  const categories=[['All','🍽️','All food'],['Meals','🍱','Meals'],['Snacks','🍟','Snacks'],['Drinks','🥤','Drinks']];
  return `<section class="market-category-section" aria-labelledby="market-category-title"><div class="market-category-heading"><div><span class="eyebrow">BROWSE BY CRAVING</span><h2 id="market-category-title">Explore the campus market</h2></div><p>Quick picks from PNS stalls</p></div><div class="market-category-rail" role="group" aria-label="Browse campus food categories">${categories.map(([category,emoji,label])=>{const count=category==='All'?state.products.length:state.products.filter(item=>item.category===category).length;const sample=category==='All'?state.products.find(item=>item.photo_url):state.products.find(item=>item.category===category&&item.photo_url);const art=sample?.photo_url?`<img src="${esc(sample.photo_url)}" alt="" loading="lazy">`:`<span aria-hidden="true">${emoji}</span>`;const disabled=category!=='All'&&count===0;return `<button type="button" class="market-category-tile ${state.filter===category?'is-active':''}" data-filter="${category}" aria-pressed="${state.filter===category}" aria-label="${label}, ${count} menu ${count===1?'item':'items'}" ${disabled?'disabled':''}><span class="market-category-art">${art}</span><strong>${label}</strong><small>${count?`${count} ${count===1?'pick':'picks'}`:'No items yet'}</small></button>`}).join('')}</div></section>`;
}
function renderFeaturedPicks(){
  const picks=state.featuredProducts;
  const categories=renderMarketCategories();
  if(!picks.length)return categories;
  return `${categories}<section class="featured-section" aria-labelledby="featured-title"><div class="featured-heading"><div><span class="eyebrow">TODAY AT THE PNS MARKET</span><h2 id="featured-title">Fresh from our stalls <span aria-hidden="true">✦</span></h2><p>Handpicked favorites from the PNS campus market.</p></div><div class="featured-controls"><button type="button" class="featured-control" data-feature-move="-1" aria-label="Previous campus picks">←</button><button type="button" class="featured-control" data-feature-move="1" aria-label="Next campus picks">→</button><button type="button" class="featured-motion" data-feature-pause aria-pressed="${state.featuredPaused}">${state.featuredPaused?'Play':'Pause'} rotation</button></div></div><div class="featured-rail" aria-label="Featured campus menu items">${picks.map(item=>`<article class="featured-card"><div class="featured-photo">${item.photo_url?`<img src="${esc(item.photo_url)}" alt="${esc(item.name)}" loading="lazy">`:`<span aria-hidden="true">${esc(item.emoji)}</span>`}<span class="featured-ribbon">✦ TODAY’S PICK</span></div><div class="featured-copy"><button class="featured-stall featured-stall-link" data-stall-profile="${item.stall_id}"><span class="stall-mini-logo">${item.stall_logo_url?`<img src="${esc(item.stall_logo_url)}" alt="">`:`${esc(item.stall_name.trim().charAt(0).toUpperCase())}`}</span>${esc(item.stall_name)}</button><h3>${esc(item.name)}</h3><p>${esc(item.description||'A fresh campus favorite, ready for your break.')}</p><div class="featured-buy"><strong>${money(item.price)}</strong><button class="button button-primary button-small" data-add="${item.id}" ${state.paused||!item.stall_open||!item.available?'disabled':''}>${state.paused?'Paused':!item.stall_open?'Closed':!item.available?'Sold out':'Add to bag +'}</button></div></div></article>`).join('')}</div><small class="featured-fairness">Featured stalls rotate daily · Each stall can feature one item at a time</small></section>`;
}
function buyerHeroItems(){
  const available=[...state.featuredProducts,...state.products].filter(item=>item.available!==false&&(item.stock_count==null||Number(item.stock_count)>0));
  return [...new Map(available.map(item=>[item.id,item])).values()];
}
function startFeaturedMotion(){
  if(state.featuredTimer){clearInterval(state.featuredTimer);state.featuredTimer=null}
  if(!buyerHeroItems().length)return;
  state.featuredTimer=setInterval(()=>{
    if(state.featuredPaused||document.visibilityState!=='visible')return;
    if(buyerHeroItems().length>1)setBuyerHeroFeature(state.heroFeaturedIndex+1);
    if($('.featured-rail:hover')||document.activeElement?.closest('.featured-section'))return;
    const rail=$('.featured-rail'),card=rail?.querySelector('.featured-card');if(!rail||!card)return;
    const step=card.getBoundingClientRect().width+12,max=rail.scrollWidth-rail.clientWidth;
    if(max<4)return;
    const next=rail.scrollLeft+step;
    rail.scrollTo({left:next>=max-4?0:next,behavior:'smooth'});
  },10000);
}
function accountTools(){
  const tools=$('#account-tools');
  if(!state.user){const bagCount=cartCount();tools.hidden=!state.publicBrowse;tools.innerHTML=state.publicBrowse?`<button class="sidebar-menu-button guest-menu-trigger" type="button" data-action="open-sidebar" aria-label="Open guest menu" aria-expanded="${state.sidebarOpen}"><span></span><span></span><span></span><b>Menu</b></button><span class="guest-mode-pill">Guest ordering</span><button class="button button-outline button-compact guest-orders-button" type="button" data-workspace-role="buyer" data-workspace-view="orders" aria-label="Open my orders">My orders${state.orders.length?` (${state.orders.length})`:''}</button><button class="button button-primary button-compact header-bag" type="button" data-action="open-cart" aria-label="Open your bag${bagCount?`, ${bagCount} item${bagCount===1?'':'s'}`:''}"><span class="header-bag-label">Your bag</span>${bagCount?`<span class="header-bag-count" aria-hidden="true">${bagCount}</span>`:''}</button>`:'';renderSidebar();updateCartShortcut();return}
  tools.hidden=false;
  const school=state.user.school_name||'Palawan National School';
  const count=cartCount();
  const bagButton=state.user.role==='buyer'?`<button class="button button-outline button-compact header-bag" type="button" data-action="open-cart" aria-label="Open your bag${count?`, ${count} item${count===1?'':'s'}`:''}"><span class="header-bag-label">Your bag</span>${count?`<span class="header-bag-count" aria-hidden="true">${count}</span>`:''}</button>`:'';
  tools.innerHTML=`<button class="sidebar-menu-button" type="button" data-action="open-sidebar" aria-label="Open dashboard menu" aria-expanded="${state.sidebarOpen}"><span></span><span></span><span></span><b>Dashboard</b></button>${bagButton}<div class="account-chip"><span class="avatar">${state.user.profile_photo_url?`<img src="${esc(state.user.profile_photo_url)}" alt="">`:esc(state.user.name.trim().charAt(0).toUpperCase())}</span><span><strong>${esc(state.user.name)}</strong><small>${esc(roleLabel[state.user.role])} · ${esc(school)}${state.user.stall_name?` · ${esc(state.user.stall_name)}`:''}</small></span></div>`;
  renderSidebar();
  updateCartShortcut();
}
function renderSidebar(){
  const user=state.user,account=$('#sidebar-account'),navigation=$('#sidebar-navigation');
  if(!account||!navigation)return;
  const dangerZone=$('.sidebar-danger-zone'),logoutButton=$('.sidebar-logout'),settingsWrap=$('.sidebar-settings-wrap');
  if(dangerZone)dangerZone.hidden=!user;
  if(logoutButton)logoutButton.hidden=!user;
  if(!user){
    if(!state.publicBrowse)return;
    const ordersCount=state.orders.filter(order=>!['completed','declined'].includes(order.status)).length;
    account.innerHTML=`<div class="guest-sidebar-card"><span class="guest-sidebar-icon" aria-hidden="true">⌂</span><span><strong>Browsing as a guest</strong><small>No customer account needed to explore PNS stalls.</small></span></div>`;
    navigation.innerHTML=`<button type="button" class="sidebar-nav-link ${state.buyerView==='menu'?'is-active':''}" data-workspace-role="buyer" data-workspace-view="menu" ${state.buyerView==='menu'?'aria-current="page"':''}><span class="sidebar-link-icon" aria-hidden="true">⌕</span><span>Browse food</span></button><button type="button" class="sidebar-nav-link ${state.buyerView==='orders'?'is-active':''}" data-workspace-role="buyer" data-workspace-view="orders" ${state.buyerView==='orders'?'aria-current="page"':''}><span class="sidebar-link-icon" aria-hidden="true">↗</span><span>My orders</span>${ordersCount?`<small>${ordersCount}</small>`:''}</button><button type="button" class="sidebar-nav-link guest-owner-link" data-action="guest-owner-login"><span class="sidebar-link-icon" aria-hidden="true">⌂</span><span>Stall owner sign in</span><span aria-hidden="true">→</span></button>`;
    if(settingsWrap)settingsWrap.hidden=false;
    const settings=$('#sidebar-settings-panel'),settingsButton=$('#sidebar-settings-toggle');
    if(settings)settings.hidden=!state.sidebarSettingsOpen;
    if(settingsButton)settingsButton.setAttribute('aria-expanded',String(state.sidebarSettingsOpen));
    renderNotificationSettings();applyTheme();syncSidebarState();return;
  }
  if(settingsWrap)settingsWrap.hidden=false;
  const school=user.school_name||'Palawan National School';
  const initial=esc(user.name.trim().charAt(0).toUpperCase()),profilePhoto=user.profile_photo_url?`<img src="${esc(user.profile_photo_url)}" alt="">`:initial;
  account.innerHTML=`<div class="sidebar-account-main"><span class="sidebar-avatar">${profilePhoto}</span><span class="sidebar-account-copy"><strong>${esc(user.name)}</strong><small>${esc(roleLabel[user.role])} · ${esc(school)}</small></span><button type="button" class="sidebar-profile-trigger" data-action="toggle-profile" aria-expanded="${state.sidebarProfileOpen}">${state.sidebarProfileOpen?'Close':'Edit profile'}</button></div><section class="sidebar-profile-editor" ${state.sidebarProfileOpen?'':'hidden'} aria-label="Edit your profile"><form class="sidebar-profile-form" data-form="user-profile"><div class="sidebar-profile-photo-row"><span class="sidebar-profile-avatar">${profilePhoto}</span><label class="sidebar-photo-picker"><input name="photo_file" type="file" accept="image/jpeg,image/png,image/webp"><span>Choose photo</span><small>JPG, PNG, WebP · max 2 MB</small></label></div><label class="sidebar-profile-name">Display name<input name="name" autocomplete="name" maxlength="80" required value="${esc(user.name)}"></label>${user.profile_photo_url?'<label class="sidebar-profile-remove"><input name="remove_photo" type="checkbox" value="true"><span>Remove current photo</span></label>':''}<button class="button button-primary button-small" type="submit">Save profile</button></form></section>`;
  const dashboard={buyer:['buyer','menu','Browse food'],owner:['owner','dashboard','Today'],admin:['admin','overview','Overview']}[user.role];
  const orders={buyer:['buyer','orders','My orders','↗'],owner:['owner','orders','Orders','↗'],admin:['admin','orders','Orders','↗']}[user.role];
  const navButton=([role,view,label,icon],active)=>`<button type="button" class="sidebar-nav-link ${active?'is-active':''}" data-workspace-role="${role}" data-workspace-view="${view}" ${active?'aria-current="page"':''}><span class="sidebar-link-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`;
  const activeView={buyer:state.buyerView,owner:state.ownerView,admin:state.adminView}[user.role];
  let links='';
  if(dashboard)links+=navButton([dashboard[0],dashboard[1],'Dashboard','⌂'],activeView===dashboard[1]);
  if(orders)links+=navButton([orders[0],orders[1],orders[2],orders[3]],activeView===orders[1]);
  if(user.role==='runner')links=`<button type="button" class="sidebar-nav-link is-active" data-sidebar-scroll="runner-summary" aria-current="page"><span class="sidebar-link-icon" aria-hidden="true">⌂</span><span>Dashboard</span></button><button type="button" class="sidebar-nav-link" data-sidebar-scroll="runner-queue"><span class="sidebar-link-icon" aria-hidden="true">↗</span><span>Delivery queue</span></button>`;
  navigation.innerHTML=links;
  const settings=$('#sidebar-settings-panel'),settingsButton=$('#sidebar-settings-toggle');
  if(settings)settings.hidden=!state.sidebarSettingsOpen;
  if(settingsButton)settingsButton.setAttribute('aria-expanded',String(state.sidebarSettingsOpen));
  renderNotificationSettings();
  applyTheme();
  syncSidebarState();
}
function syncSidebarState(){
  const sidebar=$('#app-sidebar'),backdrop=$('#sidebar-backdrop'),button=$('.sidebar-menu-button');
  if(!sidebar||!backdrop)return;
  const open=Boolean(state.sidebarOpen&&(state.user||state.publicBrowse));
  sidebar.classList.toggle('is-open',open);
  sidebar.setAttribute('aria-hidden',String(!open));
  sidebar.inert=!open;
  backdrop.hidden=!open;
  document.body.classList.toggle('sidebar-open',open);
  const appShell=$('#app');if(appShell)appShell.inert=open;
  if(button)button.setAttribute('aria-expanded',String(open));
}
function closeSidebar(){state.sidebarOpen=false;syncSidebarState()}
function renderNotificationSettings(){
  const setting=$('#sidebar-notification-setting');if(!setting)return;
  const message=state.pushEnabled?'Order updates will appear as device alerts.':state.pushAvailable?'Get an alert when an order arrives or its status changes.':'Device alerts need the server notification package. In-page updates will still work.';
  const status=state.pushEnabled?'On for this device':state.pushAvailable?'Ready to enable':'Unavailable';
  setting.innerHTML=`<div class="sidebar-notification-heading"><span class="sidebar-preference-icon" aria-hidden="true">♧</span><span class="sidebar-preference-copy"><strong>Order notifications</strong><small>${status}</small></span></div><p class="sidebar-notification-description">${message}</p>${state.pushEnabled?'<button class="button button-outline button-small" data-action="disable-notifications">Turn off alerts</button>':`<button class="button button-primary button-small" data-action="enable-notifications" ${state.pushAvailable?'':'disabled'}>Enable alerts</button>`}`;
}
async function loadNotificationState(){
  if(!state.user)return;
  try{
    const [config,status]=await Promise.all([api('/api/notifications/config'),api('/api/notifications/status')]);
    state.pushAvailable=Boolean(window.isSecureContext&&config.available&&config.public_key&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window);
    const registration=await navigator.serviceWorker.getRegistration();
    const subscription=await registration?.pushManager.getSubscription();
    state.pushEnabled=Boolean(status.enabled&&subscription);
  }catch(_){state.pushAvailable=false;state.pushEnabled=false}
  if(state.user)render();
}
function applicationServerKey(value){const padding='='.repeat((4-value.length%4)%4),raw=atob(value.replace(/-/g,'+').replace(/_/g,'/')+padding);return Uint8Array.from(raw,char=>char.charCodeAt(0))}
async function enablePushNotifications(){
  if(!window.isSecureContext||!('serviceWorker'in navigator)||!('PushManager'in window)||!('Notification'in window))throw new Error('Device alerts need HTTPS (or localhost) and a browser that supports push notifications.');
  const config=await api('/api/notifications/config');if(!config.available||!config.public_key)throw new Error('Device alerts are not set up on the server yet.');
  const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Allow notifications in your browser settings to receive order alerts.');
  const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
  let subscription=await registration.pushManager.getSubscription();
  if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:applicationServerKey(config.public_key)});
  await api('/api/notifications/subscriptions',{method:'POST',body:json({subscription:subscription.toJSON()})});
  state.pushAvailable=true;state.pushEnabled=true;render();toast('Order notifications are on for this device.');
}
async function disablePushNotifications(){
  const registration=await navigator.serviceWorker.getRegistration();
  const subscription=await registration?.pushManager.getSubscription();
  if(subscription)await subscription.unsubscribe();
  if(subscription)await api('/api/notifications/unsubscribe',{method:'POST',body:json({endpoint:subscription.endpoint})});
  state.pushEnabled=false;render();toast('Device notifications turned off.');
}
async function refresh(includeMenu=true){
  if(!state.user){
    if(!state.publicBrowse){renderAuthWall();return}
    if(refreshInFlight)return;
    refreshInFlight=true;
    const finishLoading=beginSlowLoadFeedback();
    try{const menu=await api('/api/products');state.products=menu.products;state.featuredProducts=menu.featured_products||[];state.paused=menu.ordering_paused;await refreshGuestOrders();render()}
    catch(error){renderError(error.message)}
    finally{refreshInFlight=false;finishLoading()}
    return;
  }
  if(refreshInFlight)return;
  refreshInFlight=true;
  const finishLoading=beginSlowLoadFeedback();
  const userId=state.user.id;
  const role=state.user.role,now=Date.now();
  const loadMenu=includeMenu||now-lastMenuRefresh>=15000;
  const loadReach=role==='owner'&&(includeMenu||now-lastReachRefresh>=60000);
  const loadOverview=role==='admin'&&(includeMenu||now-lastOverviewRefresh>=15000);
  const loadReports=role==='admin'&&(includeMenu||now-lastReportsRefresh>=30000);
  try{
    const [menu,orders,reach,overview,reports]=await Promise.all([
      loadMenu?api('/api/products'):Promise.resolve(null),api('/api/orders'),
      loadReach?api('/api/stall/analytics'):Promise.resolve(null),
      loadOverview?api('/api/admin/overview'):Promise.resolve(null),
      loadReports?api('/api/admin/reports'):Promise.resolve(null)]);
    if(state.user?.id!==userId)return;
    const previousStatuses=orderBaselineUserId===userId?new Map(state.orders.map(order=>[order.id,order.status])):new Map();
    const changedOrders=orders.orders.filter(order=>previousStatuses.has(order.id)&&previousStatuses.get(order.id)!==order.status);
    if(menu){state.products=menu.products;state.featuredProducts=menu.featured_products||[];lastMenuRefresh=Date.now()}
    if(reach){state.reachAnalytics=reach;lastReachRefresh=Date.now()}
    if(overview){state.overview=overview;lastOverviewRefresh=Date.now()}
    if(reports){state.adminReports=reports;lastReportsRefresh=Date.now()}
    state.paused=orders.ordering_paused;state.orders=orders.orders;
    if(state.user.role==='owner'){
      state.user.stall_status=orders.stall_status;
      if(menu){state.user.stall_opens_at=menu.owner_hours.opens_at;state.user.stall_closes_at=menu.owner_hours.closes_at;state.user.stall_prep_minutes=menu.owner_prep_minutes;state.user.stall_pickup_slot_capacity=menu.owner_pickup_capacity}
    }
    if(state.user?.id!==userId)return;
    render();
    orderBaselineUserId=userId;
    if(state.user.role==='buyer'&&changedOrders.length){
      const order=changedOrders[0],status=statusLabel[order.status]||order.status;
      toast(changedOrders.length===1?`Order #${order.id} is now ${status.toLowerCase()}.`:`You have ${changedOrders.length} order status updates.`);
    }
  }catch(error){if(state.user?.id===userId){if(orderBaselineUserId===userId)toast(`Connection interrupted. Showing the last loaded information; retrying automatically. ${error.message}`);else renderError(error.message)}}
  finally{refreshInFlight=false;finishLoading()}
}
function startAutoRefresh(){
  clearTimeout(refreshTimer);
  if(!state.user&&!state.publicBrowse)return;
  const canRefresh=()=>Boolean(state.user||state.publicBrowse);
  const schedule=delay=>{
    refreshTimer=setTimeout(async()=>{
      if(document.visibilityState==='visible'&&!document.querySelector('dialog[open]')&&!document.activeElement?.closest('form')&&!document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')&&!root.querySelector('.product-add-panel[open],.product-extra-fields[open]'))await refresh(false);
      if(canRefresh())schedule(document.visibilityState==='visible'?(state.user?(state.orders.some(order=>order.status==='out'&&order.fulfillment==='delivery')?5000:4500):8000+Math.random()*2000):30000);
    },delay);
  };
  schedule(document.visibilityState==='visible'?(state.user?3500+Math.random()*1000:8000+Math.random()*2000):30000);
}
async function continueAsGuest(){
  const result=await api('/api/guest/session',{method:'POST',body:json({name:state.guestName})});
  state.guestSessionId=result.guest_session?.id||null;
  clearTimeout(refreshTimer);
  state.publicBrowse=true;state.authRole='buyer';state.buyerView='menu';
  document.querySelector('#app')?.classList.remove('auth-open');
  history.pushState({workspace:'buyer',view:'menu'},'','#menu');
  await refresh();startAutoRefresh();
  toast(`Welcome, ${state.guestName}. Add items to your bag when you’re ready to order.`);
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&(state.user||state.publicBrowse)){clearTimeout(refreshTimer);refresh(false).finally(startAutoRefresh)}});
const workspaceHashMap={'#menu':['buyer','menu'],'#buyer-orders':['buyer','orders'],'#owner-dashboard':['owner','dashboard'],'#owner-orders':['owner','orders'],'#owner-menu':['owner','menu'],'#owner-stall':['owner','stall'],'#owner-insights':['owner','insights'],'#admin-overview':['admin','overview'],'#admin-stalls':['admin','stalls'],'#admin-orders':['admin','orders'],'#admin-reports':['admin','reports'],'#admin-accounts':['admin','accounts']};
function applyWorkspaceHash(){
  const before=`${state.buyerView}|${state.ownerView}|${state.adminView}`;
  const target=workspaceHashMap[location.hash],role=target?.[0],view=target?.[1];
  if(!target){if(state.user?.role==='buyer'||(!state.user&&state.publicBrowse))state.buyerView='menu';if(state.user?.role==='owner')state.ownerView='dashboard';if(state.user?.role==='admin')state.adminView='overview'}
  else{
  if(role==='buyer'&&state.user?.role==='buyer')state.buyerView=view;
  else if(role==='buyer'&&!state.user&&state.publicBrowse)state.buyerView=view;
  if(role==='owner'&&state.user?.role==='owner')state.ownerView=view;
  if(role==='admin'&&state.user?.role==='admin')state.adminView=view;
  }
  return before!==`${state.buyerView}|${state.ownerView}|${state.adminView}`;
}
window.addEventListener('popstate',()=>{if((state.user||state.publicBrowse)&&applyWorkspaceHash())render()});
window.addEventListener('hashchange',()=>{if((state.user||state.publicBrowse)&&applyWorkspaceHash())render()});
function renderAuthWall(mode='front',role=state.authRole){
  if(mode==='login')mode='front';
  if(mode==='choose'||mode==='login-choose'){mode='front';role='owner'}
  if(mode==='signup')role='owner';
  state.authRole=role;
  accountTools();
  document.querySelector('#app')?.classList.add('auth-open');
  updateCartShortcut();
  const choosing=mode==='choose';
  const loginChoosing=mode==='login-choose';
  const frontLanding=mode==='front';
  const choosingRole=choosing||loginChoosing;
  const adminEntry=role==='admin';
  const frontCommunityBadge='<button type="button" class="auth-front-community" data-auth-mode="login" data-auth-role="'+(adminEntry?'buyer':'admin')+'" aria-label="'+(adminEntry?'Return to customer sign-in':'School administrator sign-in')+'"><img src="assets/palawan-national-school-logo.webp" alt=""><span><strong>Made for the PNS community</strong><small>Students · teachers · staff · stall owners</small></span></button>';
  const chooserSchoolBadge='<div class="chooser-school-badge"><img src="assets/palawan-national-school-logo.webp" alt=""><span><strong>Palawan National School</strong><small>Community food hub</small></span></div>';
  const masthead=`<div class="auth-masthead"><a class="brand auth-brand" href="#home" data-auth-mode="front" aria-label="BiteHub home"><img class="brand-mark auth-round-logo" src="assets/bitehub-icon.png?v=pns-palette-20261017" alt=""><img class="auth-wordmark" src="assets/bitehub-wordmark.png?v=pns-palette-20261017" alt="BiteHub"></a>${frontLanding?frontCommunityBadge:''}${choosingRole?chooserSchoolBadge:''}</div>`;
  const buyerArt=`<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M19 43h62l-5 39H24z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M31 42c2-13 9-20 19-20s17 7 19 20" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M33 57h34M38 67h24" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="50" cy="34" r="5" fill="#FAB2A4"/></svg>`;
  const ownerArt=`<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M20 42h60v39H20z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M16 42l8-20h52l8 20" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M17 42c0 7 11 9 16 2 4 7 13 7 17 0 4 7 13 7 17 0 5 7 16 5 16-2" fill="#FAB2A4" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M39 81V59h22v22M28 54h6m32 0h6" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  const adminArt=`<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M18 36l32-16 32 16v45H18z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M29 44h10v10H29zM45 44h10v10H45zM61 44h10v10H61zM29 61h10v10H29zM45 61h10v10H45zM61 61h10v10H61z" fill="#8ED0C2" stroke="currentColor" stroke-width="2"/><path d="M44 81V70h12v11" fill="none" stroke="currentColor" stroke-width="3"/></svg>`;
  const roleCard=({role,index,tag,title,description,art,cta})=>{
    const action=role==='buyer'?'data-action="continue-as-guest"':loginChoosing?('data-auth-mode="front" data-auth-role="'+role+'"'):(role==='admin'?('data-auth-mode="front" data-auth-role="'+role+'"'):('data-signup-role="'+role+'"'));
    return `<button class="role-choice role-${role}" ${action}><span class="role-card-top"><span class="role-kicker"><i>${index}</i>${tag}</span><span class="role-card-arrow" aria-hidden="true">→</span></span><span class="role-art">${art}</span><span class="role-copy"><strong>${title}</strong><small>${description}</small></span><span class="role-choice-action"><span>${cta}</span><b>→</b></span></button>`;
  };
  const roleCards=[
    {role:'owner',index:'01',tag:loginChoosing?'STALL OWNER':'SELL AT PNS',title:'Stall Owner',description:'Share your menu, manage orders, and serve the PNS community.',art:ownerArt,cta:loginChoosing?'Log in as stall owner':'Create a stall account'},
  ].map(roleCard).join('');
  const frontRoleOptions=[['owner',ownerArt,'Stall Owner','Sign in with your email and password']].map(function(item){
    const selected=role===item[0];
    return '<button type="button" class="front-role-choice role-'+item[0]+(selected?' is-selected':'')+'" data-front-role="'+item[0]+'" aria-pressed="'+selected+'" aria-label="'+item[2]+(selected?' selected':'')+'"><span class="front-role-icon">'+item[1]+'</span><span class="front-role-copy"><strong>'+item[2]+'</strong><small>'+item[3]+'</small></span><span class="front-role-arrow" aria-hidden="true">'+(selected?'✓':'→')+'</span></button>';
  }).join('');
  const frontRoleLanding='<div class="auth-front-layout'+(role==='admin'?' admin-login-open':'')+'"><section class="auth-front-copy"><span class="front-eyebrow">PALAWAN NATIONAL SCHOOL · CAMPUS FOOD MARKET</span><h1>Good food.<br><span>Better breaks.</span><i aria-hidden="true">✦</i></h1><p>Discover PNS stalls, browse their menus, and find a new favorite for your next school break.</p></section><section class="auth-card auth-front-card"><header class="auth-front-heading"><span class="front-sparkle" aria-hidden="true">✦</span><span class="eyebrow">YOUR PNS FOOD MARKET</span><h2>Welcome to BiteHub!</h2><p>Browse school stalls and order as a guest, or sign in to manage your stall.</p></header><div class="auth-front-role-heading"><strong>Continue as a guest</strong><small>Or sign in as a stall owner.</small></div><div class="auth-front-role-list" role="group" aria-label="Stall owner sign in">'+frontRoleOptions+'</div><div id="auth-form-slot"></div><div class="auth-front-secure"><span aria-hidden="true">▣</span><span>Secure sign in</span><i aria-hidden="true">·</i><span>PNS Food Hub</span></div></section></div>';
  const roleLanding=frontLanding?frontRoleLanding:choosingRole?`<section class="role-picker-panel" aria-labelledby="role-picker-title"><div class="role-path-heading"><div><span class="eyebrow">${loginChoosing?'SIGN IN':'PNS COMMUNITY'}</span><h2 id="role-picker-title">${loginChoosing?'Choose your workspace':'Choose your path'}</h2></div><p>${loginChoosing?'Select the account you use for BiteHub at PNS.':'Choose the space that fits you at PNS.'}</p></div><div class="role-card-grid">${roleCards}</div><p class="role-login">${loginChoosing?'New to BiteHub?':'Already have an account?'} <button class="text-button" data-auth-mode="${loginChoosing?'choose':'front'}">${loginChoosing?'Create an account':'Log in'}</button></p></section>`:`<header class="role-heading role-auth-heading"><span class="eyebrow">PNS FOOD HUB</span><h1>${mode==='login'?'Welcome back':'Join BiteHub'}</h1><p>${mode==='login'?'Log in to continue to your PNS workspace.':'Create an account for Palawan National School’s BiteHub.'}</p></header><section class="auth-card"><button class="text-button auth-back" data-auth-mode="choose">← Choose a role</button><div id="auth-form-slot"></div><p class="auth-footnote">Accounts, orders, and menus are saved to this server.</p></section>`;
   const frontTopAction=frontLanding?'<button class="front-signup-link" data-auth-mode="signup" data-auth-role="owner">Stall owner? <strong>Create account</strong><span aria-hidden="true">→</span></button>':'';
  const chooserBackAction=choosingRole?'<button type="button" class="chooser-back-link" data-auth-mode="front"><span aria-hidden="true">←</span> Back to front page</button>':'';
  root.innerHTML='<section class="role-home '+(frontLanding?'role-home--front':choosingRole?'role-home--chooser':'role-home--auth')+'">'+masthead+frontTopAction+chooserBackAction+roleLanding+'</section>';
  const authBack=$('.auth-back');
  if(authBack){authBack.dataset.authMode='front';authBack.dataset.authRole='owner';authBack.textContent='← Back to sign in'}
  if(frontLanding&&role==='buyer')renderGuestWelcome();
  else if(!choosingRole)renderAuthForm(frontLanding?'login':mode,role,frontLanding);
  if(frontLanding){
    const heading=$('.auth-front-heading h2'),intro=$('.auth-front-heading p');
    if(heading)heading.textContent=role==='admin'?'School admin sign in':role==='owner'?'Stall owner sign in':'Explore as a guest';
     if(intro)intro.textContent=role==='admin'?'Sign in to manage the PNS food marketplace.':role==='owner'?'Sign in to manage your stall and orders.':'Enter your name to browse PNS menus and order from a stall. No customer account needed.';
    if(role==='buyer'){
      const guestForm=$('#auth-form-slot .guest-entry-form');
      guestForm?.classList.remove('guest-welcome');
      guestForm?.querySelector('.eyebrow')?.remove();
      guestForm?.querySelector('h3')?.remove();
      guestForm?.querySelector('p')?.remove();
    }
    $('.auth-front-role-heading')?.remove();
    $('.auth-front-role-list')?.remove();
    const pathSwitch=document.createElement('button');
    pathSwitch.type='button';
    pathSwitch.className='auth-front-path-switch';
    pathSwitch.dataset.authMode='front';
    pathSwitch.dataset.authRole=role==='buyer'?'owner':'buyer';
    const pathLead=document.createElement('span');
    pathLead.textContent=role==='buyer'?'Stall owner?':'Just browsing?';
    const pathAction=document.createElement('strong');
    pathAction.textContent=role==='buyer'?'Sign in':'Continue as a guest';
    const pathArrow=document.createElement('span');
    pathArrow.setAttribute('aria-hidden','true');
    pathArrow.textContent='→';
    pathSwitch.append(pathLead,pathAction,pathArrow);
    $('#auth-form-slot')?.after(pathSwitch);
    const secureIcon=$('.auth-front-secure span:first-child'),secureLabel=$('.auth-front-secure span:nth-child(2)');
    if(secureIcon&&role==='buyer')secureIcon.textContent='✓';
    if(secureLabel)secureLabel.textContent=role==='buyer'?'No account needed':'Secure sign in';
  }
}
function renderGuestWelcome(){
  const slot=$('#auth-form-slot');if(!slot)return;
   slot.innerHTML=`<form class="guest-welcome guest-entry-form" data-form="guest-entry"><span class="eyebrow">QUICK · EASY · NO CUSTOMER ACCOUNT</span><h3>Ready for your next break?</h3><p>Enter your name to browse. BiteHub saves it in a temporary guest session; your order details are saved when you order.</p><label class="guest-name-field">Your name<input name="guest_name" maxlength="80" autocomplete="name" required value="${esc(state.guestName)}" placeholder="What name should we use?"></label><button type="submit" class="button button-primary button-wide">Browse stalls <span aria-hidden="true">→</span></button></form>`;
}
function renderAuthForm(mode,role=state.authRole,front=false){
  const slot=$('#auth-form-slot');if(!slot)return;
  const roleName=role==='owner'?'PNS stall owner':role==='runner'?'school runner':role==='admin'?'administrator':'PNS customer';
  const roleCopy=role==='owner'?'Set up your stall for the Palawan National School community.':role==='runner'?'Create your account to receive PNS deliveries.':role==='admin'?'Manage Palawan National School stalls and ordering.':'Browse PNS menus and follow your orders.';
  const loginCopy=role==='owner'?'Manage your PNS stall, menu, and incoming orders.':role==='runner'?'See assigned PNS runs and delivery details.':role==='admin'?'Manage Palawan National School stalls and ordering.':'Browse PNS menus and follow your orders.';
  if(mode==='signup'){
    const owner=role==='owner';
    const heading=owner?'Create your stall owner account':'Create your customer account';
    const details=owner?`<label>Stall name<input name="stall_name" maxlength="80" required placeholder="Your stall name"></label>`:`<label>Grade &amp; section <span class="field-hint">Optional · students only</span><input name="grade_section" maxlength="80" placeholder="e.g. Grade 12 - ABM Perseverance"></label>`;
    const community=owner?'For stall owners serving the PNS community.':'Students, teachers, staff, and other PNS community members can join.';
    slot.innerHTML=`<span class="eyebrow">${esc(roleName)}</span><h2>${heading}</h2><p class="form-intro">${esc(roleCopy)}</p><form class="stack-form signup-form" data-form="signup"><input type="hidden" name="role" value="${owner?'owner':'buyer'}"><section class="signup-person-section"><div class="signup-step-heading"><span>01</span><div><h3>Your account</h3><p>${community}</p></div></div><label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></label><label>Your name<input name="name" autocomplete="name" maxlength="80" required placeholder="Full name"></label><label>Password <span class="field-hint">At least 10 characters</span><input name="password" type="password" autocomplete="new-password" minlength="10" required></label>${details}<button class="button button-primary button-wide" type="submit">${owner?'Create stall account':'Create account'} <span>→</span></button><p class="auth-front-status" role="alert" aria-live="assertive"></p></section></form><p class="auth-switch">Already have an account? <button class="text-button" data-auth-mode="front">Log in</button></p>`;
    return;
  }
  if(front){
    const signInRole=role==='owner'?'Stall Owner':role==='admin'?'School Admin':'Customer';
    slot.innerHTML=`<form class="stack-form auth-front-form" data-form="login"><input type="hidden" name="role" value="${esc(role)}"><label>Email address<span class="front-input-wrap"><span aria-hidden="true">✉</span><input name="email" type="email" autocomplete="username" maxlength="254" required placeholder="you@example.com"></span></label><label>Password<span class="front-input-wrap"><span aria-hidden="true">▣</span><input name="password" type="password" autocomplete="current-password" required placeholder="Password"><button class="password-visibility" type="button" data-toggle-password aria-label="Show password" aria-pressed="false"><span aria-hidden="true">Show</span></button></span></label><button class="button button-primary button-wide" type="submit">Log in as ${signInRole} <span aria-hidden="true">→</span></button><p class="auth-front-status" role="alert" aria-live="assertive"></p><p class="auth-email-links-note">Email verification is not required. Password reset emails will be added later.</p></form>`;
    return;
  }
  slot.innerHTML='<span class="eyebrow">'+esc(roleName)+' workspace</span><h2>Welcome back.</h2><p class="form-intro">'+esc(loginCopy)+'</p><form class="stack-form" data-form="login"><label>Email address<input name="email" type="email" autocomplete="username" maxlength="254" required placeholder="you@example.com"></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="button button-primary button-wide">Log in <span>→</span></button></form><p class="auth-switch">New to BiteHub? <button class="text-button" data-auth-mode="choose">Choose your role</button></p>';
}
function heading(eyebrow,title,copy,side=''){
  return `<header class="page-heading"><div><span class="eyebrow">${esc(eyebrow)}</span><h1>${title}</h1><p>${esc(copy)}</p></div>${side}</header>`;
}
function workspaceNav(role,items,active=null){
  if(active)return `<nav class="workspace-nav workspace-tabs workspace-nav-${role}" aria-label="${esc(roleLabel[role]||'Workspace')} navigation">${items.map(([id,label,icon,count])=>`<button type="button" class="workspace-tab ${active===id?'is-active':''}" data-workspace-role="${role}" data-workspace-view="${id}" ${active===id?'aria-current="page"':''}><span aria-hidden="true">${icon}</span>${esc(label)}${count!==undefined?`<small>${count}</small>`:''}</button>`).join('')}</nav>`;
  return `<nav class="workspace-nav workspace-nav-${role}" aria-label="${esc(roleLabel[role]||'Workspace')} navigation">${items.map(([id,label,icon])=>`<a href="#${id}"><span aria-hidden="true">${icon}</span>${esc(label)}</a>`).join('')}</nav>`;
}
function stat(label,value,note,icon){return `<article class="stat-card"><span class="stat-icon">${icon}</span><small>${esc(label)}</small><strong>${esc(value)}</strong><span class="stat-note">${esc(note)}</span></article>`}
function orderCard(order){
  const userRole=state.user?.role||'guest',customerView=userRole==='buyer'||userRole==='guest';
  const itemText=order.items.map(i=>`${i.quantity} × ${esc(i.name)}`).join(' · ');
  const guestSchoolRoleNames={junior_student:'Junior high student',senior_student:'Senior high student',teacher:'Teacher',staff:'School staff'};
  const guestDeliveryDetails=['owner','admin','runner'].includes(userRole)?order.is_guest&&order.fulfillment==='delivery'?`<p class="order-subline guest-delivery-summary"><strong>Delivery for:</strong> ${esc(guestSchoolRoleNames[order.guest_school_role]||'School community member')}${order.guest_grade?` · Grade ${esc(order.guest_grade)}`:''}${order.guest_section?` · ${order.guest_school_role==='teacher'||order.guest_school_role==='staff'?'Office':'Section'}: ${esc(order.guest_section)}`:''}</p>`:'':'';
  const progressSteps=order.fulfillment==='delivery'?['placed','confirmed','preparing','ready','out','completed']:['placed','confirmed','preparing','ready','completed'];
  const progressNames=order.fulfillment==='delivery'?['Received','Accepted','Preparing','Ready','On the way','Delivered']:['Received','Accepted','Preparing','Ready','Picked up'];
  const progressIndex=progressSteps.indexOf(order.status);
  const progress=customerView&&order.status!=='declined'?`<ol class="order-progress" aria-label="Order progress: ${esc(statusLabel[order.status]||order.status)}">${progressSteps.map((step,index)=>`<li class="${index<progressIndex?'is-done':index===progressIndex?'is-current':''}" ${index===progressIndex?'aria-current="step"':''}><span>${index<progressIndex?'✓':index+1}</span><small>${progressNames[index]}</small></li>`).join('')}</ol>`:order.status==='declined'&&customerView?`<p class="order-declined" role="status">${order.pickup_offer_status==='declined'?'This order was cancelled because pickup at the stall did not work for you.':'This order was declined. Contact the stall if you need help.'}</p>`:'';
  const feedback=order.feedback?`<p class="order-feedback"><strong>Buyer feedback · ${'★'.repeat(order.feedback.rating)}${'☆'.repeat(5-order.feedback.rating)}</strong>${order.feedback.comment?`<span>${esc(order.feedback.comment)}</span>`:''}</p>`:'';
  const feedbackForm=userRole==='buyer'&&order.status==='completed'&&!order.feedback?`<form class="feedback-form" data-form="feedback" data-order-id="${order.id}"><label>Rate this order<select name="rating" required><option value="">Choose 1-5</option><option value="5">5 · Great</option><option value="4">4 · Good</option><option value="3">3 · Okay</option><option value="2">2 · Poor</option><option value="1">1 · Bad</option></select></label><label>Comment <span class="field-hint">Optional</span><input name="comment" maxlength="500" placeholder="Tell the stall what went well"></label><button class="button button-outline button-small">Send feedback</button></form>`:'';
  let actions='';
  if(userRole==='owner'){
    if(order.status==='placed')actions=`<button class="button button-primary button-small" data-order-action="confirm" data-id="${order.id}">Accept order</button><button class="button button-quiet button-small" data-order-action="decline" data-id="${order.id}">Decline</button>`;
    if(order.status==='confirmed')actions=`<button class="button button-primary button-small" data-order-action="prepare" data-id="${order.id}">Start preparing</button>`;
    if(order.status==='preparing')actions=`<button class="button button-primary button-small" data-order-action="ready" data-id="${order.id}">Mark ready</button>`;
    if(order.status==='ready'&&order.fulfillment==='delivery'&&order.pickup_offer_status!=='pending')actions=`<label class="assign-runner">Runner name<input type="text" maxlength="80" data-assign-runner="${order.id}" value="${esc(order.runner||'')}" placeholder="Type the runner’s name" autocomplete="name"><small class="field-hint">No runner account is needed.</small></label><button class="button button-primary button-small" data-order-action="assign" data-id="${order.id}">Assign runner</button>${order.runner?`<button class="button button-primary button-small" data-order-action="out" data-id="${order.id}">Mark on the way</button>`:''}<button class="button button-quiet button-small" data-order-action="offer-pickup" data-id="${order.id}">No runner? Offer pickup</button>`;
    if(order.status==='out'&&order.fulfillment==='delivery'){
      const runnerLink=state.runnerLinks[order.id];
      actions=`<div class="runner-share-tools"><button class="button button-outline button-small" data-order-action="runner-link" data-id="${order.id}">${runnerLink?'Create a fresh runner link':'Create runner GPS link'}</button>${runnerLink?`<label class="runner-link-field">Share this private link with ${esc(order.runner||'the runner')}<input data-runner-link-value="${order.id}" readonly value="${esc(runnerLink)}"></label><button class="button button-outline button-small" type="button" data-copy-runner-link="${order.id}">Copy runner link</button><small>Valid for 12 hours. They open it on their phone and tap Start. A fresh link replaces this one.</small>`:''}</div><button class="button button-primary button-small" data-order-action="delivered" data-id="${order.id}">Confirm delivered</button>`;
    }
  }
  if(userRole==='runner'){
    if(order.status==='ready')actions=`<button class="button button-primary button-small" data-order-action="out" data-id="${order.id}">Picked up</button>`;
    if(order.status==='out')actions=`<button class="button button-primary button-small" data-order-action="delivered" data-id="${order.id}">Mark delivered</button>`;
  }
  if(customerView&&order.pickup_offer_status!=='pending'&&order.status==='ready'&&order.fulfillment==='pickup')actions=`<button class="button button-primary button-small" data-order-action="collect" data-id="${order.id}">Confirm pickup</button>`;
  const estimate=order.estimated_ready_at&&['buyer','owner','guest'].includes(userRole)&&['confirmed','preparing'].includes(order.status)?`<p class="order-estimate">${Date.parse(order.estimated_ready_at)<Date.now()?'Estimated time passed · check with stall':`Estimated ready ${new Date(order.estimated_ready_at).toLocaleTimeString('en-PH',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit'})}`}</p>`:'';
  const pickupTime=order.pickup_at?new Date(order.pickup_at).toLocaleTimeString('en-PH',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit'}):null;
  const lastGpsTime=order.driver_updated_at?Date.parse(order.driver_updated_at):NaN;
  const gpsAge=Number.isFinite(lastGpsTime)?Math.max(0,Date.now()-lastGpsTime):Infinity;
  const gpsText=gpsAge<45000?'GPS updating now':gpsAge<180000?`Last GPS update ${Math.floor(gpsAge/60000)} min ago · may be delayed`:'GPS hasn’t updated recently · check with your runner';
  const eta=deliveryEta(order,gpsAge);
  const locationAccuracy=Number.isFinite(order.driver_accuracy)?`GPS accuracy ±${Math.round(order.driver_accuracy)} m`:'';
  const gpsUpdated=Number.isFinite(gpsAge)?gpsAge<60000?'Updated just now':`Updated ${Math.floor(gpsAge/60000)} min ago`:'';
  const trackingDestination=order.delivery_latitude!=null?{latitude:order.delivery_latitude,longitude:order.delivery_longitude}:null;
  const trackingOrigin=gpsAge<180000&&order.driver_latitude!=null?{latitude:order.driver_latitude,longitude:order.driver_longitude}:order.stall_latitude!=null?{latitude:order.stall_latitude,longitude:order.stall_longitude}:null;
  const trackingGoogleLink=trackingDestination?`<a class="button button-outline button-small map-google-link" href="${googleMapsRouteUrl(trackingOrigin,trackingDestination)}" target="_blank" rel="noopener noreferrer">${trackingOrigin?'Open walking route in Google Maps':'Open handoff point in Google Maps'} <span aria-hidden="true">↗</span></a>`:'';
  const tracking=(order.runner||order.runner_account)&&order.fulfillment==='delivery'&&order.status==='out'&&['buyer','runner','owner','guest'].includes(userRole)?`<section class="tracking-panel"><div><strong>${userRole==='runner'?(gpsAge<45000?'Sharing your live location':gpsAge===Infinity?'Waiting for GPS fix':gpsText):gpsAge===Infinity?'Waiting for runner location':gpsText}</strong><small>Runner: ${esc(order.runner||'Assigned runner')} · GPS refreshes about every five seconds while sharing is active.</small>${eta?`<p class="tracking-eta">${eta}</p>`:''}${locationAccuracy||gpsUpdated?`<small class="tracking-meta">${[locationAccuracy,gpsUpdated].filter(Boolean).join(' · ')}</small>`:''}</div>${campusMap(order)}<small class="map-attribution">PNS campus map data © Overture Maps Foundation, Meta/WRI, and OpenGeoHub · GPS accuracy varies.</small><small class="map-key"><i class="map-key-runner"></i>Runner <i class="map-key-destination"></i>Handoff <i class="map-key-stall"></i>Stall</small>${trackingGoogleLink}<small class="tracking-note">Blue line follows the PNS campus walking paths. GPS may pause indoors or when the runner closes the sharing page.</small></section>`:'';
  const pickupOffer=customerView&&order.pickup_offer_status==='pending'&&order.status==='ready'?`<section class="pickup-offer" aria-label="Pickup option"><span class="eyebrow">DELIVERY UPDATE</span><h4>No runner is available</h4><p>Would you like to keep your order and pick it up at <strong>${esc(order.stall)}</strong>, or cancel it?</p><div class="pickup-offer-actions"><button class="button button-primary button-small" data-order-action="accept-pickup" data-id="${order.id}">Continue with pickup</button><button class="button button-quiet button-small" data-order-action="cancel-no-runner" data-id="${order.id}">Cancel order</button></div></section>`:'';
  const ownerPickupOffer=userRole==='owner'&&order.pickup_offer_status==='pending'?`<p class="pickup-offer-wait" role="status">Waiting for the customer to choose pickup or cancellation.</p>`:'';
  return `<article class="order-card"><div class="order-card-top"><div><span class="order-number">ORDER #${order.id} · ${new Date(order.created_at).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}</span><h3>${esc(order.stall)}</h3></div><span class="status-badge status-${esc(order.status)}">${esc(statusLabel[order.status]||order.status)}</span></div>${progress}<div class="order-card-body"><div><p class="order-items-summary">${itemText}</p><p class="order-subline">${order.fulfillment==='delivery'?'School delivery only':pickupTime?`Pickup · ${pickupTime}`:'Pickup'}${order.runner?` · Runner: ${esc(order.runner)}`:''}${order.buyer_note?` · “${esc(order.buyer_note)}”`:''}</p>${!customerView?`<p class="order-subline">Placed by ${esc(order.buyer)}${order.buyer_email?` · ${esc(order.buyer_email)}`:''}</p>`:''}${guestDeliveryDetails}</div><strong class="order-total">${money(order.total)}</strong></div>${order.is_guest&&customerView?`<p class="guest-pickup-code"><span>${order.fulfillment==='pickup'?'Pickup code':'Order code'}</span><strong>${esc(order.pickup_code)}</strong></p>`:''}${pickupOffer}${ownerPickupOffer}${tracking}${estimate}${actions?`<div class="order-actions">${actions}</div>`:''}${feedback}${feedbackForm}</article>`;
}
function emptyState(icon,title,copy){return `<div class="empty-state"><span>${icon}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>`}
function buyerHeroArt(item){
  const items=buyerHeroItems();
  if(items.length){state.heroFeaturedIndex=((state.heroFeaturedIndex%items.length)+items.length)%items.length;if(item===undefined)item=items[state.heroFeaturedIndex]}
  else item=null;
  if(!item)return `<span class="banner-art-stamp">FRESH · LOCAL · YOURS</span>${buyerHeroFallbackArt()}<i class="banner-art-sparkle">✦</i><b>MADE FOR<br>YOUR BREAK</b>`;
  const total=items.length,index=state.heroFeaturedIndex+1;
  const food=item.photo_url?`<img src="${esc(item.photo_url)}" alt="" loading="eager" decoding="async">`:`<span aria-hidden="true">${esc(item.emoji||'🍽️')}</span>`;
  const stallMark=item.stall_logo_url?`<img src="${esc(item.stall_logo_url)}" alt="">`:`<i aria-hidden="true">${esc(item.stall_name.trim().charAt(0).toUpperCase())}</i>`;
  return `<span class="banner-art-stamp">${total>1?`PNS STALL PICK · ${String(index).padStart(2,'0')} / ${String(total).padStart(2,'0')}`:'PNS STALL PICK'}</span><div class="banner-featured-food" role="img" aria-label="${esc(item.name)} from ${esc(item.stall_name)}">${food}</div><span class="banner-featured-note"><span class="banner-featured-owner">${stallMark}<span><small>MADE AT</small><b>${esc(item.stall_name)}</b></span></span><strong class="banner-featured-name">${esc(item.name)}</strong><span class="banner-featured-price">${money(item.price)}</span></span>`;
}
function buyerHeroFallbackArt(){return `<svg class="banner-food-illustration" viewBox="0 0 520 420" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><ellipse cx="260" cy="316" rx="168" ry="28" fill="#21133e" opacity=".24"/><ellipse cx="260" cy="286" rx="171" ry="43" fill="#fff8e9"/><ellipse cx="260" cy="283" rx="134" ry="26" fill="#ffd45a"/><path d="M146 228h228l-25 92c-5 19-42 31-89 31s-84-12-89-31l-25-92Z" fill="#56339b"/><path d="M165 251h190l-17 61c-15 11-43 17-78 17s-63-6-78-17l-17-61Z" fill="#704bb8"/><path d="M135 222c0-10 8-18 18-18h214c10 0 18 8 18 18s-8 17-18 17H153c-10 0-18-7-18-17Z" fill="#a98bf4"/><path d="M153 219h214" stroke="#fff8e9" stroke-width="7" stroke-linecap="round"/><path d="m307 188 25-70c2-7 11-8 15-1l22 59-15 43-47-31Z" fill="#f4b63e" stroke="#fff8e9" stroke-width="7" stroke-linejoin="round"/><path d="m320 185 20-55" stroke="#fff8e9" stroke-width="6" stroke-linecap="round"/><path d="M317 198c12 5 25 5 38 0" stroke="#c95749" stroke-width="7" stroke-linecap="round"/><path d="m294 202-12-67c-1-7 7-11 12-5l23 26-23 46Z" fill="#f7cd54" stroke="#fff8e9" stroke-width="6" stroke-linejoin="round"/><path d="m279 201-8-52c-1-7 7-11 12-5l19 20-23 37Z" fill="#ee8b31" stroke="#fff8e9" stroke-width="6" stroke-linejoin="round"/><path d="M162 190c4-38 31-66 68-66h22c33 0 60 24 63 60l-10 22H170l-8-16Z" fill="#f39b31" stroke="#fff8e9" stroke-width="7" stroke-linejoin="round"/><ellipse cx="210" cy="148" rx="4" ry="6" transform="rotate(24 210 148)" fill="#fff8e9"/><ellipse cx="234" cy="138" rx="4" ry="6" transform="rotate(24 234 138)" fill="#fff8e9"/><ellipse cx="257" cy="148" rx="4" ry="6" transform="rotate(24 257 148)" fill="#fff8e9"/><ellipse cx="197" cy="170" rx="4" ry="6" transform="rotate(24 197 170)" fill="#fff8e9"/><ellipse cx="242" cy="166" rx="4" ry="6" transform="rotate(24 242 166)" fill="#fff8e9"/><path d="M170 190c18 11 35-8 53 0s35-8 53 0 29-5 39-12v21H171l-1-9Z" fill="#69bc79"/><path d="M171 196c18 10 36-8 54 0s36-8 54 0 27-4 36-10l6 17c-20 10-42 13-64 12l-77-5-9-14Z" fill="#57329b" stroke="#fff8e9" stroke-width="6" stroke-linejoin="round"/><path d="M184 216c24 11 48 11 72 4s45-7 66 1" stroke="#e9822d" stroke-width="8" stroke-linecap="round"/><path d="M207 284h106m-84 19h62" stroke="#d8c6ff" stroke-width="8" stroke-linecap="round" opacity=".8"/><path d="M100 111v28m-14-14h28m294 150v21m-10-10h20" stroke="#ffe178" stroke-width="5" stroke-linecap="round"/></svg>`}
function setBuyerHeroFeature(index){
  const items=buyerHeroItems();
  if(!items.length)return;
  const count=items.length;
  state.heroFeaturedIndex=((index%count)+count)%count;
  const art=$('.buyer-banner .banner-art');
  if(art)art.innerHTML=buyerHeroArt(items[state.heroFeaturedIndex]);
}
function renderBuyer(){
  const q=state.query.trim().toLowerCase();
  const products=state.products.filter(p=>(state.filter==='All'||p.category===state.filter)&&(state.stallFilter==='All'||p.stall_id===Number(state.stallFilter))&&(state.dietaryFilter==='All'||p.dietary_tags.includes(state.dietaryFilter))&&(state.allergenFilter==='All'||!p.allergen_tags.includes(state.allergenFilter))&&(!q||`${p.name} ${p.stall_name} ${p.category} ${p.description} ${p.dietary_tags.join(' ')} ${p.allergen_tags.join(' ')}`.toLowerCase().includes(q)));
  if(state.sort==='price-low')products.sort((a,b)=>a.price-b.price);
  if(state.sort==='price-high')products.sort((a,b)=>b.price-a.price);
  if(state.sort==='name')products.sort((a,b)=>a.name.localeCompare(b.name));
  const categories=['All',...new Set(state.products.map(p=>p.category))];
  const ordersView=(state.user?.role==='buyer'||(!state.user&&state.publicBrowse))&&state.buyerView==='orders';
  const orderCount=state.orders.filter(order=>!['completed','declined'].includes(order.status)).length;
  const buyerNavigation=workspaceNav('buyer',state.user?.role==='buyer'||(!state.user&&state.publicBrowse)?[['menu','Browse food','⌕'],['orders','My orders','↗',orderCount]]:[['menu','Browse food','⌕']],ordersView?'orders':'menu');
  if(ordersView){root.innerHTML=`${buyerNavigation}<section class="workspace-page customer-orders-page" id="buyer-orders"><div class="section-title"><div><span class="eyebrow">YOUR RECENT ACTIVITY</span><h2>Order updates</h2><p class="helper-text">Check progress, pickup details, and feedback for your PNS orders.</p></div><span class="result-count">${state.orders.length} ${state.orders.length===1?'order':'orders'}</span></div>${state.orders.length?`<div class="order-list">${state.orders.slice(0,12).map(orderCard).join('')}</div>`:emptyState('↗','Your first order starts here','Browse the menu and place an order. Its progress will appear here.')}</section>`;return}
  const heroRotates=buyerHeroItems().length>1;
  const activeFilterCount=[state.filter!=='All',state.stallFilter!=='All',state.dietaryFilter!=='All',state.allergenFilter!=='All',state.sort!=='featured'].filter(Boolean).length;
  root.innerHTML=`<section class="buyer-banner" aria-labelledby="buyer-banner-title"><div class="buyer-banner-copy"><span class="eyebrow">THE PNS CAMPUS MARKET</span><h2 id="buyer-banner-title">Fresh finds,<br><span>happy breaks.</span></h2><p>Wander through campus stalls and discover something delicious.</p><div class="buyer-banner-cycle-cue ${heroRotates?'is-rotating':'is-waiting'}"><i aria-hidden="true"></i><span>${heroRotates?'New PNS stall pick every 10 seconds':'More PNS picks appear as stalls add menu items'}</span></div></div><div class="banner-art" role="group" aria-roledescription="automatic food showcase" aria-label="Featured food from PNS school stalls">${buyerHeroArt()}</div></section>${buyerNavigation}${renderFeaturedPicks()}
  <section class="section-block customer-menu-page" id="menu"><div class="section-title"><div><span class="eyebrow">MARKET MENU</span><h2>Find your next favorite</h2></div><div class="menu-search-tools"><label class="search-field"><span aria-hidden="true">⌕</span><input type="search" id="menu-search" value="${esc(state.query)}" placeholder="Dish, stall, or craving" aria-label="Search menu"></label><button type="button" class="menu-filter-toggle" data-action="toggle-menu-filters" aria-controls="menu-filter-panel" aria-expanded="${state.filterPanelOpen}"><span aria-hidden="true">☷</span><span>Filters &amp; sort</span>${activeFilterCount?`<small>${activeFilterCount}</small>`:''}</button></div></div><div class="menu-controls"><div class="menu-filter-panel" id="menu-filter-panel" ${state.filterPanelOpen?'':'hidden'}><div class="filter-row" role="group" aria-label="Filter menu by category">${categories.map(c=>`<button class="filter-chip ${state.filter===c?'is-active':''}" data-filter="${esc(c)}" aria-pressed="${state.filter===c}">${esc(c)}</button>`).join('')}</div><label class="sort-field">Sort<select id="menu-sort"><option value="featured" ${state.sort==='featured'?'selected':''}>Featured</option><option value="price-low" ${state.sort==='price-low'?'selected':''}>Price: low to high</option><option value="price-high" ${state.sort==='price-high'?'selected':''}>Price: high to low</option><option value="name" ${state.sort==='name'?'selected':''}>Name</option></select></label><div class="catalog-filter-options"></div><small class="allergen-disclaimer">Allergen details are stall-provided; confirm directly when needed.</small><div class="menu-filter-summary"><span class="result-count" role="status" aria-live="polite">${products.length} ${products.length===1?'item':'items'}</span><button type="button" class="menu-filter-clear" data-action="clear-menu-filters" ${activeFilterCount?'':'hidden'}>Clear filters</button></div></div></div><div class="product-grid">${products.length?products.map(p=>`<article class="product-card"><button class="product-art product-art-trigger" data-product-details="${p.id}" aria-label="View details for ${esc(p.name)}"><span>${esc(p.emoji)}</span><small>${esc(p.category)}</small></button><div class="product-details"><div class="product-stall">${esc(p.stall_name)}</div><button class="product-name-trigger" data-product-details="${p.id}"><h3>${esc(p.name)}</h3></button><p>${esc(p.description||'Fresh from the stall, ready for your break.')}</p><div class="product-bottom"><strong>${money(p.price)}</strong><button class="button button-primary button-small" data-add="${p.id}" ${state.paused?'disabled':''}>${state.paused?'Paused':'Add +'}</button></div></div></article>`).join(''):state.products.length===0?emptyState('⌂','No PNS menus yet','Stall owners can create an account and publish a menu. New items will appear here automatically.'):emptyState('⌕','No menu items found','Try another search or category.')}</div></section>`;
}
function renderBuyerView(){renderBuyer();const menu=$('#menu'),buyerNav=$('.workspace-nav-buyer'),categories=$('.market-category-section');if(categories&&buyerNav)buyerNav.after(categories);if(menu&&categories)categories.after(menu);else if(menu&&buyerNav)buyerNav.after(menu);addCatalogControls();decorateProductCards();const rail=$('.featured-rail');if(rail)rail.scrollLeft=state.featuredScroll;startFeaturedMotion()}
function renderOwnerHoursPanel(){
  const opens=state.user.stall_opens_at||'00:00',closes=state.user.stall_closes_at||'23:59';
  const prep=state.user.stall_prep_minutes||15;
  return `<section class="panel stall-hours-panel"><div><span class="eyebrow">YOUR HOURS · PHILIPPINE TIME</span><h2>Opening hours</h2><p>Choose when customers can place orders. Your stall pauses automatically outside these hours.</p></div><form class="stall-hours-form" data-form="stall-hours"><label>Opens<input name="opens_at" type="time" required value="${esc(opens)}"></label><span class="hours-range-separator" aria-hidden="true">to</span><label>Closes<input name="closes_at" type="time" required value="${esc(closes)}"></label><label>Prep time (minutes)<input name="prep_minutes" type="number" min="1" max="180" step="1" required value="${prep}"></label><button class="button button-outline button-small">Save hours</button></form></section>`;
}
function renderOwnerProfilePanel(){
  const logo=state.user.stall_logo_url;
  return `<section class="panel stall-profile-editor"><div class="stall-profile-intro"><span class="eyebrow">YOUR PUBLIC STALL PAGE</span><h2>Your stall profile</h2><p>Set your stall name, add a short welcome, and upload a logo customers will recognize.</p><div class="owner-stall-preview"><span class="stall-mini-logo">${logo?`<img src="${esc(logo)}" alt="">`:esc((state.user.stall_name||'S').trim().charAt(0).toUpperCase())}</span><strong>${esc(state.user.stall_name||'Your stall')}</strong><small>Preview of your public profile</small><button type="button" class="button button-outline button-small" data-action="share-stall" data-stall-id="${state.user.stall_id}">Share stall link</button></div></div><div class="owner-profile-forms"><form class="stack-form" data-form="stall-profile"><label>Stall name<input name="name" maxlength="80" required value="${esc(state.user.stall_name||'')}"></label><label>About your shop<textarea name="description" maxlength="500" rows="4" placeholder="Tell customers what you serve and what makes your stall special">${esc(state.user.stall_description||'')}</textarea><small class="field-hint">A short introduction customers see on your stall page.</small></label><button class="button button-outline button-small">Save stall details</button></form><form class="stack-form stall-logo-form" data-form="stall-logo"><label>Shop logo <span class="field-hint">Choose a JPG, PNG, or WebP image (up to 2 MB).</span><input name="logo_file" type="file" accept="image/jpeg,image/png,image/webp"></label><div class="stall-logo-preview"><img ${logo?`src="${esc(logo)}"`:''} alt="Stall logo preview" ${logo?'':'hidden'}><span ${logo?'hidden':''}>Your logo preview</span></div>${logo?'<label class="photo-remove"><input name="remove_logo" type="checkbox" value="true"><span>Remove current logo</span></label>':''}<button class="button button-primary button-small">Save shop logo</button></form></div></section>`;
}
async function renderStallProfile(id){
  const stall=await api(`/api/stalls/${Number(id)}`);
  if(!(state.user?.role==='owner'&&state.user.stall_id===stall.id)&&state.user?.role!=='admin')recordReachView(stall.id);
  const logo=stall.logo_url?`<img src="${esc(stall.logo_url)}" alt="${esc(stall.name)} logo">`:`<span>${esc(stall.name.trim().charAt(0).toUpperCase())}</span>`;
  $('#stall-content').innerHTML=`<form method="dialog" class="modal-dismiss"><button class="icon-button" aria-label="Close stall profile">×</button></form><header class="stall-social-header"><div class="stall-cover-art"><span>PALAWAN NATIONAL SCHOOL - STALL</span></div><div class="stall-social-identity"><div class="stall-profile-avatar">${logo}</div><div class="stall-social-title"><h2>${esc(stall.name)}</h2><p>${esc(stall.owner_name||'Campus stall owner')} · ${stall.menu_count} menu ${stall.menu_count===1?'item':'items'}</p>${stall.rating?`<span class="stall-rating">★ ${Number(stall.rating).toFixed(1)} <small>from ${stall.review_count} verified order ${stall.review_count===1?'review':'reviews'}</small></span>`:'<small class="stall-rating-new">New campus stall</small>'}</div><span class="stall-open-badge ${stall.is_open?'is-open':''}"><i></i>${stall.is_open?'Open now':'Closed'}</span></div></header><section class="stall-about-card"><span class="eyebrow">ABOUT THIS STALL</span><p class="stall-profile-description">${esc(stall.description||'Welcome! We are serving fresh breaks at your school.')}</p><div class="stall-profile-facts"><span><small>HOURS</small><strong>${esc(stall.opens_at)}–${esc(stall.closes_at)}</strong></span><span><small>MENU</small><strong>${stall.menu_count} ${stall.menu_count===1?'item':'items'}</strong></span><span><small>LOCATION</small><strong>Your school</strong></span></div></section><section class="stall-profile-menu"><div class="stall-menu-heading"><div><span class="eyebrow">FROM THE KITCHEN</span><h3>Explore the menu</h3></div><span class="stall-menu-count">${stall.menu_count} ${stall.menu_count===1?'choice':'choices'}</span></div>${stall.products.length?`<div class="stall-menu-grid">${stall.products.map((item,index)=>`<article class="stall-menu-item" style="--menu-index:${index}"><button class="stall-menu-photo" data-product-details="${item.id}" aria-label="View details for ${esc(item.name)}">${item.photo_url?`<img src="${esc(item.photo_url)}" alt="Photo of ${esc(item.name)}" loading="lazy">`:`<span aria-hidden="true">${esc(item.emoji)}</span>`}<small>${esc(item.category)}</small></button><div class="stall-menu-copy"><button class="stall-product-title" data-product-details="${item.id}">${esc(item.name)}</button><small>${esc(item.description||'Freshly made for your break.')}</small><div><b>${money(item.price)}</b><button class="button button-primary button-small" data-add="${item.id}" ${state.paused||!stall.is_open||item.stock_count===0?'disabled':''}>${item.stock_count===0?'Sold out':'Add +'}</button></div></div></article>`).join('')}</div>`:emptyState('⌂','No menu items available','This stall has not published any available items.')}</section>`;
  const shareButton=document.createElement('button');shareButton.type='button';shareButton.className='button button-outline button-small stall-share-button';shareButton.dataset.action='share-stall';shareButton.dataset.stallId=String(stall.id);shareButton.textContent='Share this stall';
  $('#stall-content .stall-about-card').append(shareButton);
  if(!$('#stall-dialog').open)$('#stall-dialog').showModal();
}
function recordReachView(stallId,productId=null){
  if(!recordReachView.viewerReady){
    recordReachView.viewerReady=api('/api/reach-viewer').then(()=>true).catch(error=>{recordReachView.viewerReady=null;throw error});
  }
  recordReachView.viewerReady.then(()=>api('/api/reach-views',{method:'POST',body:json({stall_id:Number(stallId),product_id:productId==null?null:Number(productId)})})).catch(()=>{});
}
function stallShareUrl(id){const url=new URL('/',location.origin);url.searchParams.set('stall',String(Number(id)));return url.href}
async function openSharedStall(){
  const id=new URLSearchParams(location.search).get('stall');
  if(!/^\d+$/.test(id||'')||state.user&&state.user.role!=='buyer')return;
  try{await renderStallProfile(id)}catch(error){toast(`This shared stall is unavailable. ${error.message}`)}
}
function renderOwner(){
  const active=state.orders.filter(o=>!['completed','declined'].includes(o.status));
  const completed=state.orders.filter(o=>o.status==='completed').reduce((s,o)=>s+o.total,0);
  const feedback=state.orders.filter(o=>o.feedback).slice(0,8);
  const items=state.products.filter(p=>p.stall_id===state.user.stall_id),view=state.ownerView||'dashboard';
  const tabs=[['dashboard','Today','◷'],['orders','Orders','↗',active.length],['menu','Menu','▦',items.length],['stall','Stall setup','⌂'],['insights','Insights','◉']];
  let page='';
  if(view==='dashboard')page=`${renderOwnerOrders(active.slice(0,4),active.length,true)}<section class="stats-grid owner-stats">${stat('Open orders',active.length,'Ready for your attention','↗')}${stat('Completed order value',money(completed),'Completed orders only','₱')}${stat('Menu items',items.length,'Available to customers','▦')}</section>`;
  if(view==='orders')page=renderOwnerOrders(active,active.length,false);
  if(view==='menu')page=renderOwnerMenu(items);
  if(view==='stall')page=`<div class="owner-settings-grid workspace-page" id="owner-stall">${renderOwnerProfilePanel()}${renderOwnerHoursPanel()}</div>`;
  if(view==='insights')page=`<div class="workspace-page">${renderOwnerReach()}<section class="panel owner-feedback" id="owner-feedback"><div class="section-title"><div><span class="eyebrow">HEAR FROM YOUR CUSTOMERS</span><h2>Recent feedback</h2></div><span class="result-count">${feedback.length} reviews</span></div>${feedback.length?`<div class="feedback-list">${feedback.map(order=>`<article class="feedback-entry"><div><strong>Order #${order.id} · ${esc(order.buyer)}</strong><small>${new Date(order.created_at).toLocaleDateString()}</small></div><span class="feedback-stars">${'★'.repeat(order.feedback.rating)}${'☆'.repeat(5-order.feedback.rating)}</span>${order.feedback.comment?`<p>${esc(order.feedback.comment)}</p>`:'<p class="muted-feedback">No written comment.</p>'}</article>`).join('')}</div>`:emptyState('★','No customer feedback yet','Reviews arrive here after completed orders.')}</section></div>`;
  root.innerHTML=`${heading('YOUR MARKET STALL',`Welcome, ${esc(state.user.name.split(' ')[0])}.`,'Manage your menu, orders, and stall details in one place.',`<span class="live-pill"><i></i>Owner account</span>`)}${workspaceNav('owner',tabs,view)}<main class="workspace-content owner-workspace-content" id="owner-workspace">${page}</main>`;
  root.querySelectorAll('.inventory-item').forEach(item=>{const id=Number(item.querySelector('[data-edit-product]')?.dataset.editProduct),product=state.products.find(entry=>entry.id===id);if(product?.photo_url){const art=item.querySelector('.inventory-emoji');if(art)art.innerHTML=`<img src="${esc(product.photo_url)}" alt="">`}});
}
function renderOwnerOrders(orders,total,preview){
  return `<section class="panel owner-order-queue workspace-page" id="owner-orders"><div class="section-title"><div><span class="eyebrow">ORDER QUEUE</span><h2>${preview?'Incoming orders':'Active orders'}</h2><p class="helper-text">New orders appear at the top. Update each one as you prepare it.</p></div><span class="result-count">${total} active</span></div>${orders.length?`<div class="order-list">${orders.map(orderCard).join('')}</div>`:emptyState('✓','All caught up','New orders will appear here.')}${preview&&total>orders.length?`<button type="button" class="button button-outline owner-view-all" data-workspace-role="owner" data-workspace-view="orders">View all ${total} active orders <span>→</span></button>`:''}</section>`;
}
function renderOwnerMenu(items){
  return `<section class="panel menu-manager owner-menu-page workspace-page" id="owner-menu"><div class="section-title"><div><span class="eyebrow">YOUR STALL</span><h2>Menu management</h2><p class="helper-text">Update availability or feature one item for 24 hours.</p></div><span class="result-count">${items.length} items</span></div><div class="inventory-list">${items.map(p=>`<article class="inventory-item"><span class="inventory-emoji">${esc(p.emoji)}</span><div class="inventory-copy"><strong>${esc(p.name)}</strong><small>${money(p.price)} · ${esc(p.category)}${p.featured?' · Featured now':''}</small></div><button class="button button-outline button-small" data-edit-product="${p.id}">Edit</button><label class="availability-toggle"><input type="checkbox" data-availability="${p.id}" ${p.available?'checked':''}><span>${p.available?'In menu':'Unavailable'}</span></label><button class="icon-button delete-product" data-delete-product="${p.id}" aria-label="Remove ${esc(p.name)}">×</button><button type="button" class="feature-product-button ${p.featured?'is-featured':''}" data-feature-product="${p.id}" data-feature-active="${p.featured}" ${!p.available?'disabled':''}>${p.featured?'Unfeature item':`✦ Feature for 24 hours`}</button></article>`).join('')||`<p class="helper-text">Your menu is empty. Add an item below to get started.</p>`}</div><details class="product-add-panel"><summary><span>Add a menu item</span><small>Open the short form to publish a new dish</small></summary><form class="stack-form product-form" data-form="product"><div class="form-split"><label>Item name<input name="name" maxlength="80" required placeholder="e.g. Chicken rice bowl"></label><label>Price<input name="price" type="number" min="0.01" max="1000000" step="0.01" required placeholder="₱ 0.00"></label></div><div class="form-split"><label>Category<select name="category"><option>Meals</option><option>Snacks</option><option>Drinks</option></select></label><label>Food icon<select name="emoji"><option>🍽️</option><option>🍚</option><option>🍜</option><option>🥪</option><option>🥗</option><option>🍰</option><option>🧋</option><option>🍟</option><option>🍗</option></select></label></div><label>Description <span class="field-hint">Optional</span><input name="description" maxlength="240" placeholder="What makes it special?"></label><details class="product-extra-fields"><summary>More details · ingredients, photo, stock, and food labels</summary><label>Ingredients <span class="field-hint">Optional · add a comma-separated list</span><textarea name="ingredients" maxlength="700" rows="2" placeholder="Chicken, rice, garlic, soy sauce"></textarea></label></details><button class="button button-primary">Add to menu <span>+</span></button></form></details></section>`;
}
function renderOwnerReach(){
  const reach=state.reachAnalytics||{stall_views:{total:0,last_7_days:0},products:[]};
  return `<section class="panel owner-reach" id="owner-insights"><div class="section-title"><div><span class="eyebrow">CUSTOMER REACH</span><h2>Views and orders</h2><p class="helper-text">Anonymous views count once per browser, per stall or item each day. Order counts exclude declines.</p></div><span class="result-count">Last 7 days</span></div><div class="reach-summary"><article><small>Stall page views · all time</small><strong>${reach.stall_views.total}</strong></article><article><small>Stall page views · 7 days</small><strong>${reach.stall_views.last_7_days}</strong></article></div>${reach.products.length?`<div class="reach-table-wrap"><table class="reach-table"><thead><tr><th scope="col">Menu item</th><th scope="col">Detail views · 7 days</th><th scope="col">Detail views · all time</th><th scope="col">Orders</th><th scope="col">Units</th></tr></thead><tbody>${reach.products.map(item=>`<tr><th scope="row">${esc(item.name)}</th><td>${item.views_7_days}</td><td>${item.views_total}</td><td>${item.order_count}</td><td>${item.units_ordered}</td></tr>`).join('')}</tbody></table></div>`:emptyState('⌕','No menu reach data yet','Views and orders will appear here as customers explore your stall.')}</section>`;
}
function renderRunner(){
  const active=state.orders.filter(o=>!['completed','declined'].includes(o.status));
  const delivered=state.orders.filter(o=>o.status==='completed').length;
  root.innerHTML=`${heading('CAMPUS RUNNER WORKSPACE','Every handoff, in sync.','Your assigned school deliveries, from stall pickup to buyer handoff.',`<span class="live-pill"><i></i>Runner account</span>`)}${workspaceNav('runner',[['runner-summary','Today','◷'],['runner-queue','Delivery queue','↗']])}<section class="stats-grid" id="runner-summary">${stat('Active deliveries',active.length,'Assigned to you','↗')}${stat('Delivered',delivered,'Completed handoffs','✓')}${stat('Next up',active[0]?.status==='ready'?'Pick up':'—',active[0]?.stall||'No pending pickup','⌖')}</section><section class="panel" id="runner-queue"><div class="section-title"><div><span class="eyebrow">YOUR DELIVERY QUEUE</span><h2>Assigned runs</h2></div><span class="result-count">${active.length} active</span></div>${active.length?`<div class="order-list">${active.map(orderCard).join('')}</div>`:emptyState('⌖','No assigned deliveries','When a stall assigns you an order, it will appear here.')}</section>`;
  ensureLocationSharing();
}
function ensureLocationSharing(){
  if(state.user?.role!=='runner')return;
  const active=state.orders.some(order=>order.status==='out'&&order.fulfillment==='delivery');
  if(!active&&state.trackingWatch!==null){navigator.geolocation?.clearWatch(state.trackingWatch);state.trackingWatch=null;return}
  if(!active||state.trackingWatch!==null)return;
   if(!window.isSecureContext||!navigator.geolocation){toast('Live tracking needs HTTPS and location permission.');return}
  state.trackingWatch=navigator.geolocation.watchPosition(async position=>{
     const now=Date.now();if(now-state.lastLocationSent<5000)return;state.lastLocationSent=now;
    const orders=state.orders.filter(item=>item.status==='out'&&item.fulfillment==='delivery');if(!orders.length)return;
    const body=json({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:Math.min(position.coords.accuracy||0,1000),heading:Number.isFinite(position.coords.heading)?position.coords.heading:null});
    try{await Promise.all(orders.map(order=>api(`/api/orders/${order.id}/location`,{method:'POST',body})))}
    catch(error){toast(`Location update failed: ${error.message}`)}
  },error=>{toast(error.code===1?'Allow location access to share your delivery progress.':'Could not read your location. Check GPS and try again.');navigator.geolocation.clearWatch(state.trackingWatch);state.trackingWatch=null},{enableHighAccuracy:true,maximumAge:0,timeout:15000});
}
function renderAdmin(){
  const totals=state.overview||{users:{},stalls:0,products:0,orders:[],ordering_paused:state.paused};
  const amount=totals.orders.filter(order=>order.status==='completed').reduce((sum,order)=>sum+order.sales,0)/100;
  const view=state.adminView||'overview',tabs=[['overview','Overview','◷'],['stalls','Stalls','⌂',totals.stalls],['orders','Orders','▣',state.orders.length],['reports','Reports','▤'],['accounts','Accounts','◎']];
  const overview=`<section class="stats-grid admin-stats" id="admin-overview">${stat('Campus accounts',Object.values(totals.users).reduce((a,b)=>a+b,0),'Across all account types','◎')}${stat('Campus stalls',totals.stalls,'Registered stall owners','⌂')}${stat('Menu items',totals.products,'Listed on the hub','▦')}${stat('Completed order value',money(amount),'Value of completed orders','₱')}</section><div class="admin-overview-grid"><section class="panel admin-recent-orders"><div class="section-title"><div><span class="eyebrow">CAMPUS ACTIVITY</span><h2>Recent orders</h2></div><button type="button" class="text-button" data-workspace-role="admin" data-workspace-view="orders">View all →</button></div>${state.orders.length?`<div class="order-list">${state.orders.slice(0,4).map(orderCard).join('')}</div>`:emptyState('▤','No orders yet','New orders across campus will appear here.')}</section><section class="panel admin-quick-actions"><div class="section-title"><div><span class="eyebrow">QUICK ACCESS</span><h2>Campus controls</h2></div></div><button type="button" class="admin-shortcut" data-workspace-role="admin" data-workspace-view="stalls"><span>⌂</span><span><strong>Manage stalls</strong><small>Check availability and stall status</small></span><b>${totals.stalls} →</b></button><button type="button" class="admin-shortcut" data-workspace-role="admin" data-workspace-view="reports"><span>▤</span><span><strong>Study reports</strong><small>Review aggregated reach and orders</small></span><b>Open →</b></button><button type="button" class="admin-shortcut" data-workspace-role="admin" data-workspace-view="accounts"><span>◎</span><span><strong>Account overview</strong><small>See users by campus role</small></span><b>Open →</b></button></section></div>`;
  const accounts=`<section class="panel admin-accounts workspace-page" id="admin-accounts"><div class="section-title"><div><span class="eyebrow">ACCOUNT DIRECTORY</span><h2>Campus roles</h2><p class="helper-text">A quick count of accounts using the campus hub.</p></div><span class="result-count">${Object.values(totals.users).reduce((a,b)=>a+b,0)} accounts</span></div><div class="role-directory">${[['buyer','Campus customers','🥡'],['owner','Stall owners','⌂'],['runner','Campus runners','↗'],['admin','Administrators','⚙']].map(([key,label,icon])=>`<article><span>${icon}</span><div><strong>${esc(label)}</strong><small>${totals.users[key]||0} accounts</small></div></article>`).join('')}</div></section>`;
  let page=view==='overview'?overview:view==='stalls'?renderStallApprovals():view==='orders'?renderAdminOrders():view==='reports'?renderAdminReports():accounts;
  root.innerHTML=`${heading('CAMPUS MARKET CONTROL','The hub, at a glance.','Keep campus ordering, stalls, and study activity organized.',`<button class="button ${state.paused?'button-primary':'button-dark'}" data-action="toggle-pause">${state.paused?'Resume ordering':'Pause ordering'}</button>`)}${workspaceNav('admin',tabs,view)}<main class="workspace-content admin-workspace-content">${page}</main>`;
}
function renderAdminOrders(){
  return `<section class="panel admin-orders-page workspace-page" id="admin-orders"><div class="section-title"><div><span class="eyebrow">CAMPUS ORDER LEDGER</span><h2>All orders</h2><p class="helper-text">Review order status and activity across campus.</p></div><span class="result-count">${state.orders.length} recorded</span></div>${state.orders.length?`<div class="order-list">${state.orders.map(orderCard).join('')}</div>`:emptyState('▤','No orders yet','Orders across campus will be recorded here.')}</section>`;
}
function campusDateString(date=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const part=type=>parts.find(item=>item.type===type)?.value||'';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function renderAdminReports(){
  const report=state.adminReports||{daily:[],stalls:[],products:[]};
  const today=campusDateString(),days=Number(state.reportRange);
  const firstDay=Number.isFinite(days)?new Date(Date.parse(`${today}T00:00:00Z`)-(days-1)*86400000).toISOString().slice(0,10):'';
  const daily=report.daily.filter(row=>!firstDay||row.date>=firstDay).sort((a,b)=>b.date.localeCompare(a.date));
  const totals=daily.reduce((sum,row)=>({orders:sum.orders+row.orders,completed:sum.completed+row.completed_orders,
    declined:sum.declined+row.declined_orders,units:sum.units+row.units_ordered,sales:sum.sales+row.sales_cents,
    stallViews:sum.stallViews+row.stall_views,itemViews:sum.itemViews+row.item_views}),
    {orders:0,completed:0,declined:0,units:0,sales:0,stallViews:0,itemViews:0});
  const period=state.reportRange==='all'?'All recorded dates':`Last ${state.reportRange} days`;
  const dailyRows=daily.length?`<div class="report-table-wrap" role="region" aria-label="Daily study data" tabindex="0"><table class="report-table"><caption>Daily order and reach counts · ${esc(period)}</caption><thead><tr><th scope="col">Date · PHT</th><th scope="col">Orders</th><th scope="col">Completed</th><th scope="col">Declined</th><th scope="col">Items ordered</th><th scope="col">Completed order value</th><th scope="col">Stall views</th><th scope="col">Menu views</th></tr></thead><tbody>${daily.map(row=>`<tr><th scope="row">${esc(row.date)}</th><td>${row.orders}</td><td>${row.completed_orders}</td><td>${row.declined_orders}</td><td>${row.units_ordered}</td><td>${money(row.sales_cents/100)}</td><td>${row.stall_views}</td><td>${row.item_views}</td></tr>`).join('')}</tbody></table></div>`:emptyState('▤','No activity in this period','Choose another date range or collect more activity.');
  const stallRows=report.stalls.length?`<div class="report-table-wrap" role="region" aria-label="All-time stall summary" tabindex="0"><table class="report-table"><caption>Stall performance · all time</caption><thead><tr><th scope="col">Stall</th><th scope="col">Orders</th><th scope="col">Completed</th><th scope="col">Declined</th><th scope="col">Items ordered</th><th scope="col">Completed order value</th><th scope="col">Stall views</th><th scope="col">Menu views</th></tr></thead><tbody>${report.stalls.map(row=>`<tr><th scope="row">${esc(row.name)}</th><td>${row.orders}</td><td>${row.completed_orders}</td><td>${row.declined_orders}</td><td>${row.units_ordered}</td><td>${money(row.sales_cents/100)}</td><td>${row.stall_views}</td><td>${row.item_views}</td></tr>`).join('')}</tbody></table></div>`:emptyState('⌂','No stalls to report','Stall summaries will appear when sellers join.');
  const productRows=report.products.length?`<div class="report-table-wrap" role="region" aria-label="All-time menu item summary" tabindex="0"><table class="report-table"><caption>Menu item performance · all time</caption><thead><tr><th scope="col">Menu item</th><th scope="col">Stall</th><th scope="col">Detail views</th><th scope="col">Orders</th><th scope="col">Items ordered</th><th scope="col">Completed order value</th></tr></thead><tbody>${report.products.map(row=>`<tr><th scope="row">${esc(row.name)}</th><td>${esc(row.stall_name)}</td><td>${row.views}</td><td>${row.orders}</td><td>${row.units_ordered}</td><td>${money(row.sales_cents/100)}</td></tr>`).join('')}</tbody></table></div>`:emptyState('▦','No menu items to report','Menu item summaries will appear here.');
  return `<section class="panel admin-reports" id="admin-reports" aria-labelledby="admin-report-title"><div class="section-title report-heading"><div><span class="eyebrow">STUDY DATA</span><h2 id="admin-report-title">Data &amp; reports</h2><p class="helper-text">Aggregated activity for your study. This report does not show buyer names, email addresses, or delivery locations.</p></div><div class="report-actions"><label>Summary period<select id="report-range" aria-label="Choose report summary period"><option value="7" ${state.reportRange==='7'?'selected':''}>Last 7 days</option><option value="30" ${state.reportRange==='30'?'selected':''}>Last 30 days</option><option value="90" ${state.reportRange==='90'?'selected':''}>Last 90 days</option><option value="all" ${state.reportRange==='all'?'selected':''}>All recorded dates</option></select></label><button type="button" class="button button-outline button-small" data-action="export-report" ${state.adminReports?'':'disabled'}>Download CSV</button></div></div><div class="report-stat-grid">${stat('Orders',totals.orders,period,'▣')}${stat('Completed order value',money(totals.sales/100),'Value of completed orders','₱')}${stat('Stall page views',totals.stallViews,'Anonymous daily counts','⌂')}${stat('Menu item views',totals.itemViews,'Anonymous daily counts','⌕')}</div>${state.adminReports?`<p class="report-definition">Items ordered: ${totals.units} · Completed orders: ${totals.completed} · Declined orders: ${totals.declined}. Value is based on the menu total for completed orders; payment is not tracked. Views are anonymous and deduplicated per browser, stall or item, and day.</p>`:'<p class="report-definition" role="status">Loading study data…</p>'}<div class="report-section"><h3>Daily activity</h3>${dailyRows}</div><div class="report-section"><h3>By stall</h3>${stallRows}</div><div class="report-section"><h3>By menu item</h3>${productRows}</div></section>`;
}
function downloadAdminReport(){
  const report=state.adminReports;if(!report)return;
  const days=Number(state.reportRange),today=campusDateString();
  const firstDay=Number.isFinite(days)?new Date(Date.parse(`${today}T00:00:00Z`)-(days-1)*86400000).toISOString().slice(0,10):'';
  const daily=report.daily.filter(row=>!firstDay||row.date>=firstDay);
  const headers=['record_type','period','date_pht','stall','menu_item','orders','completed_orders','declined_orders','units_ordered','completed_order_value_php','stall_views','menu_item_views'];
  const rows=[headers];
  for(const row of daily)rows.push(['daily',state.reportRange==='all'?'all_time':`${state.reportRange}_days`,row.date,'','',row.orders,row.completed_orders,row.declined_orders,row.units_ordered,(row.sales_cents/100).toFixed(2),row.stall_views,row.item_views]);
  for(const row of report.stalls)rows.push(['stall','all_time','',row.name,'',row.orders,row.completed_orders,row.declined_orders,row.units_ordered,(row.sales_cents/100).toFixed(2),row.stall_views,row.item_views]);
  for(const row of report.products)rows.push(['menu_item','all_time','',row.stall_name,row.name,row.orders,'','',row.units_ordered,(row.sales_cents/100).toFixed(2),'',row.views]);
  const csvCell=value=>{const text=String(value??''),safe=/^[\t\r\n ]*[=+\-@]/.test(text)?`'${text}`:text;return `"${safe.replace(/"/g,'""')}"`};
  const csv=rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([`\uFEFF${csv}`],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`bitehub-study-data-${state.reportRange}-${today}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Privacy-safe study data downloaded.');
}
function renderStallApprovals(){
  const stalls=state.overview?.stall_list||[];
  return `<section class="panel stall-approvals" id="admin-stalls"><div class="section-title"><div><span class="eyebrow">CAMPUS STALLS</span><h2>Stall status</h2></div><span class="result-count">${stalls.length} registered</span></div>${stalls.length?`<div class="stall-review-list">${stalls.map(stall=>{const paused=stall.status==='paused';const action=paused?['approved','Resume stall']:['paused','Pause stall'];return `<article class="stall-review-item"><div class="stall-review-copy"><strong>${esc(stall.name)}</strong><span>${esc(stall.owner_name)} · ${esc(stall.owner_email)}</span><small>${stall.product_count} menu ${stall.product_count===1?'item':'items'} · Joined ${new Date(stall.created_at).toLocaleDateString()}</small></div><span class="stall-status-badge status-${paused?'paused':'approved'}">${paused?'paused':'open'}</span><button class="button button-outline button-small" data-stall-status="${stall.id}" data-next-status="${action[0]}">${action[1]}</button></article>`}).join('')}</div>`:emptyState('⌂','No stall accounts yet','Registered stalls will appear here.')}</section>`;
}
function renderOwnerStallNotice(){
  const status=state.user.stall_status;
  if(status!=='paused')return;
  root.insertAdjacentHTML('afterbegin',`<aside class="stall-status-notice is-paused"><strong>Stall paused</strong><p>Customers cannot see or order from your stall while it is paused. Contact an administrator to resume it.</p></aside>`);
}
function render(){
  accountTools();
  if(!state.user){if(state.publicBrowse){document.querySelector('#app')?.classList.remove('auth-open');renderBuyerView();return}return renderAuthWall()}
  document.querySelector('#app')?.classList.remove('auth-open');
  if(state.user.role==='buyer'){renderBuyerView();enhanceGoogleCampusMaps();return}
  if(state.user.role==='owner'){
    renderOwner();renderOwnerStallNotice();
    addProductMetadataFields(root.querySelector('form[data-form="product"]'));
    enhanceGoogleCampusMaps();return;
  }
  if(state.user.role==='runner'){renderRunner();enhanceGoogleCampusMaps();return}
  renderAdmin();
}
function renderError(message){root.innerHTML=`${heading('CONNECTION ISSUE','The hub could not load.','Check the local server, then try again.')}<section class="panel error-panel"><p>${esc(message)}</p><button class="button button-primary" data-action="retry">Try again</button></section>`}
async function showAuth(mode='login'){$('#auth-dialog').close?.();renderAuthForm(mode);$('#auth-dialog').showModal()}
function showAccountEmailDialog(mode,token=''){
  const dialog=$('#auth-dialog');if(!dialog)return;
  const reset=mode==='password-reset';
  const title=reset?'Choose a new password':'Reset your password';
  const intro=reset?'Use a new password with at least 10 characters. The link expires after one hour.':'Enter the email address on your stall account. If it is registered, BiteHub will send a secure reset link.';
  const fields=reset?`<input type="hidden" name="token" value="${esc(token)}"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="10" maxlength="1024" required></label><label>Confirm new password<input name="confirm_password" type="password" autocomplete="new-password" minlength="10" maxlength="1024" required></label>`:`<label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="name@gmail.com"></label>`;
  dialog.innerHTML=`<form method="dialog" class="modal-dismiss"><button class="icon-button" aria-label="Close">×</button></form><section class="account-email-dialog"><span class="eyebrow">BITEHUB ACCOUNT</span><h2>${title}</h2><p>${intro}</p><form class="stack-form" data-form="${reset?'password-reset':'password-forgot'}">${fields}<button class="button button-primary button-wide" type="submit">${reset?'Save new password':'Send reset link'} <span aria-hidden="true">→</span></button><p class="auth-front-status" role="alert" aria-live="polite"></p></form></section>`;
  if(!dialog.open)dialog.showModal();
  dialog.querySelector('input:not([type="hidden"])')?.focus({preventScroll:true});
}
function renderEmailVerificationPending(email,message='Check your email for a verification link before signing in.'){
  const slot=$('#auth-form-slot');if(!slot)return;
  slot.innerHTML=`<section class="auth-email-pending"><span class="eyebrow">ONE MORE STEP</span><h3>Check your email</h3><p>${esc(message)}</p><p class="auth-email-destination">${esc(email)}</p><button type="button" class="button button-primary button-wide" data-action="resend-verification" data-email="${esc(email)}">Resend verification email</button><button type="button" class="text-button auth-email-back" data-auth-mode="front" data-auth-role="owner">Back to sign in</button></section>`;
}
function cartEntries(){return [...state.cart.values()]}
function cartTotal(){return cartEntries().reduce((sum,p)=>sum+p.price*p.quantity,0)}
function updateCartShortcut(){
  const shortcut=$('#cart-fab');if(!shortcut)return;
  const count=cartCount(),canOrder=state.user?.role==='buyer'||(!state.user&&state.publicBrowse);
  shortcut.hidden=!canOrder||!count||document.querySelector('#app.auth-open');
  document.body.classList.toggle('has-cart-fab',!shortcut.hidden);
  shortcut.innerHTML=`<span class="cart-fab-icon" aria-hidden="true">▣</span><span class="cart-fab-copy"><small>Your bag · ${count} ${count===1?'item':'items'}</small><strong>${money(cartTotal())}</strong></span><b>Review bag <span aria-hidden="true">→</span></b>`;
  shortcut.setAttribute('aria-label',`Review your bag with ${count} ${count===1?'item':'items'}, total ${money(cartTotal())}`);
}
function renderBagLine(item){
  const art=item.photo_url?`<img src="${esc(item.photo_url)}" alt="">`:`<span aria-hidden="true">${esc(item.emoji)}</span>`;
  const limit=item.stock_count===null||item.stock_count===undefined?50:Math.min(50,item.stock_count);
  return `<article class="bag-item" data-bag-item="${item.id}"><div class="bag-item-art">${art}</div><div class="bag-item-content"><div class="bag-item-heading"><strong>${esc(item.name)}</strong><button type="button" class="bag-remove" data-remove-cart="${item.id}" aria-label="Remove ${esc(item.name)} from bag">Remove</button></div><small class="bag-item-stall">${esc(item.stall_name)} · ${money(item.price)} each</small><div class="bag-item-bottom"><div class="quantity-control bag-quantity"><button type="button" data-quantity="-1" data-id="${item.id}" aria-label="Remove one ${esc(item.name)}">−</button><span aria-label="Quantity">${item.quantity}</span><button type="button" data-quantity="1" data-id="${item.id}" aria-label="Add one ${esc(item.name)}" ${item.quantity>=limit?'disabled':''}>+</button></div><strong class="bag-line-total">${money(item.price*item.quantity)}</strong></div></div></article>`;
}
function renderCart(){
  const items=cartEntries(),deliveryAvailable=activeCampus().configured;
  if(!deliveryAvailable&&state.fulfillment==='delivery'){state.fulfillment='pickup';state.deliveryLocation=null}
  const dialog=$('#cart-dialog'),content=$('#cart-content'),wasOpen=dialog.open,body=$('#bag-scroll'),previousScroll=body?.scrollTop||0;
  const focused=document.activeElement,quantity=focused?.closest('[data-quantity]'),remove=focused?.closest('[data-remove-cart]');
  const focusState=quantity?{kind:'quantity',id:quantity.dataset.id,delta:quantity.dataset.quantity}:remove?{kind:'remove',id:remove.dataset.removeCart}:focused?.closest('[data-action="clear-cart"]')?{kind:'clear'}:null;
  const guest=!state.user,first=items[0];
  if(guest){
    if($('#guest-order-name'))state.guestName=$('#guest-order-name').value;
    if($('#guest-school-role'))state.guestSchoolRole=$('#guest-school-role').value;
    if($('#guest-order-grade'))state.guestGrade=$('#guest-order-grade').value;
    if($('#guest-order-section'))state.guestSection=$('#guest-order-section').value;
  }
  const controls=items.length&&!guest?`<section class="bag-section" aria-labelledby="bag-fulfillment-title"><h3 id="bag-fulfillment-title">How do you want to get it?</h3><div class="fulfillment-options" role="radiogroup" aria-label="Choose pickup or school delivery"><label class="fulfillment-choice ${state.fulfillment==='pickup'?'is-selected':''}"><input type="radio" id="fulfillment" name="fulfillment" value="pickup" ${state.fulfillment==='pickup'?'checked':''}><i class="fulfillment-icon" aria-hidden="true">⌂</i><span><strong>Pick up</strong><small>Collect from the stall</small></span></label><label class="fulfillment-choice ${state.fulfillment==='delivery'?'is-selected':''} ${deliveryAvailable?'':'is-disabled'}"><input type="radio" id="fulfillment-delivery" name="fulfillment" value="delivery" ${state.fulfillment==='delivery'?'checked':''} ${deliveryAvailable?'':'disabled'}><i class="fulfillment-icon" aria-hidden="true">↗</i><span><strong>School delivery</strong><small>${deliveryAvailable?'Meet your runner at school':'School delivery needs a location pin'}</small></span></label></div><div class="delivery-map-wrap" id="delivery-map-wrap" ${state.fulfillment!=='delivery'?'hidden':''}><strong>Choose a PNS handoff point</strong><small>Tap a blue campus path or nearby meeting point on the map.</small>${campusMap(null,true)}<small class="map-attribution">PNS campus map data © Overture Maps Foundation, Meta/WRI, and OpenGeoHub · GPS accuracy varies.</small><span class="map-key"><i class="map-key-destination"></i>Handoff point</span><span id="delivery-map-status" role="status">${state.deliveryLocation?'Delivery point selected':'No delivery point selected'}</span><a class="button button-outline button-small map-google-link" id="delivery-google-link" href="${googleMapsPointUrl(state.deliveryLocation)}" target="_blank" rel="noopener noreferrer">${state.deliveryLocation?'Check handoff point':'View school map'} in Google Maps <span aria-hidden="true">↗</span></a></div><label class="bag-note">Note for the stall <small>Optional · allergies or pickup details</small><textarea id="order-note" maxlength="240" rows="2" placeholder="Add a note for the stall">${esc(state.cartNote)}</textarea></label></section>`:'';
  content.innerHTML=`<div class="bag-layout"><header class="bag-header"><div class="bag-heading"><span class="bag-heading-mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M12 19h24l-2 20H14l-2-20Z" fill="#FFEACF" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/><path d="M18 20v-4a6 6 0 0 1 12 0v4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M18 27h12M20 32h8" stroke="#A85649" stroke-width="2.2" stroke-linecap="round"/></svg></span><div class="bag-heading-copy"><span class="bag-heading-kicker"><i aria-hidden="true">✦</i> YOUR PNS ORDER</span><h2 id="cart-title">${items.length?'Review your bag':'Your bag'}</h2><p>${items.length?`${cartCount()} ${cartCount()===1?'item':'items'} · ${esc(first.stall_name)}`:'Pick something good for your break.'}</p></div></div>${items.length?`<div class="bag-header-actions"><span class="bag-item-count">${cartCount()} ${cartCount()===1?'item':'items'}</span><button type="button" class="bag-clear" data-action="clear-cart">Clear bag</button></div>`:`<span class="bag-ready-pill"><i aria-hidden="true"></i> READY FOR A GOOD BREAK</span>`}</header><div class="bag-scroll" id="bag-scroll">${items.length?`<div class="bag-stall-note"><span aria-hidden="true">⌂</span><span><strong>${esc(first.stall_name)}</strong><small>One stall per order · review your items below</small></span></div><div class="bag-lines">${items.map(renderBagLine).join('')}</div>${controls}`:`<div class="bag-empty"><span class="bag-empty-kicker">A GOOD BREAK STARTS HERE</span><div class="bag-empty-art" aria-hidden="true"><span class="bag-empty-spark bag-empty-spark-one">✦</span><span class="bag-empty-spark bag-empty-spark-two">✳</span><svg viewBox="0 0 176 148"><ellipse cx="88" cy="133" rx="48" ry="7" fill="#174A5730"/><circle cx="88" cy="72" r="61" fill="#E5F3ED"/><path d="M59 61V48a29 29 0 0 1 58 0v13" fill="none" stroke="#226C82" stroke-width="5" stroke-linecap="round"/><path d="M49 57h78l-7 65a11 11 0 0 1-11 10H67a11 11 0 0 1-11-10l-7-65Z" fill="#FFF4DF" stroke="#226C82" stroke-width="3" stroke-linejoin="round"/><path d="M49 61h78v14H49z" fill="#FAB2A4" stroke="#226C82" stroke-width="3"/><path d="M65 60c0-11 9-20 21-20 12 0 21 9 21 20" fill="#FFEACF" stroke="#A85649" stroke-width="3"/><path d="M69 56c5-5 10 4 16-1s11 4 17-1" fill="none" stroke="#72B99A" stroke-width="4" stroke-linecap="round"/><circle cx="77" cy="93" r="2.8" fill="#226C82"/><circle cx="99" cy="93" r="2.8" fill="#226C82"/><path d="M80 103c5 6 12 6 17 0" fill="none" stroke="#A85649" stroke-width="2.8" stroke-linecap="round"/><path d="m45 38 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Zm88 29 2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z" fill="#D99A68"/></svg></div><h3>Let’s find your next favorite</h3><p>Explore the PNS menu and add a tasty break-time pick from one of your school stalls.</p><button type="button" class="button button-primary" data-action="continue-shopping">Explore the menu <span aria-hidden="true">→</span></button><div class="bag-empty-promises" aria-hidden="true"><span>✦ PNS stall favorites</span><i></i><span>⌂ Easy pickup</span></div></div>`}</div>${items.length?`<footer class="bag-footer"><div class="bag-total"><span>${cartCount()} ${cartCount()===1?'item':'items'} · total</span><strong>${money(cartTotal())}</strong></div>${guest?`<small class="bag-payment-note">Log in to choose pickup or delivery and place your order.</small><button type="button" class="button button-primary button-wide" data-action="guest-checkout">Log in to order <span>→</span></button>`:`<small class="bag-payment-note">Pay the stall directly at pickup or handoff.</small><button type="button" class="button button-primary button-wide" data-action="place-order" ${state.paused||(state.fulfillment==='delivery'&&!state.deliveryLocation)?'disabled':''}>${state.paused?'Ordering paused':`Place order · ${money(cartTotal())}`} <span>→</span></button>`}</footer>`:''}</div>`;
  if(guest&&items.length){
    const guestFields=document.createElement('section');guestFields.className='bag-section guest-checkout-fields';
    guestFields.setAttribute('aria-labelledby','guest-checkout-title');
    guestFields.innerHTML=`<h3 id="guest-checkout-title">Place your order as a guest</h3><label class="guest-name-field">Name for this order<input id="guest-order-name" name="guest_name" maxlength="80" autocomplete="name" required value="${esc(state.guestName)}" placeholder="What should the stall call you?"></label><div class="fulfillment-options" role="radiogroup" aria-label="Choose pickup or school delivery"><label class="fulfillment-choice ${state.fulfillment==='pickup'?'is-selected':''}"><input type="radio" id="fulfillment" name="fulfillment" value="pickup" ${state.fulfillment==='pickup'?'checked':''}><i class="fulfillment-icon" aria-hidden="true">⌂</i><span><strong>Pick up</strong><small>Collect from the stall</small></span></label><label class="fulfillment-choice ${state.fulfillment==='delivery'?'is-selected':''} ${deliveryAvailable?'':'is-disabled'}"><input type="radio" id="fulfillment-delivery" name="fulfillment" value="delivery" ${state.fulfillment==='delivery'?'checked':''} ${deliveryAvailable?'':'disabled'}><i class="fulfillment-icon" aria-hidden="true">↗</i><span><strong>School delivery</strong><small>${deliveryAvailable?'Meet your runner at school':'School delivery needs a location pin'}</small></span></label></div><div class="delivery-map-wrap" id="delivery-map-wrap" ${state.fulfillment!=='delivery'?'hidden':''}><strong>Choose a PNS handoff point</strong><small>Tap the map to select a campus meeting point.</small>${campusMap(null,true)}<span id="delivery-map-status" role="status">${state.deliveryLocation?'Delivery point selected':'No delivery point selected'}</span></div><label class="bag-note">Note for the stall <small>Optional · allergies or pickup details</small><textarea id="order-note" maxlength="240" rows="2" placeholder="Add a note for the stall">${esc(state.cartNote)}</textarea></label>`;
    guestFields.querySelector('.fulfillment-options')?.insertAdjacentHTML('afterend',`<section class="guest-delivery-details" id="guest-delivery-details" ${state.fulfillment!=='delivery'?'hidden':''}><p>For school delivery, add the details the stall needs to find you.</p><label id="guest-school-role-field">School role<select id="guest-school-role" name="guest_school_role" required><option value="">Choose your school role</option><option value="junior_student" ${state.guestSchoolRole==='junior_student'?'selected':''}>Junior high student</option><option value="senior_student" ${state.guestSchoolRole==='senior_student'?'selected':''}>Senior high student</option><option value="teacher" ${state.guestSchoolRole==='teacher'?'selected':''}>Teacher</option><option value="staff" ${state.guestSchoolRole==='staff'?'selected':''}>School staff</option></select></label><label id="guest-grade-field" ${!['junior_student','senior_student'].includes(state.guestSchoolRole)||state.fulfillment!=='delivery'?'hidden':''}>Grade<select id="guest-order-grade" name="guest_grade" required><option value="">Choose your grade</option></select></label><label id="guest-section-field">Section or office<input id="guest-order-section" name="guest_section" maxlength="80" required value="${esc(state.guestSection)}" placeholder="Your section or office"></label></section>`);
    $('#bag-scroll .bag-lines')?.after(guestFields);
    const oldCheckout=$('#cart-content [data-action="guest-checkout"]');
    if(oldCheckout){const place=document.createElement('button');place.type='button';place.className='button button-primary button-wide';place.dataset.action='place-order';place.innerHTML=`Place guest order · ${money(cartTotal())} <span aria-hidden="true">→</span>`;oldCheckout.replaceWith(place)}
    const paymentNote=$('#cart-content .bag-payment-note');if(paymentNote)paymentNote.textContent='No customer account needed. Order updates will appear in My orders on this device.';
    syncGuestDeliveryFields();
  }
  accountTools();
  if(!dialog.open)dialog.showModal();
  if(wasOpen){const nextBody=$('#bag-scroll');if(nextBody)nextBody.scrollTop=previousScroll;let target=null;if(focusState?.kind==='quantity')target=content.querySelector(`[data-quantity="${focusState.delta}"][data-id="${focusState.id}"]`);if(focusState?.kind==='remove')target=content.querySelector(`[data-quantity="-1"]`)||content.querySelector('[data-action="continue-shopping"]');if(focusState?.kind==='clear')target=content.querySelector('[data-action="continue-shopping"]');(target||content.querySelector('[data-action="continue-shopping"]')||$('#cart-close'))?.focus({preventScroll:true});if(nextBody)nextBody.scrollTop=previousScroll}
  enhanceGoogleCampusMaps();
}
function syncGuestDeliveryFields(){
  const details=$('#guest-delivery-details');if(!details)return;
  const delivery=state.fulfillment==='delivery',role=$('#guest-school-role')?.value||state.guestSchoolRole;
  const student=role==='junior_student'||role==='senior_student';
  details.hidden=!delivery;
  const roleInput=$('#guest-school-role');if(roleInput){roleInput.required=delivery;roleInput.disabled=!delivery}
  const gradeField=$('#guest-grade-field'),gradeInput=$('#guest-order-grade');
  if(gradeField)gradeField.hidden=!delivery||!student;
  if(gradeInput){
    const grades=role==='junior_student'?['7','8','9','10']:role==='senior_student'?['11','12']:[];
    const current=gradeInput.value||state.guestGrade;
    gradeInput.innerHTML='<option value="">Choose your grade</option>'+grades.map(grade=>`<option value="${grade}">Grade ${grade}</option>`).join('');
    gradeInput.value=grades.includes(current)?current:'';
    gradeInput.required=delivery&&student;gradeInput.disabled=!delivery||!student;state.guestGrade=gradeInput.value;
  }
  const sectionField=$('#guest-order-section'),sectionLabel=$('#guest-section-field');
  if(sectionField){sectionField.required=delivery;sectionField.disabled=!delivery}
  if(sectionLabel){const label=sectionLabel.firstChild;if(label&&label.nodeType===Node.TEXT_NODE)label.textContent=role==='teacher'||role==='staff'?'Office or department':'';if(role!=='teacher'&&role!=='staff'&&label)label.textContent='Section or office'}
}
function updateCartCheckoutButton(){
  const place=$('#cart-content [data-action="place-order"]');
  if(place)place.disabled=state.paused||(state.fulfillment==='delivery'&&!state.deliveryLocation);
}
function cartCount(){return cartEntries().reduce((count,item)=>count+item.quantity,0)}
function animateFoodIntoBag(product,startRect){
  const bag=$('#account-tools [data-action="open-cart"]');
  if(!bag||!startRect?.width||!startRect?.height||typeof Element.prototype.animate!=='function'||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
  const targetRect=bag.getBoundingClientRect(),size=Math.min(68,Math.max(46,Math.min(startRect.width,startRect.height)*.48));
  const flyer=document.createElement('span');flyer.className='food-to-bag-flight';flyer.setAttribute('aria-hidden','true');
  if(product.photo_url){const image=document.createElement('img');image.src=product.photo_url;image.alt='';image.loading='eager';flyer.append(image)}else flyer.textContent=product.emoji||'🍽️';
  const startX=startRect.left+startRect.width/2-size/2,startY=startRect.top+startRect.height/2-size/2;
  const endX=targetRect.left+targetRect.width/2-size/2,endY=targetRect.top+targetRect.height/2-size/2;
  const dx=endX-startX,dy=endY-startY,arc=Math.max(20,Math.min(54,Math.abs(dx)*.12+18));
  Object.assign(flyer.style,{left:startX+'px',top:startY+'px',width:size+'px',height:size+'px'});document.body.append(flyer);
  const midTransform='translate3d('+(dx*.52)+'px,'+(dy*.52-arc)+'px,0) scale(.78)';
  const endTransform='translate3d('+dx+'px,'+dy+'px,0) scale(.16)';
  const flight=flyer.animate([{transform:'translate3d(0,0,0) scale(1)',opacity:1,offset:0},{transform:midTransform,opacity:1,offset:.55},{transform:endTransform,opacity:.2,offset:1}],{duration:650,easing:'cubic-bezier(.2,.78,.25,1)'});
  flight.finished.then(()=>flyer.remove()).catch(()=>flyer.remove());
  bag.animate([{transform:'scale(1)'},{transform:'scale(1.1)'},{transform:'scale(1)'}],{duration:430,delay:390,easing:'ease-out'});
}
function addToCart(product,sourceButton=null){
  if(state.paused){toast('Ordering is paused right now.');return}
  if(!product.stall_open){toast(`This stall is closed. It opens at ${product.opens_at}.`);return}
  if(!product.available){toast('This menu item is currently unavailable.');return}
  if([...state.cart.values()].some(item=>item.stall_id!==product.stall_id)){toast('Place a separate order for each stall.');return}
  const item=state.cart.get(product.id)||{...product,quantity:0};
  const limit=item.stock_count===null?50:Math.min(50,item.stock_count);
  if(item.quantity>=limit){toast(item.stock_count===null?'You can order up to 50 of each item.':`Only ${item.stock_count} available.`);return}
  const artwork=sourceButton?.closest('.product-card')?.querySelector('.product-art-trigger')||sourceButton?.closest('#product-content')?.querySelector('.product-detail-hero')||sourceButton;
  const startRect=artwork?.getBoundingClientRect();
  item.quantity++;state.cart.set(product.id,item);accountTools();if(startRect)animateFoodIntoBag(product,startRect);
  if($('#cart-dialog').open)renderCart();
  toast(`${product.name} added to your bag.`);
}
function resetEmptyBag(){if(state.cart.size)return;state.cartNote='';state.guestName='';state.guestSchoolRole='';state.guestGrade='';state.guestSection='';state.fulfillment='pickup';state.deliveryLocation=null}
function requireGuestOrderField(field,message){
  if(field&&String(field.value||'').trim())return true;
  if(field){field.setCustomValidity(message);field.reportValidity();field.setCustomValidity('');field.focus()}
  else toast(message);
  return false;
}
function changeQuantity(id,delta){const item=state.cart.get(Number(id));if(!item)return;const limit=item.stock_count===null||item.stock_count===undefined?50:Math.min(50,item.stock_count);if(item.quantity+delta>limit){toast(item.stock_count===null||item.stock_count===undefined?'You can order up to 50 of each item.':`Only ${item.stock_count} available.`);return}item.quantity+=delta;if(item.quantity<=0)state.cart.delete(Number(id));resetEmptyBag();accountTools();renderCart()}
function renderProductDetails(id){
  const product=state.products.find(item=>item.id===Number(id));if(!product)return;
  if(!(state.user?.role==='owner'&&state.user.stall_id===product.stall_id)&&state.user?.role!=='admin')recordReachView(product.stall_id,product.id);
  const logo=product.stall_logo_url?`<img src="${esc(product.stall_logo_url)}" alt="">`:esc(product.stall_name.trim().charAt(0).toUpperCase());
  $('#product-content').innerHTML=`<form method="dialog" class="modal-dismiss"><button class="icon-button" aria-label="Close item details">×</button></form><div class="product-detail-hero">${product.photo_url?`<img src="${esc(product.photo_url)}" alt="Photo of ${esc(product.name)}">`:`<span aria-hidden="true">${esc(product.emoji)}</span>`}</div><div class="product-detail-body"><button class="product-detail-stall" data-stall-profile="${product.stall_id}"><span class="stall-mini-logo">${logo}</span><span><small>FROM THIS STALL</small><strong>${esc(product.stall_name)}</strong></span><b aria-hidden="true">›</b></button><span class="eyebrow">${esc(product.category)}</span><h2>${esc(product.name)}</h2><p class="product-detail-description">${esc(product.description||'Fresh from the stall, ready for your break.')}</p>${product.ingredients?`<section class="product-info-block"><h3>Ingredients</h3><p>${esc(product.ingredients)}</p></section>`:''}${productTags(product)?`<section class="product-info-block"><h3>Dietary & allergen information</h3><div class="product-tag-summary detail-tags">${productTags(product)}</div><small>Information is provided by the stall. Confirm allergy details with the owner.</small></section>`:''}<p class="detail-stock">${product.stall_open?`Open · ${esc(product.opens_at)}–${esc(product.closes_at)} PHT`:`Closed · opens ${esc(product.opens_at)} PHT`}${product.stock_count!==null?` · ${product.available?`${product.stock_count} left`:'Sold out'}`:''}</p><div class="product-detail-footer"><strong>${money(product.price)}</strong><button class="button button-primary" data-add="${product.id}" ${state.paused||!product.available?'disabled':''}>${!product.available?'Unavailable':state.paused?'Ordering paused':'Add to bag'}</button></div></div>`;
  const add=$('#product-content [data-add]');
  if(add){add.disabled=state.paused||!product.stall_open||!product.available;add.textContent=state.paused?'Ordering paused':!product.stall_open?'Stall closed':!product.available?'Sold out':'Add to bag'}
  if(!$('#product-dialog').open)$('#product-dialog').showModal();
}
function renderProductEdit(id){
  const product=state.products.find(item=>item.id===Number(id));if(!product)return;
  $('#product-edit-content').innerHTML=`<form method="dialog" class="modal-dismiss"><button class="icon-button" aria-label="Close edit item">×</button></form><span class="eyebrow">YOUR STALL MENU</span><h2>Edit menu item</h2><form class="stack-form" data-form="product-edit" data-id="${product.id}"><label>Item name<input name="name" maxlength="80" required value="${esc(product.name)}"></label><label>Description <span class="field-hint">Optional</span><input name="description" maxlength="240" value="${esc(product.description)}"></label><label>Ingredients <span class="field-hint">Optional</span><textarea name="ingredients" maxlength="700" rows="2" placeholder="Chicken, rice, garlic">${esc(product.ingredients||'')}</textarea></label><div class="form-split"><label>Category<select name="category">${['Meals','Snacks','Drinks'].map(category=>`<option ${product.category===category?'selected':''}>${category}</option>`).join('')}</select></label><label>Price<input name="price" type="number" min="0.01" max="1000000" step="0.01" required value="${Number(product.price).toFixed(2)}"></label></div><label>Food icon<select name="emoji">${['🍽️','🍚','🍜','🥪','🥗','🍰','🧋','🍟','🍗'].map(icon=>`<option ${product.emoji===icon?'selected':''}>${icon}</option>`).join('')}</select></label><button class="button button-primary button-wide">Save changes</button></form>`;
  addProductMetadataFields($('#product-edit-content form[data-form="product-edit"]'),product);
  if(!$('#product-edit-dialog').open)$('#product-edit-dialog').showModal();
}
async function orderAction(button){
  const id=button.dataset.id,action=button.dataset.orderAction,payload={action};
  if(!state.user){payload.guest_token=guestOrderToken(id);if(!payload.guest_token)throw new Error('This private order link is missing. Open this order in the browser where you placed it.')}
  if(action==='assign'){payload.runner_name=$(`[data-assign-runner="${id}"]`)?.value.trim()||'';if(!payload.runner_name)throw new Error('Type the name of the runner for this delivery.')}
  if(action==='runner-link'){
    const result=await api(`/api/orders/${id}/runner-link`,{method:'POST',body:'{}'}),shareUrl=new URL('/',location.origin);
    shareUrl.hash=`runner-track=${id}.${result.token}`;state.runnerLinks[id]=shareUrl.href;render();
    try{await navigator.clipboard.writeText(shareUrl.href);toast('Runner link created and copied. Send it privately to the assigned runner.')}
    catch{toast('Runner link ready below. Copy it and send it privately to the assigned runner.')}
    return;
  }
  await api(`/api/orders/${id}`,{method:'PATCH',body:json(payload)});
  const messages={assign:'Runner assigned. The customer can see their name.','offer-pickup':'Pickup option sent to the customer.','accept-pickup':'Your order will be ready for pickup at the stall.','cancel-no-runner':'Order cancelled.','out':'The order is on its way.','delivered':'Delivery marked complete.',collect:'Pickup confirmed.'};
  toast(messages[action]||'Order updated.');await refresh();
}
root.addEventListener('input',e=>{
  const authForm=e.target.closest('.auth-front-form');if(authForm){const status=authForm.querySelector('.auth-front-status');if(status){status.textContent='';status.classList.remove('is-visible')}}
  if(e.target.id==='menu-search'){state.query=e.target.value;const start=e.target.selectionStart;renderBuyerView();const input=$('#menu-search');input.focus();input.setSelectionRange(start,start)}
});
document.addEventListener('change',e=>{
  if(e.target.matches('input[name="logo_file"]')){
    const input=e.target,file=input.files?.[0];if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2*1024*1024){input.value='';toast('Choose a JPG, PNG, or WebP logo under 2 MB.');return}
    const preview=input.closest('form')?.querySelector('.stall-logo-preview'),image=preview?.querySelector('img');
    if(image){const url=URL.createObjectURL(file);image.onload=()=>URL.revokeObjectURL(url);image.src=url;image.hidden=false;const caption=preview.querySelector('span');if(caption)caption.hidden=true}
    const remove=input.closest('form')?.querySelector('input[name="remove_logo"]');if(remove)remove.checked=false;
    return;
  }
  if(e.target.matches('input[name="photo_file"]')){
    const input=e.target,file=input.files?.[0];if(!file)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2*1024*1024){input.value='';toast('Choose a JPG, PNG, or WebP photo under 2 MB.');return}
    const preview=input.closest('form')?.querySelector('.photo-preview'),image=preview?.querySelector('img');
    if(image){const url=URL.createObjectURL(file);image.onload=()=>URL.revokeObjectURL(url);image.src=url;image.hidden=false;preview.classList.add('has-photo');const caption=preview.querySelector('span');if(caption)caption.textContent='Preview · save the item to publish this photo'}
    const remove=input.closest('form')?.querySelector('input[name="remove_photo"]');if(remove)remove.checked=false;
    return;
  }
});
root.addEventListener('change',async e=>{
  if(e.target.id==='menu-sort'){state.sort=e.target.value;renderBuyerView()}
  if(e.target.id==='stall-filter'){state.stallFilter=e.target.value;renderBuyerView()}
  if(e.target.id==='dietary-filter'){state.dietaryFilter=e.target.value;renderBuyerView()}
  if(e.target.id==='allergen-filter'){state.allergenFilter=e.target.value;renderBuyerView()}
  if(e.target.matches('[data-availability]')){try{await api(`/api/products/${e.target.dataset.availability}`,{method:'PATCH',body:json({available:e.target.checked})});toast('Menu availability saved.');await refresh()}catch(error){toast(error.message);await refresh()}}
});
root.addEventListener('keydown',e=>{
  const stallProfile=e.target.closest('[data-stall-profile]');if(stallProfile&&(e.key==='Enter'||e.key===' ')){e.preventDefault();stallProfile.click();return}
  const mapPicker=e.target.closest('[data-map-picker]');
  if(mapPicker&&(e.key==='Enter'||e.key===' ')){e.preventDefault();mapPicker.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0}))}
});
root.addEventListener('change',e=>{
  if(e.target.id!=='report-range')return;
  state.reportRange=e.target.value;
  const report=$('#admin-reports');if(report)report.outerHTML=renderAdminReports();
});
document.addEventListener('click',async e=>{
  const workspaceTab=e.target.closest('[data-workspace-role][data-workspace-view]');
  if(workspaceTab){
    if(workspaceTab.closest('#sidebar-navigation'))closeSidebar();
    const role=workspaceTab.dataset.workspaceRole,view=workspaceTab.dataset.workspaceView;
    if(role==='buyer'&&(state.user?.role==='buyer'||(!state.user&&state.publicBrowse))||state.user?.role===role){
      if(state[`${role}View`]===view)return;
      state[`${role}View`]=view;
      const hashes={buyer:{menu:'#menu',orders:'#buyer-orders'},owner:{dashboard:'#owner-dashboard',orders:'#owner-orders',menu:'#owner-menu',stall:'#owner-stall',insights:'#owner-insights'},admin:{overview:'#admin-overview',stalls:'#admin-stalls',orders:'#admin-orders',reports:'#admin-reports',accounts:'#admin-accounts'}};
      const hash=hashes[role]?.[view];if(hash)history.pushState({workspace:role,view},'',hash);
      render();window.scrollTo({top:0,behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      root.querySelector(`[data-workspace-role="${role}"][data-workspace-view="${view}"]`)?.focus({preventScroll:true});
    }
    return;
  }
  const sidebarScroll=e.target.closest('[data-sidebar-scroll]');
  if(sidebarScroll){closeSidebar();document.getElementById(sidebarScroll.dataset.sidebarScroll)?.scrollIntoView({behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});return}
  if(e.target.closest('#app-sidebar a[href]'))closeSidebar();
  const stallProfile=e.target.closest('[data-stall-profile]');if(stallProfile){try{await renderStallProfile(stallProfile.dataset.stallProfile)}catch(error){toast(error.message)}return}
  const feature=e.target.closest('[data-feature-product]');if(feature){feature.disabled=true;const active=feature.dataset.featureActive==='true';try{await api('/api/stall/feature',{method:'PATCH',body:json({product_id:Number(feature.dataset.featureProduct),featured:!active})});toast(active?'Campus pick removed.':'Featured on Fresh from our stalls for 24 hours!');await refresh()}catch(error){toast(error.message);feature.disabled=false}return}
  const moveFeatured=e.target.closest('[data-feature-move]');if(moveFeatured){const rail=$('.featured-rail'),card=rail?.querySelector('.featured-card');if(rail&&card)rail.scrollBy({left:(card.getBoundingClientRect().width+12)*Number(moveFeatured.dataset.featureMove),behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});return}
  const pauseFeatured=e.target.closest('[data-feature-pause]');if(pauseFeatured){state.featuredPaused=!state.featuredPaused;pauseFeatured.setAttribute('aria-pressed',String(state.featuredPaused));pauseFeatured.textContent=state.featuredPaused?'Play rotation':'Pause rotation';return}
  const enableAlerts=e.target.closest('[data-action="enable-notifications"]');if(enableAlerts){enableAlerts.disabled=true;try{await enablePushNotifications()}catch(error){toast(error.message);enableAlerts.disabled=false}return}
  const disableAlerts=e.target.closest('[data-action="disable-notifications"]');if(disableAlerts){disableAlerts.disabled=true;try{await disablePushNotifications()}catch(error){toast(error.message);disableAlerts.disabled=false}return}
   const runnerStart=e.target.closest('[data-runner-share-start]');if(runnerStart){await startAnonymousRunnerSharing();return}
   const runnerStop=e.target.closest('[data-runner-share-stop]');if(runnerStop){stopAnonymousRunnerSharing();return}
   const copyRunnerLink=e.target.closest('[data-copy-runner-link]');if(copyRunnerLink){const id=copyRunnerLink.dataset.copyRunnerLink,link=state.runnerLinks[id],field=$(`[data-runner-link-value="${id}"]`);if(!link)return;try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(link);else if(field){field.focus();field.select();document.execCommand('copy')}toast('Runner link copied. Send it privately to the assigned runner.')}catch{field?.focus();field?.select();toast('Select and copy the runner link shown above.')}return}
  const zoom=e.target.closest('[data-map-zoom]');if(zoom){setMapZoom(zoom.dataset.mapZoom);return}
   const mapPicker=e.target.closest('[data-map-picker]');if(mapPicker){const shell=mapPicker.closest('.campus-map-shell'),rect=shell.getBoundingClientRect(),x=e.detail===0?0.5:Math.max(0,Math.min(1,((e.clientX-rect.left)/rect.width-.5)/state.mapZoom+.5)),y=e.detail===0?0.5:Math.max(0,Math.min(1,((e.clientY-rect.top)/rect.height-.5)/state.mapZoom+.5)),point=mapLatLon(x*PNS_MAP.width,y*PNS_MAP.height);setDeliveryPoint(point.latitude,point.longitude,shell);return}
  const passwordToggle=e.target.closest('[data-toggle-password]');if(passwordToggle){e.preventDefault();const input=passwordToggle.closest('.front-input-wrap')?.querySelector('input[name="password"]');if(input){const showing=input.type==='password';input.type=showing?'text':'password';passwordToggle.setAttribute('aria-label',showing?'Hide password':'Show password');passwordToggle.setAttribute('aria-pressed',String(showing));passwordToggle.querySelector('span').textContent=showing?'Hide':'Show';input.focus({preventScroll:true})}return}
  const frontRoleChoice=e.target.closest('[data-front-role]');if(frontRoleChoice){state.authRole=frontRoleChoice.dataset.frontRole;document.querySelectorAll('[data-front-role]').forEach(choice=>{const selected=choice===frontRoleChoice;choice.classList.toggle('is-selected',selected);choice.setAttribute('aria-pressed',String(selected));choice.setAttribute('aria-label',choice.querySelector('.front-role-copy strong').textContent+(selected?' selected':''));const marker=choice.querySelector('.front-role-arrow');if(marker)marker.textContent=selected?'✓':'→'});const selectedRoleInput=$('#auth-form-slot input[name="role"]');if(selectedRoleInput)selectedRoleInput.value=state.authRole;const submit=$('#auth-form-slot .auth-front-form button[type="submit"]'),roleName=frontRoleChoice.querySelector('.front-role-copy strong').textContent;if(submit)submit.innerHTML='Log in as '+roleName+' <span aria-hidden="true">→</span>';const status=$('.auth-front-status');if(status){status.textContent='';status.classList.remove('is-visible')}return}
  const authTab=e.target.closest('[data-auth-mode]');if(authTab){state.authRole=authTab.dataset.authRole||state.authRole;const authModes={front:'front',login:'front',choose:'choose','login-choose':'login-choose',signup:'signup'};renderAuthWall(authModes[authTab.dataset.authMode]||'front',state.authRole);window.scrollTo(0,0);return}
  const roleChoice=e.target.closest('[data-signup-role]');if(roleChoice){renderAuthWall('signup',roleChoice.dataset.signupRole);return}
  const details=e.target.closest('[data-product-details]');if(details){renderProductDetails(details.dataset.productDetails);return}
  const add=e.target.closest('[data-add]');if(add){const product=state.products.find(p=>p.id===Number(add.dataset.add));if(product)addToCart(product,add);if($('#product-dialog').open)$('#product-dialog').close();return}
  const edit=e.target.closest('[data-edit-product]');if(edit){renderProductEdit(edit.dataset.editProduct);return}
  const filter=e.target.closest('[data-filter]');if(filter){const quickCategory=filter.classList.contains('market-category-tile'),pickedInsidePanel=Boolean(filter.closest('#menu-filter-panel'));state.filter=filter.dataset.filter;if(pickedInsidePanel)state.filterPanelOpen=false;renderBuyerView();if(quickCategory)requestAnimationFrame(()=>document.querySelector('#menu')?.scrollIntoView({behavior:'smooth',block:'start'}));return}
  const removeCart=e.target.closest('[data-remove-cart]');if(removeCart){state.cart.delete(Number(removeCart.dataset.removeCart));resetEmptyBag();accountTools();renderCart();return}
  const quant=e.target.closest('[data-quantity]');if(quant){changeQuantity(quant.dataset.id,Number(quant.dataset.quantity));return}
  const orderButton=e.target.closest('[data-order-action]');if(orderButton){orderButton.disabled=true;try{await orderAction(orderButton)}catch(error){toast(error.message);orderButton.disabled=false}return}
  const stallStatus=e.target.closest('[data-stall-status]');if(stallStatus){stallStatus.disabled=true;try{await api(`/api/admin/stalls/${stallStatus.dataset.stallStatus}`,{method:'PATCH',body:json({status:stallStatus.dataset.nextStatus})});toast(stallStatus.dataset.nextStatus==='paused'?'Stall paused; customers can’t order from it.':'Stall resumed and visible to customers.');await refresh()}catch(error){toast(error.message);stallStatus.disabled=false}return}
  const remove=e.target.closest('[data-delete-product]');if(remove){if(!confirm('Remove this item from your menu?'))return;try{await api(`/api/products/${remove.dataset.deleteProduct}`,{method:'DELETE'});toast('Menu item removed.');await refresh()}catch(error){toast(error.message)}return}
  const action=e.target.closest('[data-action]');if(!action)return;
  if(action.dataset.action==='forgot-password'){showAccountEmailDialog('password-forgot');return}
  if(action.dataset.action==='resend-verification'){
    const email=String(action.dataset.email||$('#auth-form-slot input[name="email"]')?.value||'').trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('Enter your email address first.');$('#auth-form-slot input[name="email"]')?.focus();return}
    action.disabled=true;
    try{const result=await api('/api/email/verification/resend',{method:'POST',body:json({email})});toast(result.message||'If this address needs verification, a new link will arrive shortly.')}
    catch(error){toast(error.message)}finally{action.disabled=false}
    return;
  }
  if(action.dataset.action==='toggle-menu-filters'){state.filterPanelOpen=!state.filterPanelOpen;renderBuyerView();$('[data-action="toggle-menu-filters"]')?.focus();return}
  if(action.dataset.action==='clear-menu-filters'){state.filter='All';state.stallFilter='All';state.dietaryFilter='All';state.allergenFilter='All';state.sort='featured';renderBuyerView();return}
  if(action.dataset.action==='guest-owner-login'){closeSidebar();state.publicBrowse=false;state.authRole='owner';history.pushState({},'','/');renderAuthWall('front','owner');window.scrollTo(0,0);return}
  if(action.dataset.action==='open-sidebar'){state.sidebarOpen=true;syncSidebarState();$('.sidebar-close')?.focus({preventScroll:true});return}
  if(action.dataset.action==='close-sidebar'){closeSidebar();$('.sidebar-menu-button')?.focus({preventScroll:true});return}
  if(action.dataset.action==='show-delete-account'){
    const dialog=$('#delete-account-dialog'),impact=$('#delete-account-impact');
    if(!state.user||!dialog)return;
    if(impact)impact.textContent=state.user.role==='owner'?'Your stall will be paused. Your personal profile details and sign-in will be removed. Past orders will remain with your name hidden.':'Your personal profile details and sign-in will be removed. Past orders will remain with your name hidden.';
    $('#delete-account-form')?.reset();closeSidebar();dialog.showModal();$('#delete-account-password')?.focus({preventScroll:true});return;
  }
  if(action.dataset.action==='cancel-delete-account'){$('#delete-account-dialog').close();return}
  if(action.dataset.action==='toggle-profile'){state.sidebarProfileOpen=!state.sidebarProfileOpen;renderSidebar();return}
  if(action.dataset.action==='toggle-sidebar-settings'){state.sidebarSettingsOpen=!state.sidebarSettingsOpen;renderSidebar();return}
  if(action.dataset.action==='toggle-theme'){
    themeMode=themeMode==='dark'?'light':'dark';
    try{localStorage.setItem('bitehub-theme',themeMode)}catch{}
    applyTheme();return;
  }
  if(action.dataset.action==='export-report'){downloadAdminReport();return}
  if(action.dataset.action==='continue-as-guest'){if($('#cart-dialog').open)$('#cart-dialog').close();if($('#stall-dialog').open)$('#stall-dialog').close();await continueAsGuest();return}
  if(action.dataset.action==='continue-shopping'){
    $('#cart-dialog').close();
    if(state.user?.role==='buyer'||(!state.user&&state.publicBrowse)){state.buyerView='menu';history.pushState({workspace:'buyer',view:'menu'},'','#menu');render();window.scrollTo({top:0,behavior:'smooth'})}
    return;
  }
  if(action.dataset.action==='share-stall'){
    const url=stallShareUrl(action.dataset.stallId);
    if(navigator.share){try{await navigator.share({title:'BiteHub stall',text:'Explore this school food stall on BiteHub.',url});return}catch(error){if(error.name==='AbortError')return}}
    try{await navigator.clipboard.writeText(url);toast('Stall link copied. Share it with your customers.')}catch(_){window.prompt('Copy this stall link:',url)}
    return;
  }
  if(action.dataset.action==='open-cart'){renderCart();return}
  if(action.dataset.action==='logout'){closeSidebar();await api('/api/logout',{method:'POST',body:'{}'});clearTimeout(refreshTimer);if(state.trackingWatch!==null)navigator.geolocation?.clearWatch(state.trackingWatch);state.trackingWatch=null;state.user=null;state.cart.clear();resetEmptyBag();renderAuthWall();toast('You are signed out.');return}
  if(action.dataset.action==='clear-cart'){state.cart.clear();resetEmptyBag();accountTools();renderCart();return}
  if(action.dataset.action==='retry'){await boot();return}
  if(action.dataset.action==='toggle-pause'){try{const result=await api('/api/admin/pause',{method:'POST',body:json({paused:!state.paused})});state.paused=result.ordering_paused;toast(state.paused?'Ordering paused.':'Ordering is open.');await refresh()}catch(error){toast(error.message)}return}
  if(action.dataset.action==='place-order'){
    action.disabled=true;
    try{
      const guest=!state.user,nameInput=$('#guest-order-name'),guestName=nameInput?.value.trim()||'';
      if(guest&&!requireGuestOrderField(nameInput,'Enter the name you want the stall to use.')){action.disabled=false;return}
      const guestSchoolRole=$('#guest-school-role')?.value||'',guestGrade=$('#guest-order-grade')?.value||'',guestSection=$('#guest-order-section')?.value.trim()||'';
      if(guest&&state.fulfillment==='delivery'){
        if(!requireGuestOrderField($('#guest-school-role'),'Choose your school role.')||!requireGuestOrderField($('#guest-order-section'),'Enter your section or office.')){action.disabled=false;return}
        if(['junior_student','senior_student'].includes(guestSchoolRole)&&!requireGuestOrderField($('#guest-order-grade'),'Choose your grade.')){action.disabled=false;return}
      }
      const guestDelivery=guest&&state.fulfillment==='delivery'?{guest_school_role:guestSchoolRole,guest_grade:guestGrade,guest_section:guestSection}:{};
      const result=await api(guest?'/api/guest/orders':'/api/orders',{method:'POST',body:json({...(guest?{guest_name:guestName,...guestDelivery}:{}),fulfillment:state.fulfillment,delivery_location:state.fulfillment==='delivery'?state.deliveryLocation:null,note:$('#order-note').value,items:cartEntries().map(p=>({product_id:p.id,quantity:p.quantity}))})});
      if(guest){if(!result.guest_token||!result.pickup_code)throw new Error('The order was created, but BiteHub could not return its private tracking details. Contact the stall with your order number.');saveGuestOrderAccess({id:result.order_id,token:result.guest_token,code:result.pickup_code});state.guestName=guestName;state.buyerView='orders';history.pushState({workspace:'buyer',view:'orders'},'','#buyer-orders')}
      state.cart.clear();resetEmptyBag();accountTools();$('#cart-dialog').close();
      if(guest)toast(`Order #${result.order_id} sent. Your order code is ${result.pickup_code}.`);else toast(`Order #${result.order_id} sent to the stall.`);
      await refresh();
    }catch(error){toast(error.message);action.disabled=false}
  }
});
document.addEventListener('click',e=>{
  if(e.target.closest('[data-front-role]')&&state.authRole==='owner'&&document.querySelector('#app.auth-open'))renderAuthForm('login','owner',true);
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&state.sidebarOpen){closeSidebar();$('.sidebar-menu-button')?.focus({preventScroll:true})}
});
document.addEventListener('scroll',e=>{if(e.target.matches?.('.featured-rail'))state.featuredScroll=e.target.scrollLeft},{capture:true,passive:true});
$('#cart-dialog').addEventListener('click',e=>{if(e.target===$('#cart-dialog'))$('#cart-dialog').close()});
$('#delete-account-dialog').addEventListener('click',e=>{if(e.target===$('#delete-account-dialog'))$('#delete-account-dialog').close()});
$('#delete-account-dialog').addEventListener('close',()=>$('#delete-account-form').reset());
$('#cart-dialog').addEventListener('input',e=>{
  if(e.target.id==='order-note')state.cartNote=e.target.value;
  if(e.target.id==='guest-order-name')state.guestName=e.target.value;
  if(e.target.id==='guest-order-section')state.guestSection=e.target.value;
});
$('#cart-dialog').addEventListener('change',e=>{
  if(e.target.id==='guest-school-role'){
    state.guestSchoolRole=e.target.value;state.guestGrade='';syncGuestDeliveryFields();
  }
  if(e.target.id==='guest-order-grade')state.guestGrade=e.target.value;
  if(e.target.name==='fulfillment'){
    state.fulfillment=e.target.value;
    $('#delivery-map-wrap').hidden=state.fulfillment!=='delivery';
    document.querySelectorAll('.fulfillment-choice').forEach(choice=>choice.classList.toggle('is-selected',choice.querySelector('input')===e.target));
    syncGuestDeliveryFields();
    if(state.fulfillment==='delivery')enhanceGoogleCampusMaps();
    updateCartCheckoutButton();
  }
});
$('#account-tools').addEventListener('click',e=>{if(e.target.closest('[data-action="logout"]'))return});
document.addEventListener('submit',async e=>{
  const form=e.target.closest('[data-form]');if(!form)return;e.preventDefault();const submit=form.querySelector('button[type="submit"],button:not([type])'),submitLabel=submit?.innerHTML,status=form.querySelector('.auth-front-status');if(submit){submit.disabled=true;if(form.dataset.form==='login'){submit.setAttribute('aria-busy','true');submit.innerHTML='Signing in…'}}if(status){status.textContent='';status.classList.remove('is-visible')}
  try{
    const formData=new FormData(form),values=Object.fromEntries(formData.entries());
    if(form.dataset.form==='guest-entry'){
      const name=String(values.guest_name||'').trim();
      if(!name)throw new Error('Enter your name to continue as a guest.');
      state.guestName=name;
      await continueAsGuest();
      return;
    }
    if(form.dataset.form==='password-forgot'){
      const result=await api('/api/password/forgot',{method:'POST',body:json({email:String(values.email||'').trim().toLowerCase()})});
      if(status){status.textContent=result.message;status.classList.add('is-visible')}
      form.reset();return;
    }
    if(form.dataset.form==='password-reset'){
      if(String(values.password||'')!==String(values.confirm_password||''))throw new Error('The passwords do not match.');
      const result=await api('/api/password/reset',{method:'POST',body:json({token:String(values.token||''),password:String(values.password||'')})});
      $('#auth-dialog').close();history.replaceState({},'',location.pathname+location.hash);state.user=null;renderAuthWall('front','owner');toast(result.message||'Your password has been changed. Sign in with your new password.');return;
    }
    if(form.dataset.form==='delete-account'){
      const result=await api('/api/account/delete',{method:'POST',body:json({password:String(values.password||''),confirm:formData.get('confirm')==='yes'})});
      $('#delete-account-dialog').close();clearTimeout(refreshTimer);
      if(state.trackingWatch!==null)navigator.geolocation?.clearWatch(state.trackingWatch);
      state.trackingWatch=null;state.user=null;state.sidebarOpen=false;state.sidebarProfileOpen=false;state.cart.clear();resetEmptyBag();renderAuthWall();toast(result.message||'Your account has been deleted.');return;
    }
    if(form.dataset.form==='user-profile'){
      const photoFile=formData.get('photo_file'),profile={name:String(values.name||'').trim()};
      if(photoFile instanceof File&&photoFile.size){if(photoFile.size>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(photoFile.type))throw new Error('Choose a JPG, PNG, or WebP profile photo under 2 MB.');profile.photo_data=await fileAsBase64(photoFile);profile.photo_type=photoFile.type}
      else if(formData.get('remove_photo'))profile.remove_photo=true;
      const result=await api('/api/profile',{method:'PATCH',body:json(profile)});state.user=result.user;state.sidebarProfileOpen=false;render();toast('Your profile has been updated.');return;
    }
    if(form.dataset.form==='stall-logo'){
      const logoFile=formData.get('logo_file');delete values.logo_file;delete values.remove_logo;
      if(logoFile instanceof File&&logoFile.size){if(logoFile.size>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(logoFile.type))throw new Error('Choose a JPG, PNG, or WebP logo under 2 MB.');values.logo_data=await fileAsBase64(logoFile);values.logo_type=logoFile.type}
      else if(formData.get('remove_logo'))values.remove_logo=true;
      const result=await api('/api/stall/profile/logo',{method:'PATCH',body:json(values)});state.user.stall_logo_url=result.logo_url;toast(result.logo_url?'Shop logo updated.':'Shop logo removed.');await refresh();return;
    }
    if(['product','product-edit'].includes(form.dataset.form)){
      const photoFile=formData.get('photo_file');delete values.photo_file;delete values.remove_photo;
      if(photoFile instanceof File&&photoFile.size){if(photoFile.size>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(photoFile.type))throw new Error('Choose a JPG, PNG, or WebP photo under 2 MB.');values.photo_data=await fileAsBase64(photoFile);values.photo_type=photoFile.type}
      else if(formData.get('remove_photo'))values.remove_photo=true;
      values.stock_count=values.stock_count===''?null:Number(values.stock_count);
      values.dietary_tags=formData.getAll('dietary_tags');
      values.allergen_tags=formData.getAll('allergen_tags');
    }
    if(form.dataset.form==='signup'){
      const result=await api('/api/signup',{method:'POST',body:json(values)});
      if(result.needs_email_verification){renderEmailVerificationPending(result.email,result.message);return}
      state.user=result.user;applyWorkspaceHash();startAutoRefresh();toast('Stall account created. Your stall is now open to customers.');await refresh();loadNotificationState();await openSharedStall();return;
    }
    if(form.dataset.form==='login'){
      const result=await api('/api/login',{method:'POST',body:json(values)});state.user=result.user;if(state.user.role!=='buyer'){state.cart.clear();resetEmptyBag()}applyWorkspaceHash();startAutoRefresh();$('#auth-dialog').close();toast('Welcome back.');await refresh();loadNotificationState();await openSharedStall();return;
    }
    if(form.dataset.form==='product'){
      values.price=Number(values.price);const result=await api('/api/products',{method:'POST',body:json(values)});toast(`${result.product.name} added to your menu.`);await refresh();return;
    }
    if(form.dataset.form==='product-edit'){
      values.price=Number(values.price);await api(`/api/products/${form.dataset.id}`,{method:'PATCH',body:json(values)});$('#product-edit-dialog').close();toast('Menu item updated.');await refresh();return;
    }
    if(form.dataset.form==='feedback'){
      values.rating=Number(values.rating);await api(`/api/orders/${form.dataset.orderId}/feedback`,{method:'POST',body:json(values)});toast('Thanks for sharing your feedback.');await refresh();return;
    }
    if(form.dataset.form==='stall-hours'){
      values.prep_minutes=Number(values.prep_minutes);const result=await api('/api/stall/hours',{method:'PATCH',body:json(values)});state.user.stall_opens_at=result.opens_at;state.user.stall_closes_at=result.closes_at;state.user.stall_prep_minutes=result.prep_minutes;toast('Stall hours and prep time saved.');await refresh();return;
    }
    if(form.dataset.form==='stall-profile'){
      const result=await api('/api/stall/profile',{method:'PATCH',body:json(values)});state.user.stall_name=result.name;state.user.stall_description=result.description;toast('Public stall profile saved.');await refresh();return;
    }
  }catch(error){if(status){status.textContent=error.message||'Sign in could not be completed. Please try again.';status.classList.add('is-visible')}else toast(error.message)}finally{if(submit){submit.disabled=false;submit.removeAttribute('aria-busy');if(form.dataset.form==='login'&&submitLabel)submit.innerHTML=submitLabel}}
});
document.addEventListener('change',e=>{
  const form=e.target.closest('.sidebar-profile-form');if(!form)return;
  const avatar=form.querySelector('.sidebar-profile-avatar');
  if(e.target.matches('input[name="photo_file"]')&&e.target.files?.[0]){
    const file=e.target.files[0];
    if(file.size>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(file.type)){toast('Choose a JPG, PNG, or WebP profile photo under 2 MB.');e.target.value='';return}
    const url=URL.createObjectURL(file);avatar.innerHTML=`<img src="${url}" alt="Photo preview">`;avatar.querySelector('img').addEventListener('load',()=>URL.revokeObjectURL(url),{once:true});
    const remove=form.querySelector('input[name="remove_photo"]');if(remove)remove.checked=false;
  }
  if(e.target.matches('input[name="remove_photo"]')&&e.target.checked){
    avatar.textContent=state.user?.name?.trim().charAt(0).toUpperCase()||'?';
    const photo=form.querySelector('input[name="photo_file"]');if(photo)photo.value='';
  }
});
async function boot(){
  const isRunnerLink=location.hash.startsWith('#runner-track=');
  const authLinkParams=new URLSearchParams(location.search);
  const verificationToken=authLinkParams.get('verify_email')||'';
  const passwordResetToken=authLinkParams.get('reset_password')||'';
  const isAccountEmailLink=Boolean(verificationToken||passwordResetToken);
  const finishLoading=beginSlowLoadFeedback();
  try{if(isRunnerLink){publicRunnerTracking=runnerTrackingFromHash();document.title='Share delivery location · BiteHub';renderRunnerSharePage(publicRunnerTracking?.orderId,Boolean(publicRunnerTracking));return}if(isAccountEmailLink){history.replaceState({},'',location.pathname+location.hash);state.publicBrowse=false;state.user=null;renderAuthWall('front','owner');if(verificationToken){try{const result=await api('/api/email/verify',{method:'POST',body:json({token:verificationToken})});const status=$('.auth-front-status');if(status){status.textContent=result.message;status.classList.add('is-visible')}else toast(result.message)}catch(error){const status=$('.auth-front-status');if(status){status.textContent=error.message;status.classList.add('is-visible')}else toast(error.message)}}else showAccountEmailDialog('password-reset',passwordResetToken);return}const session=await api('/api/session');state.user=session.user;if(state.user){applyWorkspaceHash();startAutoRefresh();await refresh();loadNotificationState();await openSharedStall()}else{if(session.guest_session){state.guestSessionId=session.guest_session.id;state.guestName=session.guest_session.name;state.publicBrowse=true}if(state.publicBrowse){applyWorkspaceHash();await refresh();await openSharedStall();startAutoRefresh()}else renderAuthWall()}}
  catch(error){renderError(`${error.message} Start the server with “py server.py” from the FOODHUB folder.`)}
  finally{finishLoading();dismissOpeningSplash();if(!isRunnerLink&&!isAccountEmailLink)showPrototypePolicyNotice()}
}
function escapePolicyHTML(value){
  return String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}
function renderPolicyInline(value){
  return escapePolicyHTML(value)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,'<em>$1</em>')
    .replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<span class="policy-document-reference">$1</span>');
}
function renderPolicyMarkdown(markdown){
  const lines=String(markdown).replace(/\r/g,'').split('\n'),output=[];
  let paragraph=[],listType='',listItems=[];
  const flushParagraph=()=>{if(paragraph.length){output.push('<p>'+renderPolicyInline(paragraph.join(' '))+'</p>');paragraph=[]}};
  const flushList=()=>{if(listType){output.push('<'+listType+'>'+listItems.map(item=>'<li>'+renderPolicyInline(item)+'</li>').join('')+'</'+listType+'>');listType='';listItems=[]}};
  const flushBlocks=()=>{flushParagraph();flushList()};
  for(let index=0;index<lines.length;index++){
    const line=lines[index].trim();
    if(!line){flushBlocks();continue}
    if(line.startsWith('|')){
      flushBlocks();
      const rows=[];
      while(index<lines.length&&lines[index].trim().startsWith('|')){
        rows.push(lines[index].trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim()));
        index++;
      }
      index--;
      const contentRows=rows.filter(row=>!row.every(cell=>/^:?-{3,}:?$/.test(cell)));
      if(contentRows.length){
        const header=contentRows[0].map(cell=>'<th>'+renderPolicyInline(cell)+'</th>').join('');
        const body=contentRows.slice(1).map(row=>'<tr>'+row.map(cell=>'<td>'+renderPolicyInline(cell)+'</td>').join('')+'</tr>').join('');
        output.push('<div class="policy-table-wrap"><table><thead><tr>'+header+'</tr></thead><tbody>'+body+'</tbody></table></div>');
      }
      continue;
    }
    const heading=line.match(/^(#{1,4})\s+(.+)$/);
    if(heading){flushBlocks();const tag='h'+Math.min(heading[1].length+2,6);output.push('<'+tag+'>'+renderPolicyInline(heading[2])+'</'+tag+'>');continue}
    if(/^(-{3,}|\*{3,})$/.test(line)){flushBlocks();output.push('<hr>');continue}
    if(line.startsWith('> ')){flushBlocks();output.push('<blockquote>'+renderPolicyInline(line.slice(2))+'</blockquote>');continue}
    const unordered=line.match(/^[-*]\s+(.+)$/),ordered=line.match(/^\d+\.\s+(.+)$/);
    if(unordered||ordered){
      flushParagraph();
      const nextType=unordered?'ul':'ol';
      if(listType&&listType!==nextType)flushList();
      listType=nextType;
      listItems.push((unordered||ordered)[1]);
      continue;
    }
    if(listType)flushList();
    paragraph.push(line);
  }
  flushBlocks();
  return output.join('');
}
const policyDocumentDialog=$('#policy-document-dialog');
const policyDocumentTitle=$('#policy-document-title');
const policyDocumentContent=$('#policy-document-content');
const policyDocumentTitles={
  'PRIVACY_NOTICE_DRAFT.md':'Privacy Notice draft',
  'TERMS_OF_USE_DRAFT.md':'Terms of Use draft',
  'COOKIE_AND_LOCATION_NOTICES_DRAFT.md':'Cookies & location draft',
  'CHILD_FRIENDLY_PRIVACY_SUMMARY_DRAFT.md':'Student privacy guide draft'
};
async function openPolicyDocument(href){
  let url;
  try{url=new URL(href,location.href)}catch{return}
  if(url.origin!==location.origin||!url.pathname.startsWith('/legal_drafts/'))return;
  const filename=decodeURIComponent(url.pathname.split('/').pop());
  policyDocumentTitle.textContent=policyDocumentTitles[filename]||'BiteHub draft document';
  policyDocumentContent.textContent='Loading document…';
  if(!policyDocumentDialog.open)policyDocumentDialog.showModal();
  try{
    const response=await fetch(url.pathname,{credentials:'same-origin',headers:{Accept:'text/plain'}});
    if(!response.ok)throw new Error('Document request failed');
    policyDocumentContent.innerHTML=renderPolicyMarkdown(await response.text());
    policyDocumentContent.scrollTop=0;
  }catch{
    policyDocumentContent.textContent='This draft could not be loaded. Please close this window and try again.';
  }
}
document.addEventListener('click',event=>{
  const link=event.target.closest('a[href^="/legal_drafts/"]');
  if(!link)return;
  event.preventDefault();
  openPolicyDocument(link.href);
});
policyDocumentDialog?.addEventListener('click',event=>{if(event.target===policyDocumentDialog)policyDocumentDialog.close()});
const prototypePolicyDialog=$('#prototype-policy-dialog');
function showPrototypePolicyNotice(){
  if(!prototypePolicyDialog||prototypePolicyDialog.open)return;
  try{if(localStorage.getItem('bitehub-prototype-notice-v1')==='seen')return}catch{}
  prototypePolicyDialog.showModal();
}
$('#prototype-policy-continue')?.addEventListener('click',()=>{
  try{localStorage.setItem('bitehub-prototype-notice-v1','seen')}catch{}
  prototypePolicyDialog?.close();
});
boot();
