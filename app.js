const state={user:null,publicBrowse:new URLSearchParams(location.search).has('stall'),products:[],featuredProducts:[],heroFeaturedIndex:0,featuredScroll:0,featuredPaused:false,featuredTimer:null,orders:[],runners:[],overview:null,adminReports:null,reportRange:'30',reachAnalytics:null,paused:false,cart:new Map(),cartNote:'',fulfillment:'pickup',deliveryLocation:null,mapZoom:1,trackingWatch:null,lastLocationSent:0,filter:'All',query:'',sort:'featured',stallFilter:'All',dietaryFilter:'All',allergenFilter:'All',buyerView:'menu',ownerView:'dashboard',adminView:'overview',authRole:'buyer',pushEnabled:false,pushAvailable:false,sidebarOpen:false,sidebarSettingsOpen:false,sidebarProfileOpen:false};
const $=s=>document.querySelector(s), root=$('#view-content'), toastNode=$('#toast'), openingSplash=$('#opening-splash');
function dismissOpeningSplash(){
  if(!openingSplash?.isConnected)return;
  openingSplash.classList.add('is-exiting');
  setTimeout(()=>openingSplash.remove(),460);
}
let refreshTimer;
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
const LEGACY_SCHOOL_LOCATIONS={pns:{center:{latitude:9.738599,longitude:118.738974},radius:1500},psu:{center:{latitude:9.77673,longitude:118.73353},radius:1500}};
function activeCampus(){
  const legacy=LEGACY_SCHOOL_LOCATIONS[state.user?.school_id],latitude=Number(state.user?.school_latitude??legacy?.center.latitude??12.8797),longitude=Number(state.user?.school_longitude??legacy?.center.longitude??121.774),radius=Number(state.user?.delivery_radius_m)||legacy?.radius||1500;
  const latSpan=radius/111320,lonSpan=radius/(111320*Math.max(.2,Math.cos(latitude*Math.PI/180)));
  return{center:{latitude,longitude},radius,south:latitude-latSpan,north:latitude+latSpan,west:longitude-lonSpan,east:longitude+lonSpan};
}
function googleMapsPointUrl(point=null){const location=point||activeCampus().center;const params=new URLSearchParams({api:'1',query:`${location.latitude},${location.longitude}`});return `https://www.google.com/maps/search/?${params.toString()}`}
function googleMapsRouteUrl(origin,destination){const params=new URLSearchParams({api:'1',destination:`${destination.latitude},${destination.longitude}`,travelmode:'walking'});if(origin)params.set('origin',`${origin.latitude},${origin.longitude}`);return `https://www.google.com/maps/dir/?${params.toString()}`}
function mapXY(latitude,longitude){const campus=activeCampus();return{x:((longitude-campus.west)/(campus.east-campus.west))*100,y:100-((latitude-campus.south)/(campus.north-campus.south))*100}}
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
  const routeMeters=remaining*1.3+40,fast=Math.max(1,Math.ceil(routeMeters/(1.25*60))),slow=Math.max(fast,Math.ceil(routeMeters/(0.85*60)));
  return fast===slow?`Estimated arrival · about ${fast} min`:`Estimated arrival · about ${fast}–${slow} min`;
}
function mapViewBox(){const span=100/state.mapZoom;return `${50-span/2} ${50-span/2} ${span} ${span}`}
function setMapZoom(action){state.mapZoom=action==='reset'?1:Math.max(1,Math.min(4,state.mapZoom*(action==='in'?1.5:1/1.5)));document.querySelectorAll('.campus-map').forEach(map=>map.setAttribute('viewBox',mapViewBox()))}
function campusMap(order,interactive=false){
  const destination=interactive?state.deliveryLocation:(order?.delivery_latitude!=null?{latitude:order.delivery_latitude,longitude:order.delivery_longitude}:null);
  const driver=order?.driver_latitude!=null?{latitude:order.driver_latitude,longitude:order.driver_longitude}:null;
  const stall=order?.stall_latitude!=null?{latitude:order.stall_latitude,longitude:order.stall_longitude}:null;
  const pin=(point,label,kind)=>{if(!point)return'';const p=mapXY(point.latitude,point.longitude);return `<circle class="map-pin map-pin-${kind}" cx="${p.x}" cy="${p.y}" r="3.1"><title>${label}</title></circle>`};
  const path=driver&&destination?(()=>{const a=mapXY(driver.latitude,driver.longitude),b=mapXY(destination.latitude,destination.longitude);return `<path class="map-route" d="M${a.x},${a.y} L${b.x},${b.y}"/>`})():'';
  const pointData=(point,name)=>point?`data-${name}-latitude="${point.latitude}" data-${name}-longitude="${point.longitude}"`:'';
  return `<div class="campus-map-shell" data-campus-map="true" data-map-mode="${interactive?'picker':'tracking'}" ${pointData(stall,'stall')} ${pointData(destination,'destination')} ${pointData(driver,'driver')}><svg class="campus-map ${interactive?'is-picker':''}" viewBox="${mapViewBox()}" preserveAspectRatio="none" role="${interactive?'button':'img'}" ${interactive?'data-map-picker tabindex="0" aria-label="Select delivery point in your school area"':'aria-label="School delivery map"'}><rect width="100" height="100" fill="#edf2e7"/><path d="M-8 25 108 75M15-8 84 108M-8 78 108 28M70-8 28 108" stroke="#fff" stroke-width="8"/><path d="M-8 25 108 75M15-8 84 108M-8 78 108 28M70-8 28 108" stroke="#d4dfd0" stroke-width="1"/>${path}${pin(stall,'Stall pickup','stall')}${pin(destination,'Handoff point','destination')}${pin(driver,'Runner location','driver')}</svg><div class="map-zoom-controls" aria-label="Map zoom controls"><button type="button" data-map-zoom="in" aria-label="Zoom in">+</button><button type="button" data-map-zoom="out" aria-label="Zoom out">−</button><button type="button" data-map-zoom="reset" aria-label="Reset zoom">Reset</button></div></div>`;
}
function toast(message){toastNode.textContent=message;toastNode.classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastNode.classList.remove('is-visible'),2800)}
async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body.error||`Request failed (${response.status}).`);
  return body;
}
const json=data=>JSON.stringify(data);
async function loadGoogleMapsApi(){
  if(window.google?.maps)return window.google.maps;
  if(!googleMapsPromise){
    googleMapsPromise=(async()=>{
      const config=await api('/api/maps/config');
      const key=String(config.google_maps_api_key||'').trim();
      if(!key)return null;
      return new Promise((resolve,reject)=>{
        const callbackName='bitehubGoogleMapsReady';
        const timeout=setTimeout(()=>reject(new Error('Google Maps did not finish loading.')),12000);
        window[callbackName]=()=>{clearTimeout(timeout);delete window[callbackName];resolve(window.google?.maps||null)};
        const script=document.createElement('script');
        script.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=${callbackName}&loading=async&v=weekly`;
        script.async=true;script.defer=true;script.onerror=()=>{clearTimeout(timeout);delete window[callbackName];reject(new Error('Google Maps could not load.'))};
        document.head.appendChild(script);
      });
    })().catch(()=>null);
  }
  return googleMapsPromise;
}
function googleCampusMarker(record,kind,point,title,color){
  const previous=record.markers[kind];
  if(!point){previous?.setMap(null);delete record.markers[kind];return}
  const position={lat:Number(point.latitude),lng:Number(point.longitude)};
  if(previous){previous.setPosition(position);return}
  const marker=new record.maps.Marker({map:record.map,position,title,icon:{path:record.maps.SymbolPath.CIRCLE,scale:8,fillColor:color,fillOpacity:1,strokeColor:'#fff',strokeWeight:2}});
  record.markers[kind]=marker;
}
function setDeliveryPoint(latitude,longitude,shell=null){
  const campus=activeCampus();
  if(distanceMeters(campus.center,{latitude,longitude})>campus.radius){toast(`Choose a handoff point within ${campus.radius.toLocaleString()} metres of your school.`);return}
  state.deliveryLocation={latitude:Number(latitude),longitude:Number(longitude)};
  const mapShell=shell||$('#delivery-map-wrap .campus-map-shell'),mapRecord=mapShell&&googleCampusMaps.get(mapShell);
  if(mapRecord)googleCampusMarker(mapRecord,'destination',state.deliveryLocation,'Handoff point','#d95f7d');
  else if(mapShell?.querySelector('.campus-map')){mapShell.outerHTML=campusMap(null,true);enhanceGoogleCampusMaps()}
  const status=$('#delivery-map-status');if(status)status.textContent='Handoff point selected';
  const googleLink=$('#delivery-google-link');if(googleLink){googleLink.href=googleMapsPointUrl(state.deliveryLocation);googleLink.innerHTML='Open handoff point in Google Maps <span aria-hidden="true">↗</span>'}
  updateCartCheckoutButton();
}
async function enhanceGoogleCampusMaps(){
  const shells=[...document.querySelectorAll('.campus-map-shell[data-campus-map]')].filter(shell=>!googleCampusMaps.has(shell)&&!shell.closest('[hidden]'));
  if(!shells.length)return;
  const maps=await loadGoogleMapsApi();
  if(!maps)return;
  for(const shell of shells){
    if(!shell.isConnected||googleCampusMaps.has(shell))continue;
    const fallback=shell.querySelector('.campus-map');if(!fallback)continue;
    const mode=shell.dataset.mapMode,campus=activeCampus();
    const pointFromData=(name)=>{const latitude=Number(shell.dataset[`${name}Latitude`]),longitude=Number(shell.dataset[`${name}Longitude`]);return Number.isFinite(latitude)&&Number.isFinite(longitude)?{latitude,longitude}:null};
    const host=document.createElement('div');host.className='google-campus-map';host.setAttribute('role',mode==='picker'?'application':'img');host.setAttribute('aria-label',mode==='picker'?'Google Map. Click within your school delivery area to choose a handoff.':'Google Map showing the delivery handoff and runner.');
    fallback.replaceWith(host);
    const zoomControls=shell.querySelector('.map-zoom-controls');if(zoomControls)zoomControls.hidden=true;
    const destination=mode==='picker'?state.deliveryLocation:pointFromData('destination');
    const driver=pointFromData('driver'),stall=pointFromData('stall');
    const center=destination||driver||stall||campus.center;
    const map=new maps.Map(host,{center:{lat:center.latitude,lng:center.longitude},zoom:campus.radius<1000?17:16,minZoom:14,maxZoom:21,mapTypeId:'roadmap',mapTypeControl:false,streetViewControl:false,fullscreenControl:false,gestureHandling:'cooperative',restriction:{latLngBounds:{north:campus.north,south:campus.south,east:campus.east,west:campus.west},strictBounds:true}});
    const record={map,maps,markers:{}};googleCampusMaps.set(shell,record);
    new maps.Circle({map,center:{lat:campus.center.latitude,lng:campus.center.longitude},radius:campus.radius,fillColor:'#7650c9',fillOpacity:.055,strokeColor:'#7650c9',strokeOpacity:.65,strokeWeight:2,clickable:false});
    if(mode==='picker'){
      googleCampusMarker(record,'destination',state.deliveryLocation,'Handoff point','#d95f7d');
      map.addListener('click',event=>{if(event.latLng)setDeliveryPoint(event.latLng.lat(),event.latLng.lng(),shell)});
    }else{
      googleCampusMarker(record,'stall',stall,'Stall pickup','#cd7b3e');
      googleCampusMarker(record,'destination',destination,'Handoff point','#d95f7d');
      googleCampusMarker(record,'driver',driver,'Runner location','#3b77bd');
      if(driver&&destination)new maps.Polyline({map,path:[{lat:driver.latitude,lng:driver.longitude},{lat:destination.latitude,lng:destination.longitude}],strokeColor:'#7049b2',strokeOpacity:.8,strokeWeight:4});
      const points=[stall,driver,destination].filter(Boolean);
      if(points.length>1){const bounds=new maps.LatLngBounds();points.forEach(point=>bounds.extend({lat:point.latitude,lng:point.longitude}));map.fitBounds(bounds,32)}
    }
  }
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
  const result=$('.menu-controls .result-count');if(!result)return;
  const stalls=[...new Map(state.products.map(product=>[product.stall_id,product.stall_name])).entries()];
  const stallOptions=stalls.map(([id,name])=>`<option value="${id}" ${state.stallFilter===String(id)?'selected':''}>${esc(name)}</option>`).join('');
  result.insertAdjacentHTML('beforebegin',`<label class="catalog-select">Stall<select id="stall-filter"><option value="All">All stalls</option>${stallOptions}</select></label><label class="catalog-select">Dietary<select id="dietary-filter"><option value="All">Any</option>${dietaryOptions.map(([value,label])=>`<option value="${value}" ${state.dietaryFilter===value?'selected':''}>${label}</option>`).join('')}</select></label><label class="catalog-select">Avoid<select id="allergen-filter"><option value="All">No filter</option>${allergenOptions.map(([value,label])=>`<option value="${value}" ${state.allergenFilter===value?'selected':''}>${label}</option>`).join('')}</select></label><small class="allergen-disclaimer">Allergen details are stall-provided; confirm directly when needed.</small>`);
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
function renderFeaturedPicks(){
  const picks=state.featuredProducts;
  if(!picks.length)return'';
  return `<section class="featured-section" aria-labelledby="featured-title"><div class="featured-heading"><div><span class="eyebrow">FRESH FINDS AROUND CAMPUS</span><h2 id="featured-title">Today’s Campus Picks <span aria-hidden="true">✦</span></h2><p>Stall-owner favorites, featured for the next 24 hours.</p></div><div class="featured-controls"><button type="button" class="featured-control" data-feature-move="-1" aria-label="Previous campus picks">←</button><button type="button" class="featured-control" data-feature-move="1" aria-label="Next campus picks">→</button><button type="button" class="featured-motion" data-feature-pause aria-pressed="${state.featuredPaused}">${state.featuredPaused?'Play':'Pause'} rotation</button></div></div><div class="featured-rail" aria-label="Featured campus menu items">${picks.map(item=>`<article class="featured-card"><div class="featured-photo">${item.photo_url?`<img src="${esc(item.photo_url)}" alt="${esc(item.name)}" loading="lazy">`:`<span aria-hidden="true">${esc(item.emoji)}</span>`}<span class="featured-ribbon">✦ TODAY’S PICK</span></div><div class="featured-copy"><button class="featured-stall featured-stall-link" data-stall-profile="${item.stall_id}"><span class="stall-mini-logo">${item.stall_logo_url?`<img src="${esc(item.stall_logo_url)}" alt="">`:`${esc(item.stall_name.trim().charAt(0).toUpperCase())}`}</span>${esc(item.stall_name)}</button><h3>${esc(item.name)}</h3><p>${esc(item.description||'A fresh campus favorite, ready for your break.')}</p><div class="featured-buy"><strong>${money(item.price)}</strong><button class="button button-primary button-small" data-add="${item.id}" ${state.paused||!item.stall_open||!item.available?'disabled':''}>${state.paused?'Paused':!item.stall_open?'Closed':!item.available?'Sold out':'Add to bag +'}</button></div></div></article>`).join('')}</div><small class="featured-fairness">Featured stalls rotate daily · Each stall can feature one item at a time</small></section>`;
}
function buyerHeroItems(){return state.featuredProducts.length?state.featuredProducts:state.products}
function startFeaturedMotion(){
  if(state.featuredTimer){clearInterval(state.featuredTimer);state.featuredTimer=null}
  if(!buyerHeroItems().length||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
  state.featuredTimer=setInterval(()=>{
    if(state.featuredPaused||document.visibilityState!=='visible'||$('.featured-rail:hover')||$('.buyer-banner .banner-art:hover')||(document.activeElement?.closest('.featured-section')&&!document.activeElement?.matches('[data-feature-pause]'))||document.activeElement?.closest('.buyer-banner .banner-art'))return;
    if(buyerHeroItems().length>1)setBuyerHeroFeature(state.heroFeaturedIndex+1);
    const rail=$('.featured-rail'),card=rail?.querySelector('.featured-card');if(!rail||!card)return;
    const step=card.getBoundingClientRect().width+12,max=rail.scrollWidth-rail.clientWidth;
    if(max<4)return;
    const next=rail.scrollLeft+step;
    rail.scrollTo({left:next>=max-4?0:next,behavior:'smooth'});
  },6500);
}
function accountTools(){
  const tools=$('#account-tools');
  if(!state.user){tools.hidden=!state.publicBrowse;tools.innerHTML=state.publicBrowse?`<button class="button button-outline button-compact" data-action="open-cart">Your bag${cartCount()?` (${cartCount()})`:''}</button><button class="button button-primary button-compact" data-action="guest-signin">Sign in to order</button>`:'';closeSidebar();updateCartShortcut();return}
  tools.hidden=false;
  const school=state.user.school_name||(state.user.school_id==='psu'?'Palawan State University':state.user.school_id==='pns'?'Palawan National School':'Your school');
  tools.innerHTML=`<button class="sidebar-menu-button" type="button" data-action="open-sidebar" aria-label="Open dashboard menu" aria-expanded="${state.sidebarOpen}"><span></span><span></span><span></span></button>${state.user.role==='buyer'?`<button class="button button-outline button-compact header-bag" data-action="open-cart">Your bag${cartCount()?` (${cartCount()})`:''}</button>`:''}<div class="account-chip"><span class="avatar">${state.user.profile_photo_url?`<img src="${esc(state.user.profile_photo_url)}" alt="">`:esc(state.user.name.trim().charAt(0).toUpperCase())}</span><span><strong>${esc(state.user.name)}</strong><small>${esc(roleLabel[state.user.role])} · ${esc(school)}${state.user.stall_name?` · ${esc(state.user.stall_name)}`:''}</small></span></div>`;
  renderSidebar();
  updateCartShortcut();
}
function renderSidebar(){
  const user=state.user,account=$('#sidebar-account'),navigation=$('#sidebar-navigation');
  if(!user||!account||!navigation)return;
  const school=user.school_name||(user.school_id==='psu'?'Palawan State University':user.school_id==='pns'?'Palawan National School':'Your school');
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
  const open=Boolean(state.sidebarOpen&&state.user);
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
    try{const menu=await api('/api/products');state.products=menu.products;state.featuredProducts=menu.featured_products||[];state.paused=menu.ordering_paused;state.orders=[];render()}
    catch(error){renderError(error.message)}
    finally{refreshInFlight=false}
    return;
  }
  if(refreshInFlight)return;
  refreshInFlight=true;
  const userId=state.user.id;
  const role=state.user.role,now=Date.now();
  const loadMenu=includeMenu||now-lastMenuRefresh>=15000;
  const loadReach=role==='owner'&&(includeMenu||now-lastReachRefresh>=60000);
  const loadOverview=role==='admin'&&(includeMenu||now-lastOverviewRefresh>=15000);
  const loadReports=role==='admin'&&(includeMenu||now-lastReportsRefresh>=30000);
  const loadRunners=role==='owner'&&loadMenu;
  try{
    const [menu,orders,reach,overview,reports,runners]=await Promise.all([
      loadMenu?api('/api/products'):Promise.resolve(null),api('/api/orders'),
      loadReach?api('/api/stall/analytics'):Promise.resolve(null),
      loadOverview?api('/api/admin/overview'):Promise.resolve(null),
      loadReports?api('/api/admin/reports'):Promise.resolve(null),
      loadRunners?api('/api/runners'):Promise.resolve(null)]);
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
      if(runners)state.runners=runners.runners;
    }
    if(state.user?.id!==userId)return;
    render();
    orderBaselineUserId=userId;
    if(state.user.role==='buyer'&&changedOrders.length){
      const order=changedOrders[0],status=statusLabel[order.status]||order.status;
      toast(changedOrders.length===1?`Order #${order.id} is now ${status.toLowerCase()}.`:`You have ${changedOrders.length} order status updates.`);
    }
  }catch(error){if(state.user?.id===userId){if(orderBaselineUserId===userId)toast(`Connection interrupted. Showing the last loaded information; retrying automatically. ${error.message}`);else renderError(error.message)}}
  finally{refreshInFlight=false}
}
function startAutoRefresh(){
  clearTimeout(refreshTimer);
  if(!state.user&&!state.publicBrowse)return;
  const canRefresh=()=>Boolean(state.user||state.publicBrowse);
  const schedule=delay=>{
    refreshTimer=setTimeout(async()=>{
      if(document.visibilityState==='visible'&&!document.querySelector('dialog[open]')&&!document.activeElement?.closest('form')&&!document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')&&!root.querySelector('.product-add-panel[open],.product-extra-fields[open]'))await refresh(false);
      if(canRefresh())schedule(document.visibilityState==='visible'?(state.user?(state.orders.some(order=>order.status==='out'&&order.fulfillment==='delivery')?3000+Math.random()*1000:4000+Math.random()*1000):8000+Math.random()*2000):30000);
    },delay);
  };
  schedule(document.visibilityState==='visible'?(state.user?3500+Math.random()*1000:8000+Math.random()*2000):30000);
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&(state.user||state.publicBrowse)){clearTimeout(refreshTimer);refresh(false).finally(startAutoRefresh)}});
const workspaceHashMap={'#menu':['buyer','menu'],'#buyer-orders':['buyer','orders'],'#owner-dashboard':['owner','dashboard'],'#owner-orders':['owner','orders'],'#owner-menu':['owner','menu'],'#owner-stall':['owner','stall'],'#owner-insights':['owner','insights'],'#admin-overview':['admin','overview'],'#admin-stalls':['admin','stalls'],'#admin-orders':['admin','orders'],'#admin-reports':['admin','reports'],'#admin-accounts':['admin','accounts']};
function applyWorkspaceHash(){
  const before=`${state.buyerView}|${state.ownerView}|${state.adminView}`;
  const target=workspaceHashMap[location.hash],role=target?.[0],view=target?.[1];
  if(!target){if(state.user?.role==='buyer'||(!state.user&&state.publicBrowse))state.buyerView='menu';if(state.user?.role==='owner')state.ownerView='dashboard';if(state.user?.role==='admin')state.adminView='overview'}
  else{
  if(role==='buyer'&&state.user?.role==='buyer')state.buyerView=view;
  else if(role==='buyer'&&!state.user&&state.publicBrowse)state.buyerView='menu';
  if(role==='owner'&&state.user?.role==='owner')state.ownerView=view;
  if(role==='admin'&&state.user?.role==='admin')state.adminView=view;
  }
  return before!==`${state.buyerView}|${state.ownerView}|${state.adminView}`;
}
window.addEventListener('popstate',()=>{if((state.user||state.publicBrowse)&&applyWorkspaceHash())render()});
window.addEventListener('hashchange',()=>{if((state.user||state.publicBrowse)&&applyWorkspaceHash())render()});
function renderAuthWall(mode='choose',role=state.authRole){
  state.authRole=role;
  accountTools();
  document.querySelector('#app')?.classList.add('auth-open');
  updateCartShortcut();
  const choosing=mode==='choose';
  const masthead=`<div class="auth-masthead"><a class="brand auth-brand" href="#home" aria-label="BiteHub home"><img class="brand-mark auth-round-logo" src="assets/bitehub-icon.png" alt=""><img class="auth-wordmark" src="assets/bitehub-wordmark.png" alt="BiteHub"><span class="brand-tagline">Food for every school community</span></a></div>`;
  const buyerArt=`<svg viewBox="0 0 220 170" aria-hidden="true"><circle cx="108" cy="86" r="67" fill="#acd3ff"/><path d="M35 155c8-38 34-57 73-57s65 19 75 57" fill="#3678d3"/><path d="M80 104l28 25 27-25 12 51H67z" fill="#fff"/><path d="M90 78h38v34c-9 13-27 13-38 0z" fill="#f2ad85"/><ellipse cx="109" cy="63" rx="32" ry="37" fill="#f5bd96"/><path d="M77 65c-3-31 10-47 34-47 21 0 34 17 31 43-8-5-13-16-15-23-13 13-30 18-50 17z" fill="#263247"/><circle cx="97" cy="65" r="2.7" fill="#20384d"/><circle cx="120" cy="65" r="2.7" fill="#20384d"/><path d="M99 81q10 8 20 0" fill="none" stroke="#b65a4a" stroke-width="2.5" stroke-linecap="round"/><rect x="147" y="77" width="27" height="46" rx="6" fill="#20384d" transform="rotate(9 147 77)"/><rect x="151" y="83" width="19" height="31" rx="2" fill="#d8e9ff" transform="rotate(9 151 83)"/><path d="M45 58l5 10 11 2-9 7 1 11-8-7-10 4 4-10-6-8 11 1z" fill="#fff"/></svg>`;
  const ownerArt=`<svg viewBox="0 0 220 170" aria-hidden="true"><circle cx="110" cy="91" r="67" fill="#ffe0ad"/><rect x="42" y="47" width="136" height="98" rx="9" fill="#fff"/><path d="M35 53l14-29h122l14 29z" fill="#f58228"/><path d="M49 24h27L65 53H35zM76 24h27V53H65zM103 24h27V53h-27zM130 24h27l16 29h-27z" fill="#fff4e7"/><path d="M35 53h29v15c0 16-29 16-29 0zM64 53h29v15c0 16-29 16-29 0zM93 53h29v15c0 16-29 16-29 0zM122 53h29v15c0 16-29 16-29 0zM151 53h29v15c0 16-29 16-29 0z" fill="#f58228"/><path d="M61 145c7-27 24-39 49-39 26 0 43 12 50 39" fill="#263f63"/><path d="M96 105h29v25l-15 13-14-13z" fill="#fff"/><ellipse cx="111" cy="82" rx="25" ry="29" fill="#f2b28b"/><path d="M86 81c-2-24 8-36 27-36 18 0 27 13 26 33-9-2-18-10-22-18-9 11-18 17-31 21z" fill="#302a30"/><path d="M99 84h4m17 0h4" stroke="#23384d" stroke-width="3" stroke-linecap="round"/><path d="M103 96q8 6 16 0" fill="none" stroke="#b65a4a" stroke-width="2" stroke-linecap="round"/><rect x="79" y="119" width="64" height="27" rx="5" fill="#fff" stroke="#d6e1e9"/><path d="M91 133h40" stroke="#e8793d" stroke-width="4" stroke-linecap="round"/></svg>`;
  const adminArt=`<svg viewBox="0 0 220 170" aria-hidden="true"><circle cx="108" cy="82" r="66" fill="#bfe8ce"/><path d="M47 151c8-32 29-48 62-48s54 16 63 48" fill="#267c59"/><path d="M90 99h39v25l-19 14-20-14z" fill="#fff"/><ellipse cx="109" cy="68" rx="30" ry="34" fill="#f1b58e"/><path d="M79 68c-3-28 9-42 31-42 21 0 32 14 30 40-8-2-14-9-18-17-12 10-26 15-43 14z" fill="#1f2f44"/><circle cx="97" cy="69" r="3" fill="#20384d"/><circle cx="121" cy="69" r="3" fill="#20384d"/><path d="M88 64h18m9 0h18m-27 0h9" stroke="#20384d" stroke-width="3"/><path d="M101 84q8 6 16 0" fill="none" stroke="#ad574d" stroke-width="2" stroke-linecap="round"/><rect x="65" y="120" width="94" height="38" rx="5" fill="#263d59"/><rect x="73" y="125" width="78" height="25" rx="2" fill="#dceeff"/><path d="M54 159h116l-9 7H63z" fill="#4276a3"/><circle cx="147" cy="40" r="21" fill="#fff"/><path d="M147 27l4 6 7 1-4 6 1 7-7-3-6 3 1-7-5-5 7-2z" fill="#24845c"/><circle cx="54" cy="47" r="5" fill="#fff"/><path d="M177 85l5 5m-5 0 5-5" stroke="#35a16c" stroke-width="3" stroke-linecap="round"/></svg>`;
  root.innerHTML=`<section class="role-home">${masthead}<header class="role-heading"><span class="eyebrow">${choosing?'WELCOME TO BITEHUB':'YOUR SCHOOL FOOD HUB'}</span><h1>${choosing?'Choose your <span>role</span>':mode==='login'?'Welcome back':'Join BiteHub'}</h1><p>${choosing?"Your school’s food hub starts here.":mode==='login'?'Sign in to continue to your school workspace.':'Create an account for your school’s BiteHub.'}</p>${choosing?'<small class="role-prompt">Choose how you’d like to get started.</small>':''}</header>${choosing?`<div class="role-card-grid"><button class="role-choice role-buyer" data-signup-role="buyer"><span class="role-kicker">Discover &amp; order</span><span class="role-art">${buyerArt}</span><strong>Buyer / Customer</strong><small>Browse school menus, place orders,<br>and follow your delivery.</small><span class="role-choice-action">Sign up <b>→</b></span></button><button class="role-choice role-owner" data-signup-role="owner"><span class="role-kicker">Grow your stall</span><span class="role-art">${ownerArt}</span><strong>Stall Owner</strong><small>Publish your menu and manage<br>your stall orders.</small><span class="role-choice-action">Sign up <b>→</b></span></button><button class="role-choice role-admin" data-auth-mode="login" data-auth-role="admin"><span class="role-kicker">School team</span><span class="role-art">${adminArt}</span><strong>Admin</strong><small>Manage school stalls and<br>keep ordering on track.</small><span class="role-choice-action">Admin sign in <b>→</b></span></button></div><p class="role-login">Already have an account? <button class="text-button" data-auth-mode="login">Sign in</button></p>`:`<section class="auth-card"><button class="text-button auth-back" data-auth-mode="choose">← Choose a role</button><div id="auth-form-slot"></div><p class="auth-footnote">Accounts, orders, and menus are saved to this server.</p></section>`}</section>`;
  if(!choosing)renderAuthForm(mode,role);
}const PH_REGION_OPTIONS=['National Capital Region (NCR)','Cordillera Administrative Region (CAR)','Region I (Ilocos Region)','Region II (Cagayan Valley)','Region III (Central Luzon)','Region IV-A (CALABARZON)','MIMAROPA Region','Region V (Bicol Region)','Region VI (Western Visayas)','Negros Island Region (NIR)','Region VII (Central Visayas)','Region VIII (Eastern Visayas)','Region IX (Zamboanga Peninsula)','Region X (Northern Mindanao)','Region XI (Davao Region)','Region XII (SOCCSKSARGEN)','Region XIII (Caraga)','Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)'];
function renderAuthForm(mode,role=state.authRole){
  const slot=$('#auth-form-slot');if(!slot)return;
  const roleName=role==='owner'?'stall owner':role==='runner'?'school runner':role==='admin'?'administrator':'school customer';
  const roleCopy=role==='owner'?'Set up your stall and start publishing menu items.':role==='runner'?'Create your account to receive assigned school deliveries.':role==='admin'?'Manage school stalls and keep ordering on track.':'Browse school menus and follow your orders.';
  const loginCopy=role==='owner'?'Manage your stall, menu, and incoming orders.':role==='runner'?'See assigned runs and delivery details.':role==='admin'?'Manage school stalls and ordering.':'Browse school menus and follow your orders.';
  slot.innerHTML=mode==='login'?`<span class="eyebrow">${esc(roleName)} workspace</span><h2>Welcome back.</h2><p class="form-intro">${esc(loginCopy)}</p><form class="stack-form" data-form="login"><label>Email address<input name="email" type="email" autocomplete="username" maxlength="254" required placeholder="you@school.edu"></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="button button-primary button-wide">Sign in <span>→</span></button></form><p class="auth-switch">New to BiteHub? <button class="text-button" data-auth-mode="choose">Choose your role</button></p>`:`<span class="eyebrow">${esc(roleName)}</span><h2>Create your ${esc(roleName)} account</h2><p class="form-intro">${esc(roleCopy)}</p><form class="stack-form signup-form" data-form="signup"><input type="hidden" name="role" value="${esc(role)}"><section class="signup-school-section"><div class="signup-step-heading"><span>01</span><div><h3>Your school community</h3><p>Choose any secondary school or university in the Philippines.</p></div></div><label>Institution type<select name="school_type" required><option value="">Choose type</option><option>Secondary school</option><option>University</option><option>Other school</option></select></label><label>School or university name<input name="school_name" maxlength="120" required placeholder="Search the official school name"></label><div class="school-search-row"><button class="button button-outline" type="button" data-school-find>Find on Google Maps</button><span>Palawan National School and Palawan State University are the first pilot examples. Other Philippine schools can join too.</span></div><div class="school-place-results" aria-live="polite" hidden></div><div class="school-map-panel"><div class="school-map-heading"><strong>Set your school location</strong><small>Search for the school, then click the map to adjust its pin.</small></div><div class="school-signup-map" data-school-map aria-label="Google Map to choose your school location"></div><p class="school-map-status" data-school-map-status>Search by school name and location to find it on the map.</p><div class="school-coordinate-fallback" data-school-coordinate-fallback hidden><p>Map search is unavailable. You can still enter the coordinates shown in Google Maps.</p><div><label>Latitude<input name="school_latitude_manual" type="number" step="any" min="4" max="22.5" placeholder="e.g. 9.7386"></label><label>Longitude<input name="school_longitude_manual" type="number" step="any" min="115" max="128" placeholder="e.g. 118.7390"></label></div></div><input type="hidden" name="school_latitude"><input type="hidden" name="school_longitude"><small class="school-map-radius">The delivery map will open around this pin, with a 1.5 km delivery area.</small></div><label>Region<select name="school_region" required><option value="">Choose region</option>${PH_REGION_OPTIONS.map(region=>`<option>${esc(region)}</option>`).join('')}</select></label><label>Province<input name="school_province" maxlength="80" required placeholder="Province"></label><label>City or municipality<input name="school_city" maxlength="80" required placeholder="City or municipality"></label><p class="school-country-lock"><span aria-hidden="true">🇵🇭</span> Country is set to Philippines</p><label class="confirm-school"><input type="checkbox" name="confirm_school" value="yes" required><span>I confirm this is the correct school and location.</span></label></section><section class="signup-person-section"><div class="signup-step-heading"><span>02</span><div><h3>Your account</h3><p>Your account will belong to the school you selected.</p></div></div><label>Your name<input name="name" autocomplete="name" maxlength="80" required placeholder="Full name"></label><label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></label>${role==='owner'?'<label>Stall name<input name="stall_name" maxlength="80" required placeholder="Your stall name"></label>':''}<label>Password <span class="field-hint">At least 10 characters</span><input name="password" type="password" autocomplete="new-password" minlength="10" required></label><button class="button button-primary button-wide">Create account <span>→</span></button></section></form><p class="auth-switch">Already have an account? <button class="text-button" data-auth-mode="login">Sign in</button></p>`;
  if(mode==='signup')initializeSignupSchoolMap(slot.querySelector('[data-form="signup"]'));
}
async function initializeSignupSchoolMap(form){
  if(!form)return;
  const schoolNameLabel=form.elements.namedItem('school_name').closest('label');
  schoolNameLabel.after(form.elements.namedItem('school_region').closest('label'),form.elements.namedItem('school_province').closest('label'),form.elements.namedItem('school_city').closest('label'));
  const regionField=form.elements.namedItem('school_region'),provinceField=form.elements.namedItem('school_province');
  const syncProvinceRequirement=()=>{const isNcr=regionField.value==='National Capital Region (NCR)';provinceField.required=!isNcr;provinceField.closest('label').firstChild.textContent=isNcr?'Province (if applicable)':'Province'};
  regionField.addEventListener('change',syncProvinceRequirement);syncProvinceRequirement();
  const host=form.querySelector('[data-school-map]'),status=form.querySelector('[data-school-map-status]'),find=form.querySelector('[data-school-find]'),results=form.querySelector('.school-place-results'),fallback=form.querySelector('[data-school-coordinate-fallback]');
  const latitudeField=form.elements.namedItem('school_latitude'),longitudeField=form.elements.namedItem('school_longitude');
  find.disabled=true;find.textContent='Loading map…';
  let maps=null,map=null,marker=null,deliveryCircle=null,places=[];
  const savePoint=(latitude,longitude,message='School pin saved. Click the map to fine-tune it.')=>{
    latitudeField.value=Number(latitude).toFixed(7);longitudeField.value=Number(longitude).toFixed(7);status.textContent=message;
    if(map){const point={lat:Number(latitude),lng:Number(longitude)};if(marker)marker.setPosition(point);else marker=new maps.Marker({map,position:point,title:'School location'});if(deliveryCircle)deliveryCircle.setCenter(point);else deliveryCircle=new maps.Circle({map,center:point,radius:1500,fillColor:'#7650c9',fillOpacity:.055,strokeColor:'#7650c9',strokeOpacity:.65,strokeWeight:2,clickable:false});}
  };
  try{
    maps=await loadGoogleMapsApi();
    if(maps){
      map=new maps.Map(host,{center:{lat:12.8797,lng:121.774},zoom:6,minZoom:5,maxZoom:21,mapTypeId:'roadmap',mapTypeControl:false,streetViewControl:false,fullscreenControl:false,gestureHandling:'cooperative',restriction:{latLngBounds:{south:4,north:22.5,west:115,east:128},strictBounds:true}});
      map.addListener('click',event=>{if(event.latLng)savePoint(event.latLng.lat(),event.latLng.lng())});
    }else{status.textContent='Google Maps could not load. Use the coordinate fields below to pin the school.';fallback.hidden=false;}
  }catch{status.textContent='Google Maps could not load. Use the coordinate fields below to pin the school.';fallback.hidden=false;}
  for(const input of form.querySelectorAll('[name="school_latitude_manual"],[name="school_longitude_manual"]'))input.addEventListener('input',()=>{const lat=Number(form.elements.namedItem('school_latitude_manual').value),lng=Number(form.elements.namedItem('school_longitude_manual').value);if(Number.isFinite(lat)&&Number.isFinite(lng)&&lat&&lng)savePoint(lat,lng,'School coordinates saved.')});
  find.addEventListener('click',async()=>{
    const name=form.elements.namedItem('school_name').value.trim(),region=form.elements.namedItem('school_region').value,province=form.elements.namedItem('school_province').value.trim(),city=form.elements.namedItem('school_city').value.trim();
    if(!name){form.elements.namedItem('school_name').focus();status.textContent='Enter the school or university name first.';return}
    if(!maps||!map){status.textContent='Google Maps is unavailable. Use the coordinate fields below, or try again when the map loads.';fallback.hidden=false;return}
    find.disabled=true;find.textContent='Searching…';results.hidden=false;results.innerHTML='<p>Looking for your school…</p>';
    try{
      const {Place}=await maps.importLibrary('places');
      const query=[name,city,province,region,'Philippines'].filter(Boolean).join(', ');
      const response=await Place.searchByText({textQuery:query,fields:['displayName','formattedAddress','location','addressComponents'],maxResultCount:5});
      places=response.places||[];
      results.innerHTML=places.length?`${places.map((place,index)=>`<button type="button" class="school-place-option" data-school-place="${index}"><strong>${esc(place.displayName||name)}</strong><small>${esc(place.formattedAddress||'Philippines')}</small></button>`).join('')}<small class="school-google-attribution">Google Maps results</small>`:'<p>No matching place was found. Try the school’s full name and city, or click its location on the map.</p>';
    }catch{results.innerHTML='<p>Could not search right now. Try the full official school name with its city, or click the school location on the map.</p>';}
    finally{find.disabled=false;find.textContent='Find on Google Maps'}
  });
  results.addEventListener('click',event=>{
    const button=event.target.closest('[data-school-place]');if(!button)return;const place=places[Number(button.dataset.schoolPlace)],location=place?.location;if(!location)return;
    const latitude=typeof location.lat==='function'?location.lat():Number(location.lat),longitude=typeof location.lng==='function'?location.lng():Number(location.lng),components=place.addressComponents||[];
    form.elements.namedItem('school_name').value=place.displayName||form.elements.namedItem('school_name').value;
    const component=type=>components.find(part=>part.types?.includes(type))?.longText||'';
    const addressRegion=component('administrative_area_level_1'),regionMatch=addressRegion?(PH_REGION_OPTIONS.find(region=>region.toLowerCase().includes(addressRegion.toLowerCase())||addressRegion.toLowerCase().includes(region.split(' (')[0].toLowerCase()))||(/metro manila/i.test(addressRegion)?PH_REGION_OPTIONS[0]:null)):null;
    if(regionMatch)regionField.value=regionMatch;
    if(regionField.value==='National Capital Region (NCR)')provinceField.value='Metro Manila';
    else if(component('administrative_area_level_2'))provinceField.value=component('administrative_area_level_2');
    const cityField=form.elements.namedItem('school_city'),addressCity=component('locality')||component('administrative_area_level_3')||component('sublocality_level_1')||(regionField.value==='National Capital Region (NCR)'?component('administrative_area_level_2'):'');
    if(addressCity)cityField.value=addressCity;
    syncProvinceRequirement();
    map.panTo({lat:latitude,lng:longitude});map.setZoom(18);savePoint(latitude,longitude,`${place.displayName||'School'} selected. Check the location details and click the map to move the pin if needed.`);
    results.hidden=true;
  });
  find.disabled=false;find.textContent='Find on Google Maps';
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
  const itemText=order.items.map(i=>`${i.quantity} × ${esc(i.name)}`).join(' · ');
  const progressSteps=order.fulfillment==='delivery'?['placed','confirmed','preparing','ready','out','completed']:['placed','confirmed','preparing','ready','completed'];
  const progressNames=order.fulfillment==='delivery'?['Received','Accepted','Preparing','Ready','On the way','Delivered']:['Received','Accepted','Preparing','Ready','Picked up'];
  const progressIndex=progressSteps.indexOf(order.status);
  const progress=state.user.role==='buyer'&&order.status!=='declined'?`<ol class="order-progress" aria-label="Order progress: ${esc(statusLabel[order.status]||order.status)}">${progressSteps.map((step,index)=>`<li class="${index<progressIndex?'is-done':index===progressIndex?'is-current':''}" ${index===progressIndex?'aria-current="step"':''}><span>${index<progressIndex?'✓':index+1}</span><small>${progressNames[index]}</small></li>`).join('')}</ol>`:order.status==='declined'&&state.user.role==='buyer'?'<p class="order-declined" role="status">This order was declined. Contact the stall if you need help.</p>':'';
  const feedback=order.feedback?`<p class="order-feedback"><strong>Buyer feedback · ${'★'.repeat(order.feedback.rating)}${'☆'.repeat(5-order.feedback.rating)}</strong>${order.feedback.comment?`<span>${esc(order.feedback.comment)}</span>`:''}</p>`:'';
  const feedbackForm=state.user.role==='buyer'&&order.status==='completed'&&!order.feedback?`<form class="feedback-form" data-form="feedback" data-order-id="${order.id}"><label>Rate this order<select name="rating" required><option value="">Choose 1-5</option><option value="5">5 · Great</option><option value="4">4 · Good</option><option value="3">3 · Okay</option><option value="2">2 · Poor</option><option value="1">1 · Bad</option></select></label><label>Comment <span class="field-hint">Optional</span><input name="comment" maxlength="500" placeholder="Tell the stall what went well"></label><button class="button button-outline button-small">Send feedback</button></form>`:'';
  let actions='';
  if(state.user.role==='owner'){
    if(order.status==='placed')actions=`<button class="button button-primary button-small" data-order-action="confirm" data-id="${order.id}">Accept order</button><button class="button button-quiet button-small" data-order-action="decline" data-id="${order.id}">Decline</button>`;
    if(order.status==='confirmed')actions=`<button class="button button-primary button-small" data-order-action="prepare" data-id="${order.id}">Start preparing</button>`;
    if(order.status==='preparing')actions=`<button class="button button-primary button-small" data-order-action="ready" data-id="${order.id}">Mark ready</button>`;
    if(order.status==='ready'&&order.fulfillment==='delivery')actions=`<label class="assign-runner">Runner name<input type="text" list="runner-options-${order.id}" data-assign-runner="${order.id}" value="${esc(order.runner||'')}" placeholder="Type or pick a runner" autocomplete="off"><datalist id="runner-options-${order.id}">${state.runners.map(r=>`<option value="${esc(r.name)}"></option>`).join('')}</datalist></label><button class="button button-primary button-small" data-order-action="assign" data-id="${order.id}">Assign</button>`;
  }
  if(state.user.role==='runner'){
    if(order.status==='ready')actions=`<button class="button button-primary button-small" data-order-action="out" data-id="${order.id}">Picked up</button>`;
    if(order.status==='out')actions=`<button class="button button-primary button-small" data-order-action="delivered" data-id="${order.id}">Mark delivered</button>`;
  }
  if(state.user.role==='buyer'&&order.status==='ready'&&order.fulfillment==='pickup')actions=`<button class="button button-primary button-small" data-order-action="collect" data-id="${order.id}">Confirm pickup</button>`;
  const estimate=order.estimated_ready_at&&['buyer','owner'].includes(state.user.role)&&['confirmed','preparing'].includes(order.status)?`<p class="order-estimate">${Date.parse(order.estimated_ready_at)<Date.now()?'Estimated time passed · check with stall':`Estimated ready ${new Date(order.estimated_ready_at).toLocaleTimeString('en-PH',{timeZone:'Asia/Manila',hour:'numeric',minute:'2-digit'})}`}</p>`:'';
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
  const tracking=order.fulfillment==='delivery'&&order.status==='out'&&['buyer','runner','owner'].includes(state.user.role)?`<section class="tracking-panel"><div><strong>${state.user.role==='runner'?(gpsAge<45000?'Sharing your live location':gpsAge===Infinity?'Waiting for GPS fix':gpsText):gpsAge===Infinity?'Waiting for runner location':gpsText}</strong><small>School delivery · GPS can pause indoors or when signal is weak.</small>${eta?`<p class="tracking-eta">${eta}</p>`:''}${locationAccuracy||gpsUpdated?`<small class="tracking-meta">${[locationAccuracy,gpsUpdated].filter(Boolean).join(' · ')}</small>`:''}</div>${campusMap(order)}<small class="map-key"><i class="map-key-runner"></i>Runner <i class="map-key-destination"></i>Handoff <i class="map-key-stall"></i>Stall</small>${trackingGoogleLink}<small class="tracking-note">Google Maps opens the location or walking route. Follow school walkways around buildings and obstacles.</small></section>`:'';
  return `<article class="order-card"><div class="order-card-top"><div><span class="order-number">ORDER #${order.id} · ${new Date(order.created_at).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}</span><h3>${esc(order.stall)}</h3></div><span class="status-badge status-${esc(order.status)}">${esc(statusLabel[order.status]||order.status)}</span></div>${progress}<div class="order-card-body"><div><p class="order-items-summary">${itemText}</p><p class="order-subline">${order.fulfillment==='delivery'?'School delivery only':pickupTime?`Pickup · ${pickupTime}`:'Pickup'}${order.runner?` · Runner: ${esc(order.runner)}`:''}${order.buyer_note?` · “${esc(order.buyer_note)}”`:''}</p>${state.user.role!=='buyer'?`<p class="order-subline">Placed by ${esc(order.buyer)}${order.buyer_email?` · ${esc(order.buyer_email)}`:''}</p>`:''}</div><strong class="order-total">${money(order.total)}</strong></div>${tracking}${estimate}${actions?`<div class="order-actions">${actions}</div>`:''}${feedback}${feedbackForm}</article>`;
}
function emptyState(icon,title,copy){return `<div class="empty-state"><span>${icon}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>`}
function buyerHeroArt(item){
  const items=buyerHeroItems();
  if(items.length){state.heroFeaturedIndex=((state.heroFeaturedIndex%items.length)+items.length)%items.length;if(item===undefined)item=items[state.heroFeaturedIndex]}
  else item=null;
  if(!item)return `<span class="banner-art-stamp">FRESH · LOCAL · YOURS</span>${buyerHeroFallbackArt()}<i class="banner-art-sparkle">✦</i><b>MADE FOR<br>YOUR BREAK</b>`;
  const total=items.length,index=state.heroFeaturedIndex+1;
  const food=item.photo_url?`<img src="${esc(item.photo_url)}" alt="" loading="eager" decoding="async">`:`<span aria-hidden="true">${esc(item.emoji||'🍽️')}</span>`;
  const badge=state.featuredProducts.length?'TODAY’S STALL PICK':'SCHOOL MENU FAVORITE';
  return `<span class="banner-art-stamp">${total>1?`PICK ${index} OF ${total}`:badge}</span><button class="banner-featured-food" type="button" data-product-details="${item.id}" aria-label="View ${esc(item.name)} from ${esc(item.stall_name)}">${food}</button>${total>1?`<button class="banner-feature-arrow is-previous" type="button" data-hero-feature="-1" aria-label="Previous featured dish">‹</button><button class="banner-feature-arrow is-next" type="button" data-hero-feature="1" aria-label="Next featured dish">›</button>`:''}<span class="banner-featured-note"><small>${esc(item.stall_name)}</small><strong>${esc(item.name)}</strong><span class="banner-featured-price">${money(item.price)}</span></span>`;
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
  const ordersView=state.user?.role==='buyer'&&state.buyerView==='orders';
  const orderCount=state.orders.filter(order=>!['completed','declined'].includes(order.status)).length;
  root.innerHTML=`${heading('BITEHUB · YOUR SCHOOL','A good break starts here.','Campus favorites, made fresh by the stalls you love.',`<span class="live-pill ${state.paused?'is-paused':''}"><i></i>${state.paused?'Ordering paused':'Open for orders'}</span>`)}${workspaceNav('buyer',state.user?.role==='buyer'?[['menu','Browse food','⌕'],['orders','My orders','↗',orderCount]]:[['menu','Browse food','⌕']],ordersView?'orders':'menu')}
  ${ordersView?`<section class="workspace-page customer-orders-page" id="buyer-orders"><div class="section-title"><div><span class="eyebrow">YOUR RECENT ACTIVITY</span><h2>Order updates</h2><p class="helper-text">Check progress, pickup details, and feedback for your school orders.</p></div><span class="result-count">${state.orders.length} ${state.orders.length===1?'order':'orders'}</span></div>${state.orders.length?`<div class="order-list">${state.orders.slice(0,12).map(orderCard).join('')}</div>`:emptyState('↗','Your first order starts here','Browse the menu and place an order. Its progress will appear here.')}</section>`:`<section class="buyer-banner" aria-labelledby="buyer-banner-title"><div class="buyer-banner-copy"><span class="eyebrow">BITEHUB · YOUR SCHOOL</span><h2 id="buyer-banner-title">Good food,<br><span>better breaks.</span></h2><p>Explore the stalls in your school community and find a favorite for your next break.</p><a class="button button-light" href="#menu">Explore the menu <span aria-hidden="true">↗</span></a></div><div class="banner-art" aria-live="polite" aria-label="Featured food from school stalls">${buyerHeroArt()}</div></section>${renderFeaturedPicks()}
  <section class="section-block customer-menu-page" id="menu"><div class="section-title"><div><span class="eyebrow">THE CAMPUS MENU</span><h2>Find your next favorite</h2></div><label class="search-field"><span aria-hidden="true">⌕</span><input type="search" id="menu-search" value="${esc(state.query)}" placeholder="Dish, stall, or craving" aria-label="Search menu"></label></div><div class="menu-controls"><div class="filter-row" role="group" aria-label="Filter menu by category">${categories.map(c=>`<button class="filter-chip ${state.filter===c?'is-active':''}" data-filter="${esc(c)}" aria-pressed="${state.filter===c}">${esc(c)}</button>`).join('')}</div><label class="sort-field">Sort<select id="menu-sort"><option value="featured" ${state.sort==='featured'?'selected':''}>Featured</option><option value="price-low" ${state.sort==='price-low'?'selected':''}>Price: low to high</option><option value="price-high" ${state.sort==='price-high'?'selected':''}>Price: high to low</option><option value="name" ${state.sort==='name'?'selected':''}>Name</option></select></label><span class="result-count" role="status" aria-live="polite">${products.length} ${products.length===1?'item':'items'}</span></div><div class="product-grid">${products.length?products.map(p=>`<article class="product-card"><button class="product-art product-art-trigger" data-product-details="${p.id}" aria-label="View details for ${esc(p.name)}"><span>${esc(p.emoji)}</span><small>${esc(p.category)}</small></button><div class="product-details"><div class="product-stall">${esc(p.stall_name)}</div><button class="product-name-trigger" data-product-details="${p.id}"><h3>${esc(p.name)}</h3></button><p>${esc(p.description||'Fresh from the stall, ready for your break.')}</p><div class="product-bottom"><strong>${money(p.price)}</strong><button class="button button-primary button-small" data-add="${p.id}" ${state.paused?'disabled':''}>${state.paused?'Paused':'Add +'}</button></div></div></article>`).join(''):state.products.length===0?emptyState('⌂','No school menus yet','Stall owners can create an account and publish a menu. New items will appear here automatically.'):emptyState('⌕','No menu items found','Try another search or category.')}</div></section>`}`;
}
function renderBuyerView(){renderBuyer();addCatalogControls();decorateProductCards();const rail=$('.featured-rail');if(rail)rail.scrollLeft=state.featuredScroll;startFeaturedMotion()}
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
  $('#stall-content').innerHTML=`<form method="dialog" class="modal-dismiss"><button class="icon-button" aria-label="Close stall profile">×</button></form><header class="stall-social-header"><div class="stall-cover-art"><span>SCHOOL COMMUNITY · CAMPUS STALL</span></div><div class="stall-social-identity"><div class="stall-profile-avatar">${logo}</div><div class="stall-social-title"><h2>${esc(stall.name)}</h2><p>${esc(stall.owner_name||'Campus stall owner')} · ${stall.menu_count} menu ${stall.menu_count===1?'item':'items'}</p>${stall.rating?`<span class="stall-rating">★ ${Number(stall.rating).toFixed(1)} <small>from ${stall.review_count} verified order ${stall.review_count===1?'review':'reviews'}</small></span>`:'<small class="stall-rating-new">New campus stall</small>'}</div><span class="stall-open-badge ${stall.is_open?'is-open':''}"><i></i>${stall.is_open?'Open now':'Closed'}</span></div></header><section class="stall-about-card"><span class="eyebrow">ABOUT THIS STALL</span><p class="stall-profile-description">${esc(stall.description||'Welcome! We are serving fresh breaks at your school.')}</p><div class="stall-profile-facts"><span><small>HOURS</small><strong>${esc(stall.opens_at)}–${esc(stall.closes_at)}</strong></span><span><small>MENU</small><strong>${stall.menu_count} ${stall.menu_count===1?'item':'items'}</strong></span><span><small>LOCATION</small><strong>Your school</strong></span></div></section><section class="stall-profile-menu"><div class="stall-menu-heading"><div><span class="eyebrow">FROM THE KITCHEN</span><h3>Explore the menu</h3></div><span class="stall-menu-count">${stall.menu_count} ${stall.menu_count===1?'choice':'choices'}</span></div>${stall.products.length?`<div class="stall-menu-grid">${stall.products.map((item,index)=>`<article class="stall-menu-item" style="--menu-index:${index}"><button class="stall-menu-photo" data-product-details="${item.id}" aria-label="View details for ${esc(item.name)}">${item.photo_url?`<img src="${esc(item.photo_url)}" alt="Photo of ${esc(item.name)}" loading="lazy">`:`<span aria-hidden="true">${esc(item.emoji)}</span>`}<small>${esc(item.category)}</small></button><div class="stall-menu-copy"><button class="stall-product-title" data-product-details="${item.id}">${esc(item.name)}</button><small>${esc(item.description||'Freshly made for your break.')}</small><div><b>${money(item.price)}</b><button class="button button-primary button-small" data-add="${item.id}" ${state.paused||!stall.is_open||item.stock_count===0?'disabled':''}>${item.stock_count===0?'Sold out':'Add +'}</button></div></div></article>`).join('')}</div>`:emptyState('⌂','No menu items available','This stall has not published any available items.')}</section>`;
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
  root.innerHTML=`${heading('STALL WORKSPACE',`Welcome, ${esc(state.user.name.split(' ')[0])}.`,'Manage your menu, orders, and stall details in one place.',`<span class="live-pill"><i></i>Owner account</span>`)}${workspaceNav('owner',tabs,view)}<main class="workspace-content owner-workspace-content" id="owner-workspace">${page}</main>`;
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
    const now=Date.now();if(now-state.lastLocationSent<8000)return;state.lastLocationSent=now;
    const orders=state.orders.filter(item=>item.status==='out'&&item.fulfillment==='delivery');if(!orders.length)return;
    const body=json({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:Math.min(position.coords.accuracy||0,1000),heading:Number.isFinite(position.coords.heading)?position.coords.heading:null});
    try{await Promise.all(orders.map(order=>api(`/api/orders/${order.id}/location`,{method:'POST',body})))}
    catch(error){toast(`Location update failed: ${error.message}`)}
  },error=>{toast(error.code===1?'Allow location access to share your delivery progress.':'Could not read your location. Check GPS and try again.');navigator.geolocation.clearWatch(state.trackingWatch);state.trackingWatch=null},{enableHighAccuracy:true,maximumAge:5000,timeout:15000});
}
function renderAdmin(){
  const totals=state.overview||{users:{},stalls:0,products:0,orders:[],ordering_paused:state.paused};
  const amount=totals.orders.filter(order=>order.status==='completed').reduce((sum,order)=>sum+order.sales,0)/100;
  const view=state.adminView||'overview',tabs=[['overview','Overview','◷'],['stalls','Stalls','⌂',totals.stalls],['orders','Orders','▣',state.orders.length],['reports','Reports','▤'],['accounts','Accounts','◎']];
  const overview=`<section class="stats-grid admin-stats" id="admin-overview">${stat('Campus accounts',Object.values(totals.users).reduce((a,b)=>a+b,0),'Across all account types','◎')}${stat('Campus stalls',totals.stalls,'Registered stall owners','⌂')}${stat('Menu items',totals.products,'Listed on the hub','▦')}${stat('Completed order value',money(amount),'Value of completed orders','₱')}</section><div class="admin-overview-grid"><section class="panel admin-recent-orders"><div class="section-title"><div><span class="eyebrow">CAMPUS ACTIVITY</span><h2>Recent orders</h2></div><button type="button" class="text-button" data-workspace-role="admin" data-workspace-view="orders">View all →</button></div>${state.orders.length?`<div class="order-list">${state.orders.slice(0,4).map(orderCard).join('')}</div>`:emptyState('▤','No orders yet','New orders across campus will appear here.')}</section><section class="panel admin-quick-actions"><div class="section-title"><div><span class="eyebrow">QUICK ACCESS</span><h2>Campus controls</h2></div></div><button type="button" class="admin-shortcut" data-workspace-role="admin" data-workspace-view="stalls"><span>⌂</span><span><strong>Manage stalls</strong><small>Check availability and stall status</small></span><b>${totals.stalls} →</b></button><button type="button" class="admin-shortcut" data-workspace-role="admin" data-workspace-view="reports"><span>▤</span><span><strong>Study reports</strong><small>Review aggregated reach and orders</small></span><b>Open →</b></button><button type="button" class="admin-shortcut" data-workspace-role="admin" data-workspace-view="accounts"><span>◎</span><span><strong>Account overview</strong><small>See users by campus role</small></span><b>Open →</b></button></section></div>`;
  const accounts=`<section class="panel admin-accounts workspace-page" id="admin-accounts"><div class="section-title"><div><span class="eyebrow">ACCOUNT DIRECTORY</span><h2>Campus roles</h2><p class="helper-text">A quick count of accounts using the campus hub.</p></div><span class="result-count">${Object.values(totals.users).reduce((a,b)=>a+b,0)} accounts</span></div><div class="role-directory">${[['buyer','Campus customers','🥡'],['owner','Stall owners','⌂'],['runner','Campus runners','↗'],['admin','Administrators','⚙']].map(([key,label,icon])=>`<article><span>${icon}</span><div><strong>${esc(label)}</strong><small>${totals.users[key]||0} accounts</small></div></article>`).join('')}</div></section>`;
  let page=view==='overview'?overview:view==='stalls'?renderStallApprovals():view==='orders'?renderAdminOrders():view==='reports'?renderAdminReports():accounts;
  root.innerHTML=`${heading('CAMPUS ADMINISTRATION','The hub, at a glance.','Keep campus ordering, stalls, and study activity organized.',`<button class="button ${state.paused?'button-primary':'button-dark'}" data-action="toggle-pause">${state.paused?'Resume ordering':'Pause ordering'}</button>`)}${workspaceNav('admin',tabs,view)}<main class="workspace-content admin-workspace-content">${page}</main>`;
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
  const items=cartEntries();
  const dialog=$('#cart-dialog'),content=$('#cart-content'),wasOpen=dialog.open,body=$('#bag-scroll'),previousScroll=body?.scrollTop||0;
  const focused=document.activeElement,quantity=focused?.closest('[data-quantity]'),remove=focused?.closest('[data-remove-cart]');
  const focusState=quantity?{kind:'quantity',id:quantity.dataset.id,delta:quantity.dataset.quantity}:remove?{kind:'remove',id:remove.dataset.removeCart}:focused?.closest('[data-action="clear-cart"]')?{kind:'clear'}:null;
  const guest=!state.user,first=items[0];
  const controls=items.length&&!guest?`<section class="bag-section" aria-labelledby="bag-fulfillment-title"><h3 id="bag-fulfillment-title">How do you want to get it?</h3><div class="fulfillment-options" role="radiogroup" aria-label="Choose pickup or school delivery"><label class="fulfillment-choice ${state.fulfillment==='pickup'?'is-selected':''}"><input type="radio" id="fulfillment" name="fulfillment" value="pickup" ${state.fulfillment==='pickup'?'checked':''}><span><strong>Pick up</strong><small>Collect from the stall</small></span></label><label class="fulfillment-choice ${state.fulfillment==='delivery'?'is-selected':''}"><input type="radio" id="fulfillment-delivery" name="fulfillment" value="delivery" ${state.fulfillment==='delivery'?'checked':''}><span><strong>School delivery</strong><small>Meet your runner at school</small></span></label></div><div class="delivery-map-wrap" id="delivery-map-wrap" ${state.fulfillment!=='delivery'?'hidden':''}><strong>Choose a handoff point within your school area</strong><small>Choose any point within 1.5 km of your school to meet the runner.</small>${campusMap(null,true)}<span class="map-key"><i class="map-key-destination"></i>Handoff point</span><span id="delivery-map-status" role="status">${state.deliveryLocation?'Delivery point selected':'No delivery point selected'}</span><a class="button button-outline button-small map-google-link" id="delivery-google-link" href="${googleMapsPointUrl(state.deliveryLocation)}" target="_blank" rel="noopener noreferrer">${state.deliveryLocation?'Check handoff point':'View school map'} in Google Maps <span aria-hidden="true">↗</span></a></div><label class="bag-note">Note for the stall <small>Optional · allergies or pickup details</small><textarea id="order-note" maxlength="240" rows="2" placeholder="Add a note for the stall">${esc(state.cartNote)}</textarea></label></section>`:'';
  content.innerHTML=`<div class="bag-layout"><header class="bag-header"><div><span class="eyebrow">YOUR CAMPUS ORDER</span><h2 id="cart-title">${items.length?'Review your bag':'Your bag'}</h2><p>${items.length?`${cartCount()} ${cartCount()===1?'item':'items'} · ${esc(first.stall_name)}`:'Pick something good for your break.'}</p></div>${items.length?`<button type="button" class="bag-clear" data-action="clear-cart">Clear bag</button>`:''}</header><div class="bag-scroll" id="bag-scroll">${items.length?`<div class="bag-stall-note"><span aria-hidden="true">⌂</span><span><strong>${esc(first.stall_name)}</strong><small>One stall per order · review your items below</small></span></div><div class="bag-lines">${items.map(renderBagLine).join('')}</div>${controls}`:`<div class="bag-empty"><span aria-hidden="true">🥡</span><h3>Your bag is empty</h3><p>Browse the campus menu and add something for your break.</p><button type="button" class="button button-primary" data-action="continue-shopping">Browse food <span>→</span></button></div>`}</div>${items.length?`<footer class="bag-footer"><div class="bag-total"><span>${cartCount()} ${cartCount()===1?'item':'items'} · total</span><strong>${money(cartTotal())}</strong></div>${guest?`<small class="bag-payment-note">Sign in to choose pickup or delivery and place your order.</small><button type="button" class="button button-primary button-wide" data-action="guest-checkout">Sign in to order <span>→</span></button>`:`<small class="bag-payment-note">Pay the stall directly at pickup or handoff.</small><button type="button" class="button button-primary button-wide" data-action="place-order" ${state.paused||(state.fulfillment==='delivery'&&!state.deliveryLocation)?'disabled':''}>${state.paused?'Ordering paused':`Place order · ${money(cartTotal())}`} <span>→</span></button>`}</footer>`:''}</div>`;
  accountTools();
  if(!dialog.open)dialog.showModal();
  if(wasOpen){const nextBody=$('#bag-scroll');if(nextBody)nextBody.scrollTop=previousScroll;let target=null;if(focusState?.kind==='quantity')target=content.querySelector(`[data-quantity="${focusState.delta}"][data-id="${focusState.id}"]`);if(focusState?.kind==='remove')target=content.querySelector(`[data-quantity="-1"]`)||content.querySelector('[data-action="continue-shopping"]');if(focusState?.kind==='clear')target=content.querySelector('[data-action="continue-shopping"]');(target||content.querySelector('[data-action="continue-shopping"]')||$('#cart-close'))?.focus({preventScroll:true});if(nextBody)nextBody.scrollTop=previousScroll}
  enhanceGoogleCampusMaps();
}
function updateCartCheckoutButton(){
  const place=$('#cart-content [data-action="place-order"]');
  if(place)place.disabled=state.paused||(state.fulfillment==='delivery'&&!state.deliveryLocation);
}
function cartCount(){return cartEntries().reduce((count,item)=>count+item.quantity,0)}
function addToCart(product){
  if(state.paused){toast('Ordering is paused right now.');return}
  if(!product.stall_open){toast(`This stall is closed. It opens at ${product.opens_at}.`);return}
  if(!product.available){toast('This menu item is currently unavailable.');return}
  if([...state.cart.values()].some(item=>item.stall_id!==product.stall_id)){toast('Place a separate order for each stall.');return}
  const item=state.cart.get(product.id)||{...product,quantity:0};
  const limit=item.stock_count===null?50:Math.min(50,item.stock_count);
  if(item.quantity>=limit){toast(item.stock_count===null?'You can order up to 50 of each item.':`Only ${item.stock_count} available.`);return}
  item.quantity++;state.cart.set(product.id,item);accountTools();
  if($('#cart-dialog').open)renderCart();
  toast(`${product.name} added to your bag.`);
}
function resetEmptyBag(){if(state.cart.size)return;state.cartNote='';state.fulfillment='pickup';state.deliveryLocation=null}
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
  if(action==='assign'){const runnerName=$(`[data-assign-runner="${id}"]`)?.value.trim();const runner=state.runners.find(item=>item.name.toLocaleLowerCase()===runnerName?.toLocaleLowerCase());if(!runner)throw new Error(runnerName?'Choose a runner name from the suggestions.':'Enter or choose a runner name.');payload.runner_id=runner.id}
  await api(`/api/orders/${id}`,{method:'PATCH',body:json(payload)});toast('Order updated.');await refresh();
}
root.addEventListener('input',e=>{
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
  const feature=e.target.closest('[data-feature-product]');if(feature){feature.disabled=true;const active=feature.dataset.featureActive==='true';try{await api('/api/stall/feature',{method:'PATCH',body:json({product_id:Number(feature.dataset.featureProduct),featured:!active})});toast(active?'Campus pick removed.':'Featured on Today’s Campus Picks for 24 hours!');await refresh()}catch(error){toast(error.message);feature.disabled=false}return}
  const moveHeroFeature=e.target.closest('[data-hero-feature]');if(moveHeroFeature){setBuyerHeroFeature(state.heroFeaturedIndex+Number(moveHeroFeature.dataset.heroFeature));return}
  const moveFeatured=e.target.closest('[data-feature-move]');if(moveFeatured){const rail=$('.featured-rail'),card=rail?.querySelector('.featured-card');if(rail&&card)rail.scrollBy({left:(card.getBoundingClientRect().width+12)*Number(moveFeatured.dataset.featureMove),behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});return}
  const pauseFeatured=e.target.closest('[data-feature-pause]');if(pauseFeatured){state.featuredPaused=!state.featuredPaused;pauseFeatured.setAttribute('aria-pressed',String(state.featuredPaused));pauseFeatured.textContent=state.featuredPaused?'Play rotation':'Pause rotation';return}
  const enableAlerts=e.target.closest('[data-action="enable-notifications"]');if(enableAlerts){enableAlerts.disabled=true;try{await enablePushNotifications()}catch(error){toast(error.message);enableAlerts.disabled=false}return}
  const disableAlerts=e.target.closest('[data-action="disable-notifications"]');if(disableAlerts){disableAlerts.disabled=true;try{await disablePushNotifications()}catch(error){toast(error.message);disableAlerts.disabled=false}return}
  const zoom=e.target.closest('[data-map-zoom]');if(zoom){setMapZoom(zoom.dataset.mapZoom);return}
  const mapPicker=e.target.closest('[data-map-picker]');if(mapPicker){const rect=mapPicker.getBoundingClientRect(),x=e.detail===0?0.5:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y=e.detail===0?0.5:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height)),span=100/state.mapZoom,origin=50-span/2,mapX=origin+x*span,mapY=origin+y*span,campus=activeCampus(),latitude=campus.south+(100-mapY)/100*(campus.north-campus.south),longitude=campus.west+mapX/100*(campus.east-campus.west);setDeliveryPoint(latitude,longitude,mapPicker.closest('.campus-map-shell'));return}
  const authTab=e.target.closest('[data-auth-mode]');if(authTab){state.authRole=authTab.dataset.authRole||state.authRole;renderAuthWall(authTab.dataset.authMode==='choose'?'choose':'login',state.authRole);return}
  const roleChoice=e.target.closest('[data-signup-role]');if(roleChoice){renderAuthWall('signup',roleChoice.dataset.signupRole);return}
  const details=e.target.closest('[data-product-details]');if(details){renderProductDetails(details.dataset.productDetails);return}
  const add=e.target.closest('[data-add]');if(add){const product=state.products.find(p=>p.id===Number(add.dataset.add));if(product)addToCart(product);if($('#product-dialog').open)$('#product-dialog').close();return}
  const edit=e.target.closest('[data-edit-product]');if(edit){renderProductEdit(edit.dataset.editProduct);return}
  const filter=e.target.closest('[data-filter]');if(filter){state.filter=filter.dataset.filter;renderBuyerView();return}
  const removeCart=e.target.closest('[data-remove-cart]');if(removeCart){state.cart.delete(Number(removeCart.dataset.removeCart));resetEmptyBag();accountTools();renderCart();return}
  const quant=e.target.closest('[data-quantity]');if(quant){changeQuantity(quant.dataset.id,Number(quant.dataset.quantity));return}
  const orderButton=e.target.closest('[data-order-action]');if(orderButton){orderButton.disabled=true;try{await orderAction(orderButton)}catch(error){toast(error.message);orderButton.disabled=false}return}
  const stallStatus=e.target.closest('[data-stall-status]');if(stallStatus){stallStatus.disabled=true;try{await api(`/api/admin/stalls/${stallStatus.dataset.stallStatus}`,{method:'PATCH',body:json({status:stallStatus.dataset.nextStatus})});toast(stallStatus.dataset.nextStatus==='paused'?'Stall paused; customers can’t order from it.':'Stall resumed and visible to customers.');await refresh()}catch(error){toast(error.message);stallStatus.disabled=false}return}
  const remove=e.target.closest('[data-delete-product]');if(remove){if(!confirm('Remove this item from your menu?'))return;try{await api(`/api/products/${remove.dataset.deleteProduct}`,{method:'DELETE'});toast('Menu item removed.');await refresh()}catch(error){toast(error.message)}return}
  const action=e.target.closest('[data-action]');if(!action)return;
  if(action.dataset.action==='open-sidebar'){state.sidebarOpen=true;syncSidebarState();$('.sidebar-close')?.focus({preventScroll:true});return}
  if(action.dataset.action==='close-sidebar'){closeSidebar();$('.sidebar-menu-button')?.focus({preventScroll:true});return}
  if(action.dataset.action==='toggle-profile'){state.sidebarProfileOpen=!state.sidebarProfileOpen;renderSidebar();return}
  if(action.dataset.action==='toggle-sidebar-settings'){state.sidebarSettingsOpen=!state.sidebarSettingsOpen;renderSidebar();return}
  if(action.dataset.action==='toggle-theme'){
    themeMode=themeMode==='dark'?'light':'dark';
    try{localStorage.setItem('bitehub-theme',themeMode)}catch{}
    applyTheme();return;
  }
  if(action.dataset.action==='export-report'){downloadAdminReport();return}
  if(action.dataset.action==='guest-signin'||action.dataset.action==='guest-checkout'){if($('#cart-dialog').open)$('#cart-dialog').close();if($('#stall-dialog').open)$('#stall-dialog').close();renderAuthWall('login','buyer');return}
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
  if(action.dataset.action==='place-order'){action.disabled=true;try{const result=await api('/api/orders',{method:'POST',body:json({fulfillment:state.fulfillment,delivery_location:state.fulfillment==='delivery'?state.deliveryLocation:null,note:$('#order-note').value,items:cartEntries().map(p=>({product_id:p.id,quantity:p.quantity}))})});state.cart.clear();resetEmptyBag();accountTools();$('#cart-dialog').close();toast(`Order #${result.order_id} sent to the stall.`);await refresh()}catch(error){toast(error.message);action.disabled=false}}
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&state.sidebarOpen){closeSidebar();$('.sidebar-menu-button')?.focus({preventScroll:true})}
});
document.addEventListener('scroll',e=>{if(e.target.matches?.('.featured-rail'))state.featuredScroll=e.target.scrollLeft},{capture:true,passive:true});
$('#cart-dialog').addEventListener('click',e=>{if(e.target===$('#cart-dialog'))$('#cart-dialog').close()});
$('#cart-dialog').addEventListener('input',e=>{if(e.target.id==='order-note')state.cartNote=e.target.value});
$('#cart-dialog').addEventListener('change',e=>{
  if(e.target.name==='fulfillment'){
    state.fulfillment=e.target.value;
    $('#delivery-map-wrap').hidden=state.fulfillment!=='delivery';
    document.querySelectorAll('.fulfillment-choice').forEach(choice=>choice.classList.toggle('is-selected',choice.querySelector('input')===e.target));
    if(state.fulfillment==='delivery')enhanceGoogleCampusMaps();
    updateCartCheckoutButton();
  }
});
$('#account-tools').addEventListener('click',e=>{if(e.target.closest('[data-action="logout"]'))return});
document.addEventListener('submit',async e=>{
  const form=e.target.closest('[data-form]');if(!form)return;e.preventDefault();const submit=form.querySelector('button[type="submit"],button:not([type])');if(submit)submit.disabled=true;
  try{
    const formData=new FormData(form),values=Object.fromEntries(formData.entries());
    if(form.dataset.form==='user-profile'){
      const photoFile=formData.get('photo_file'),profile={name:String(values.name||'').trim()};
      if(photoFile instanceof File&&photoFile.size){if(photoFile.size>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(photoFile.type))throw new Error('Choose a JPG, PNG, or WebP profile photo under 2 MB.');profile.photo_data=await fileAsBase64(photoFile);profile.photo_type=photoFile.type}
      else if(formData.get('remove_photo'))profile.remove_photo=true;
      const result=await api('/api/profile',{method:'PATCH',body:json(profile)});state.user=result.user;state.sidebarProfileOpen=false;render();toast('Your profile has been updated.');return;
    }
    if(form.dataset.form==='signup'){
      const latitude=Number(values.school_latitude),longitude=Number(values.school_longitude);
      if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude<4||latitude>22.5||longitude<115||longitude>128)throw new Error('Search for your school on Google Maps and choose its location pin.');
      if(!PH_REGION_OPTIONS.includes(values.school_region))throw new Error('Choose a region in the Philippines.');
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
    if(form.dataset.form==='school-request'){
      const result=await api('/api/school-requests',{method:'POST',body:json(values)});form.reset();toast(result.message);return;
    }
    if(form.dataset.form==='login'||form.dataset.form==='signup'){
      const result=await api(`/api/${form.dataset.form}`,{method:'POST',body:json(values)});state.user=result.user;if(state.user.role!=='buyer'){state.cart.clear();resetEmptyBag()}applyWorkspaceHash();startAutoRefresh();$('#auth-dialog').close();toast(form.dataset.form==='signup'&&result.user.role==='owner'?'Stall account created. Your stall is now open to customers.':form.dataset.form==='signup'?'Your account is ready.':'Welcome back.');await refresh();loadNotificationState();await openSharedStall();return;
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
  }catch(error){toast(error.message)}finally{if(submit)submit.disabled=false}
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
  try{const session=await api('/api/session');state.user=session.user;if(state.user){applyWorkspaceHash();startAutoRefresh();await refresh();loadNotificationState();await openSharedStall()}else if(state.publicBrowse){applyWorkspaceHash();await refresh();await openSharedStall();startAutoRefresh()}else renderAuthWall()}
  catch(error){renderError(`${error.message} Start the server with “py server.py” from the FOODHUB folder.`)}
  finally{dismissOpeningSplash()}
}
boot();
