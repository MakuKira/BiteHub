const state={user:null,products:[],orders:[],runners:[],overview:null,paused:false,cart:new Map(),pickupSlot:null,pickupSlots:[],pickupSlotRequest:0,fulfillment:'pickup',deliveryLocation:null,mapZoom:1,trackingWatch:null,lastLocationSent:0,filter:'All',query:'',sort:'featured',stallFilter:'All',dietaryFilter:'All',allergenFilter:'All',authRole:'buyer',pushEnabled:false,pushAvailable:false};
const $=s=>document.querySelector(s), root=$('#view-content'), toastNode=$('#toast');
let refreshTimer;
let orderBaselineUserId=null;
let refreshInFlight=false;
const money=n=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2}).format(n||0);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roleLabel={buyer:'Campus customer',owner:'Stall owner',runner:'Campus runner',admin:'Administrator'};
const statusLabel={placed:'New order',confirmed:'Accepted',preparing:'Preparing',ready:'Ready',out:'On the way',completed:'Completed',declined:'Declined'};
const dietaryLabels={vegetarian:'Vegetarian',vegan:'Vegan',halal:'Halal','gluten-free':'Gluten-free','dairy-free':'Dairy-free','nut-free':'Nut-free'};
const allergenLabels={peanuts:'Peanuts','tree-nuts':'Tree nuts',milk:'Milk',eggs:'Eggs',soy:'Soy',wheat:'Wheat',fish:'Fish',shellfish:'Shellfish',sesame:'Sesame'};
const dietaryOptions=Object.entries(dietaryLabels), allergenOptions=Object.entries(allergenLabels);
let toastTimer;
const CAMPUS={south:9.736753,north:9.740445,west:118.737108,east:118.740839};
function mapXY(latitude,longitude){return{x:((longitude-CAMPUS.west)/(CAMPUS.east-CAMPUS.west))*100,y:100-((latitude-CAMPUS.south)/(CAMPUS.north-CAMPUS.south))*100}}
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
  return `<div class="campus-map-shell"><svg class="campus-map ${interactive?'is-picker':''}" viewBox="${mapViewBox()}" preserveAspectRatio="none" role="${interactive?'button':'img'}" ${interactive?'data-map-picker tabindex="0" aria-label="Select delivery point on campus map"':'aria-label="Campus delivery map"'}><image href="assets/palawan-campus-map.png" x="0" y="0" width="100" height="100" preserveAspectRatio="none"/>${path}${pin(stall,'Stall pickup','stall')}${pin(destination,'Delivery point','destination')}${pin(driver,'Runner location','driver')}</svg><div class="map-zoom-controls" aria-label="Map zoom controls"><button type="button" data-map-zoom="in" aria-label="Zoom in">+</button><button type="button" data-map-zoom="out" aria-label="Zoom out">−</button><button type="button" data-map-zoom="reset" aria-label="Reset zoom">Reset</button></div></div>`;
}
function toast(message){toastNode.textContent=message;toastNode.classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastNode.classList.remove('is-visible'),2800)}
async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body.error||`Request failed (${response.status}).`);
  return body;
}
const json=data=>JSON.stringify(data);
function fileAsBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read the food photo.'));reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.readAsDataURL(file)})}
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
    if(product.photo_url){const art=card.querySelector('.product-art-trigger');art?.querySelector('span')?.remove();art?.insertAdjacentHTML('afterbegin',`<img class="product-photo" src="${esc(product.photo_url)}" alt="Photo of ${esc(product.name)}" loading="lazy" decoding="async">`)}
    const stall=card.querySelector('.product-stall');
    if(stall){stall.setAttribute('role','button');stall.setAttribute('tabindex','0');stall.setAttribute('data-stall-profile',product.stall_id);stall.setAttribute('aria-label',`View ${product.stall_name} stall profile`);stall.insertAdjacentHTML('afterend',`<small class="product-service-note">${product.stall_open?`Open now · ${esc(product.opens_at)}–${esc(product.closes_at)} PHT`:`Closed · opens ${esc(product.opens_at)} PHT`}</small>`)}
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
function accountTools(){
  const tools=$('#account-tools');
  if(!state.user){tools.hidden=true;tools.innerHTML='';return}
  tools.hidden=false;
  tools.innerHTML=`${state.user.role==='buyer'?`<button class="button button-outline button-compact" data-action="open-cart">Your bag${cartCount()?` (${cartCount()})`:''}</button>`:''}<div class="account-chip"><span class="avatar">${esc(state.user.name.trim().charAt(0).toUpperCase())}</span><span><strong>${esc(state.user.name)}</strong><small>${esc(roleLabel[state.user.role])}${state.user.stall_name?` · ${esc(state.user.stall_name)}`:''}</small></span></div><button class="button button-outline button-compact" data-action="logout">Sign out</button>`;
}
function renderNotificationBanner(){
  const message=state.pushEnabled?'Order alerts are on for this device.':state.pushAvailable?'Get a phone or desktop alert when a new order arrives or your order changes.':'Device alerts need the server notification package. In-page updates will still work.';
  root.insertAdjacentHTML('afterbegin',`<aside class="notification-banner"><span class="notification-icon" aria-hidden="true">♧</span><div><strong>${state.pushEnabled?'Notifications enabled':'Order notifications'}</strong><p>${message}</p></div>${state.pushEnabled?'<button class="button button-outline button-small" data-action="disable-notifications">Turn off</button>':`<button class="button button-primary button-small" data-action="enable-notifications" ${state.pushAvailable?'':'disabled'}>Enable alerts</button>`}</aside>`);
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
  if(!state.user){renderAuthWall();return}
  if(refreshInFlight)return;
  refreshInFlight=true;
  const userId=state.user.id;
  try{
    const [menu,orders]=await Promise.all([includeMenu?api('/api/products'):Promise.resolve(null),api('/api/orders')]);
    if(state.user?.id!==userId)return;
    const previousStatuses=orderBaselineUserId===userId?new Map(state.orders.map(order=>[order.id,order.status])):new Map();
    const changedOrders=orders.orders.filter(order=>previousStatuses.has(order.id)&&previousStatuses.get(order.id)!==order.status);
    if(menu)state.products=menu.products;
    state.paused=orders.ordering_paused;state.orders=orders.orders;
    if(state.user.role==='owner'){
      state.user.stall_status=orders.stall_status;
      if(menu){state.user.stall_opens_at=menu.owner_hours.opens_at;state.user.stall_closes_at=menu.owner_hours.closes_at;state.user.stall_prep_minutes=menu.owner_prep_minutes;state.user.stall_pickup_slot_capacity=menu.owner_pickup_capacity;state.runners=(await api('/api/runners')).runners}
    }
    if(menu&&state.user.role==='admin')state.overview=await api('/api/admin/overview');
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
  if(!state.user)return;
  const poll=()=>{
    refreshTimer=setTimeout(async()=>{
      if(document.visibilityState==='visible'&&!document.querySelector('dialog[open]')&&!document.activeElement?.closest('form'))await refresh(false);
      if(state.user)poll();
    },state.orders.some(order=>order.status==='out'&&order.fulfillment==='delivery')?8000:30000+Math.floor(Math.random()*15000));
  };
  refreshTimer=setTimeout(poll,state.orders.some(order=>order.status==='out'&&order.fulfillment==='delivery')?1000:5000+Math.floor(Math.random()*20000));
}
function renderAuthWall(mode='choose',role=state.authRole){
  state.authRole=role;
  accountTools();
  document.querySelector('#app')?.classList.add('auth-open');
  const choosing=mode==='choose';
  const masthead=`<div class="auth-masthead"><a class="brand auth-brand" href="#home" aria-label="BiteHub home"><img class="brand-mark" src="bitehub-mark.svg" alt=""><span>Bite<span class="brand-light">Hub</span><small>GOOD FOOD. BETTER DAYS.</small></span></a><div class="school-signature"><img class="school-seal" src="assets/palawan-national-school-logo.webp" alt="Palawan National School logo"><span><strong>Palawan</strong><strong>National School</strong></span></div></div>`;
  const buyerArt=`<svg viewBox="0 0 220 170" aria-hidden="true"><circle cx="108" cy="86" r="67" fill="#acd3ff"/><path d="M35 155c8-38 34-57 73-57s65 19 75 57" fill="#3678d3"/><path d="M80 104l28 25 27-25 12 51H67z" fill="#fff"/><path d="M90 78h38v34c-9 13-27 13-38 0z" fill="#f2ad85"/><ellipse cx="109" cy="63" rx="32" ry="37" fill="#f5bd96"/><path d="M77 65c-3-31 10-47 34-47 21 0 34 17 31 43-8-5-13-16-15-23-13 13-30 18-50 17z" fill="#263247"/><circle cx="97" cy="65" r="2.7" fill="#20384d"/><circle cx="120" cy="65" r="2.7" fill="#20384d"/><path d="M99 81q10 8 20 0" fill="none" stroke="#b65a4a" stroke-width="2.5" stroke-linecap="round"/><rect x="147" y="77" width="27" height="46" rx="6" fill="#20384d" transform="rotate(9 147 77)"/><rect x="151" y="83" width="19" height="31" rx="2" fill="#d8e9ff" transform="rotate(9 151 83)"/><path d="M45 58l5 10 11 2-9 7 1 11-8-7-10 4 4-10-6-8 11 1z" fill="#fff"/></svg>`;
  const ownerArt=`<svg viewBox="0 0 220 170" aria-hidden="true"><circle cx="110" cy="91" r="67" fill="#ffe0ad"/><rect x="42" y="47" width="136" height="98" rx="9" fill="#fff"/><path d="M35 53l14-29h122l14 29z" fill="#f58228"/><path d="M49 24h27L65 53H35zM76 24h27V53H65zM103 24h27V53h-27zM130 24h27l16 29h-27z" fill="#fff4e7"/><path d="M35 53h29v15c0 16-29 16-29 0zM64 53h29v15c0 16-29 16-29 0zM93 53h29v15c0 16-29 16-29 0zM122 53h29v15c0 16-29 16-29 0zM151 53h29v15c0 16-29 16-29 0z" fill="#f58228"/><path d="M61 145c7-27 24-39 49-39 26 0 43 12 50 39" fill="#263f63"/><path d="M96 105h29v25l-15 13-14-13z" fill="#fff"/><ellipse cx="111" cy="82" rx="25" ry="29" fill="#f2b28b"/><path d="M86 81c-2-24 8-36 27-36 18 0 27 13 26 33-9-2-18-10-22-18-9 11-18 17-31 21z" fill="#302a30"/><path d="M99 84h4m17 0h4" stroke="#23384d" stroke-width="3" stroke-linecap="round"/><path d="M103 96q8 6 16 0" fill="none" stroke="#b65a4a" stroke-width="2" stroke-linecap="round"/><rect x="79" y="119" width="64" height="27" rx="5" fill="#fff" stroke="#d6e1e9"/><path d="M91 133h40" stroke="#e8793d" stroke-width="4" stroke-linecap="round"/></svg>`;
  const adminArt=`<svg viewBox="0 0 220 170" aria-hidden="true"><circle cx="108" cy="82" r="66" fill="#bfe8ce"/><path d="M47 151c8-32 29-48 62-48s54 16 63 48" fill="#267c59"/><path d="M90 99h39v25l-19 14-20-14z" fill="#fff"/><ellipse cx="109" cy="68" rx="30" ry="34" fill="#f1b58e"/><path d="M79 68c-3-28 9-42 31-42 21 0 32 14 30 40-8-2-14-9-18-17-12 10-26 15-43 14z" fill="#1f2f44"/><circle cx="97" cy="69" r="3" fill="#20384d"/><circle cx="121" cy="69" r="3" fill="#20384d"/><path d="M88 64h18m9 0h18m-27 0h9" stroke="#20384d" stroke-width="3"/><path d="M101 84q8 6 16 0" fill="none" stroke="#ad574d" stroke-width="2" stroke-linecap="round"/><rect x="65" y="120" width="94" height="38" rx="5" fill="#263d59"/><rect x="73" y="125" width="78" height="25" rx="2" fill="#dceeff"/><path d="M54 159h116l-9 7H63z" fill="#4276a3"/><circle cx="147" cy="40" r="21" fill="#fff"/><path d="M147 27l4 6 7 1-4 6 1 7-7-3-6 3 1-7-5-5 7-2z" fill="#24845c"/><circle cx="54" cy="47" r="5" fill="#fff"/><path d="M177 85l5 5m-5 0 5-5" stroke="#35a16c" stroke-width="3" stroke-linecap="round"/></svg>`;
  root.innerHTML=`<section class="role-home">${masthead}<header class="role-heading"><span class="eyebrow">${choosing?'WELCOME TO':'YOUR CAMPUS FOOD HUB'}</span><h1>${choosing?'Bite<span>Hub</span>':mode==='login'?'Welcome back':'Join BiteHub'}</h1><p>${choosing?'Your campus food hub, made for you.':mode==='login'?'Sign in to continue to your campus workspace.':'Create an account for your campus workspace.'}</p>${choosing?'<small class="role-prompt">Choose your role to get started.</small>':''}</header>${choosing?`<div class="role-card-grid"><button class="role-choice role-buyer" data-signup-role="buyer"><span class="role-art">${buyerArt}</span><strong>Buyer / Customer</strong><small>Browse food, place orders,<br>and track your delivery.</small><span class="role-choice-action">Sign up <b>→</b></span></button><button class="role-choice role-owner" data-signup-role="owner"><span class="role-art">${ownerArt}</span><strong>Stall Owner</strong><small>Manage your stall, menu,<br>and incoming orders.</small><span class="role-choice-action">Sign up <b>→</b></span></button><button class="role-choice role-admin" data-auth-mode="login" data-auth-role="admin"><span class="role-art">${adminArt}</span><strong>Admin</strong><small>Oversee campus stalls<br>and keep the hub running.</small><span class="role-choice-action">Admin sign in <b>→</b></span></button></div><p class="role-login">Already have an account? <button class="text-button" data-auth-mode="login">Sign in</button></p><p class="role-tagline"><span aria-hidden="true">✳</span> Eat <i>·</i> Support <i>·</i> Grow <span aria-hidden="true">✳</span></p>`:`<section class="auth-card"><button class="text-button auth-back" data-auth-mode="choose">← Choose a role</button><div id="auth-form-slot"></div><p class="auth-footnote">Accounts, orders, and menus are saved to this server.</p></section>`}</section>`;
  if(!choosing)renderAuthForm(mode,role);
}function renderAuthForm(mode,role=state.authRole){
  const slot=$('#auth-form-slot');if(!slot)return;
  const roleName=role==='owner'?'stall owner':role==='runner'?'campus runner':'campus customer';
  const roleCopy=role==='owner'?'Set up your stall and start publishing menu items.':role==='runner'?'Create your account to receive assigned campus deliveries.':'Browse campus menus and follow your orders.';
  slot.innerHTML=mode==='login'?`<span class="eyebrow">WELCOME BACK</span><h2>Sign in to BiteHub</h2><p class="form-intro">Use your campus account to continue.</p><form class="stack-form" data-form="login"><label>Email address<input name="email" type="email" autocomplete="username" maxlength="254" required placeholder="you@school.edu"></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="button button-primary button-wide">Sign in <span>→</span></button></form><p class="auth-switch">New to BiteHub? <button class="text-button" data-auth-mode="choose">Choose your role</button></p>`:`<span class="eyebrow">${esc(roleName)}</span><h2>Create your ${esc(roleName)} account</h2><p class="form-intro">${esc(roleCopy)}</p><form class="stack-form" data-form="signup"><input type="hidden" name="role" value="${esc(role)}"><label>Your name<input name="name" autocomplete="name" maxlength="80" required placeholder="Full name"></label><label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@school.edu"></label>${role==='owner'?'<label>Stall name<input name="stall_name" maxlength="80" required placeholder="Your stall name"></label>':''}<label>Password <span class="field-hint">At least 10 characters</span><input name="password" type="password" autocomplete="new-password" minlength="10" required></label><button class="button button-primary button-wide">Create account <span>→</span></button></form><p class="auth-switch">Already have an account? <button class="text-button" data-auth-mode="login">Sign in</button></p>`;
}
function heading(eyebrow,title,copy,side=''){
  return `<header class="page-heading"><div><span class="eyebrow">${esc(eyebrow)}</span><h1>${title}</h1><p>${esc(copy)}</p></div>${side}</header>`;
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
    if(order.status==='ready'&&order.fulfillment==='delivery')actions=`<label class="assign-runner">Runner<select data-assign-runner="${order.id}"><option value="">Choose runner</option>${state.runners.map(r=>`<option value="${r.id}" ${order.runner==r.name?'selected':''}>${esc(r.name)}</option>`).join('')}</select></label><button class="button button-primary button-small" data-order-action="assign" data-id="${order.id}">Assign</button>`;
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
  const tracking=order.fulfillment==='delivery'&&order.status==='out'&&['buyer','runner','owner'].includes(state.user.role)?`<section class="tracking-panel"><div><strong>${state.user.role==='runner'?(gpsAge<45000?'Sharing your live location':gpsAge===Infinity?'Waiting for GPS fix':gpsText):gpsAge===Infinity?'Waiting for runner location':gpsText}</strong><small>PNS campus delivery · GPS can pause indoors or when signal is weak.</small>${eta?`<p class="tracking-eta">${eta}</p>`:''}${locationAccuracy||gpsUpdated?`<small class="tracking-meta">${[locationAccuracy,gpsUpdated].filter(Boolean).join(' · ')}</small>`:''}</div>${campusMap(order)}<small class="map-key"><i class="map-key-runner"></i>Runner <i class="map-key-destination"></i>Handoff <i class="map-key-stall"></i>Stall</small><small class="tracking-note">Approximate direction only. Follow campus walkways around buildings and obstacles.</small></section>`:'';
  return `<article class="order-card"><div class="order-card-top"><div><span class="order-number">ORDER #${order.id} · ${new Date(order.created_at).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}</span><h3>${esc(order.stall)}</h3></div><span class="status-badge status-${esc(order.status)}">${esc(statusLabel[order.status]||order.status)}</span></div>${progress}<div class="order-card-body"><div><p class="order-items-summary">${itemText}</p><p class="order-subline">${order.fulfillment==='delivery'?'PNS campus delivery only':pickupTime?`Pickup · ${pickupTime}`:'Pickup'}${order.runner?` · Runner: ${esc(order.runner)}`:''}${order.buyer_note?` · “${esc(order.buyer_note)}”`:''}</p>${state.user.role!=='buyer'?`<p class="order-subline">Placed by ${esc(order.buyer)}${order.buyer_email?` · ${esc(order.buyer_email)}`:''}</p>`:''}</div><strong class="order-total">${money(order.total)}</strong></div>${tracking}${estimate}${actions?`<div class="order-actions">${actions}</div>`:''}${feedback}${feedbackForm}</article>`;
}
function emptyState(icon,title,copy){return `<div class="empty-state"><span>${icon}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>`}
function renderBuyer(){
  const q=state.query.trim().toLowerCase();
  const products=state.products.filter(p=>(state.filter==='All'||p.category===state.filter)&&(state.stallFilter==='All'||p.stall_id===Number(state.stallFilter))&&(state.dietaryFilter==='All'||p.dietary_tags.includes(state.dietaryFilter))&&(state.allergenFilter==='All'||!p.allergen_tags.includes(state.allergenFilter))&&(!q||`${p.name} ${p.stall_name} ${p.category} ${p.description} ${p.dietary_tags.join(' ')} ${p.allergen_tags.join(' ')}`.toLowerCase().includes(q)));
  if(state.sort==='price-low')products.sort((a,b)=>a.price-b.price);
  if(state.sort==='price-high')products.sort((a,b)=>b.price-a.price);
  if(state.sort==='name')products.sort((a,b)=>a.name.localeCompare(b.name));
  const categories=['All',...new Set(state.products.map(p=>p.category))];
  root.innerHTML=`${heading('BITEHUB · PNS CAMPUS','A good break starts here.','Campus favorites, made fresh by the stalls you love.',`<span class="live-pill ${state.paused?'is-paused':''}"><i></i>${state.paused?'Ordering paused':'Open for orders'}</span>`)}
  <section class="buyer-banner"><div><span class="eyebrow">MADE FRESH, RIGHT HERE</span><h2>Your break,<br>well spent.</h2><p>Find a campus favorite and we’ll get your order to the right stall.</p><a class="button button-light" href="#menu">Explore the menu <span>↓</span></a></div><div class="banner-art" aria-hidden="true"><div class="banner-sun"></div><span>🥙</span><i>✳</i><b>Good food<br>close by</b></div></section>
  <section class="section-block" id="menu"><div class="section-title"><div><span class="eyebrow">THE CAMPUS MENU</span><h2>Find your next favorite</h2></div><label class="search-field"><span aria-hidden="true">⌕</span><input type="search" id="menu-search" value="${esc(state.query)}" placeholder="Dish, stall, or craving" aria-label="Search menu"></label></div><div class="menu-controls"><div class="filter-row" role="group" aria-label="Filter menu by category">${categories.map(c=>`<button class="filter-chip ${state.filter===c?'is-active':''}" data-filter="${esc(c)}" aria-pressed="${state.filter===c}">${esc(c)}</button>`).join('')}</div><label class="sort-field">Sort<select id="menu-sort"><option value="featured" ${state.sort==='featured'?'selected':''}>Featured</option><option value="price-low" ${state.sort==='price-low'?'selected':''}>Price: low to high</option><option value="price-high" ${state.sort==='price-high'?'selected':''}>Price: high to low</option><option value="name" ${state.sort==='name'?'selected':''}>Name</option></select></label><span class="result-count" role="status" aria-live="polite">${products.length} ${products.length===1?'item':'items'}</span></div><div class="product-grid">${products.length?products.map(p=>`<article class="product-card"><button class="product-art product-art-trigger" data-product-details="${p.id}" aria-label="View details for ${esc(p.name)}"><span>${esc(p.emoji)}</span><small>${esc(p.category)}</small></button><div class="product-details"><div class="product-stall">${esc(p.stall_name)}</div><button class="product-name-trigger" data-product-details="${p.id}"><h3>${esc(p.name)}</h3></button><p>${esc(p.description||'Fresh from the stall, ready for your break.')}</p><div class="product-bottom"><strong>${money(p.price)}</strong><button class="button button-primary button-small" data-add="${p.id}" ${state.paused?'disabled':''}>${state.paused?'Paused':'Add +'}</button></div></div></article>`).join(''):state.products.length===0?emptyState('⌂','No campus menus yet','Stall owners can create an account and publish a menu. New items will appear here automatically.'):emptyState('⌕','No menu items found','Try another search or category.')}</div></section>
  <section class="section-block orders-block"><div class="section-title"><div><span class="eyebrow">YOUR RECENT ACTIVITY</span><h2>Order updates</h2></div><span class="result-count">${state.orders.length} ${state.orders.length===1?'order':'orders'}</span></div>${state.orders.length?`<div class="order-list">${state.orders.slice(0,8).map(orderCard).join('')}</div>`:emptyState('↗','Your first order starts here','Place an order and its progress will show up here.')}</section>`;
}
function renderBuyerView(){renderBuyer();addCatalogControls();decorateProductCards()}
function renderOwnerHoursPanel(){
  const opens=state.user.stall_opens_at||'00:00',closes=state.user.stall_closes_at||'23:59';
  const prep=state.user.stall_prep_minutes||15;
  const capacity=state.user.stall_pickup_slot_capacity||4;
  return `<section class="panel stall-hours-panel"><div><span class="eyebrow">STALL SCHEDULE · PHILIPPINE TIME</span><h2>Opening hours</h2><p>Orders pause outside these hours. Set a typical prep time and a fair limit for each 30-minute pickup window.</p></div><form class="stall-hours-form" data-form="stall-hours"><label>Opens<input name="opens_at" type="time" required value="${esc(opens)}"></label><span>to</span><label>Closes<input name="closes_at" type="time" required value="${esc(closes)}"></label><label>Prep minutes<input name="prep_minutes" type="number" min="1" max="180" step="1" required value="${prep}"></label><label>Orders per slot<input name="pickup_slot_capacity" type="number" min="1" max="100" step="1" required value="${capacity}"></label><button class="button button-outline button-small">Save hours</button></form></section>`;
}
function renderOwnerProfilePanel(){
  return `<section class="panel stall-profile-editor"><div><span class="eyebrow">PUBLIC STALL PAGE</span><h2>Stall profile</h2><p>Customers see this information when they tap your stall name.</p></div><form class="stack-form" data-form="stall-profile"><label>Stall name<input name="name" maxlength="80" required value="${esc(state.user.stall_name||'')}"></label><label>About this stall<textarea name="description" maxlength="500" rows="3" placeholder="What do you serve?">${esc(state.user.stall_description||'')}</textarea></label><button class="button button-outline button-small">Save stall profile</button></form></section>`;
}
async function renderStallProfile(id){
  const stall=await api(`/api/stalls/${Number(id)}`);
  $('#stall-content').innerHTML=`<form method="dialog" class="modal-dismiss"><button class="icon-button" aria-label="Close stall profile">×</button></form><span class="eyebrow">PALAWAN NATIONAL SCHOOL · STALL</span><h2>${esc(stall.name)}</h2><span class="stall-open-badge ${stall.is_open?'is-open':''}"><i></i>${stall.is_open?'Open now':'Closed'}</span><p class="stall-profile-hours">Hours · ${esc(stall.opens_at)}–${esc(stall.closes_at)} PHT</p><p class="stall-profile-description">${esc(stall.description||'This campus stall has not added a description yet.')}</p><div class="stall-profile-menu"><h3>Available menu</h3>${stall.products.length?stall.products.map(item=>`<article class="stall-menu-item"><span>${item.photo_url?`<img src="${esc(item.photo_url)}" alt="">`:esc(item.emoji)}</span><div><strong>${esc(item.name)}</strong><small>${esc(item.description||item.category)}</small></div><b>${money(item.price)}</b><button class="button button-primary button-small" data-add="${item.id}" ${state.paused||!stall.is_open||item.stock_count===0?'disabled':''}>Add +</button></article>`).join(''):emptyState('⌂','No menu items available','This stall has not published any available items.')}</div>`;
  if(!$('#stall-dialog').open)$('#stall-dialog').showModal();
}
function renderOwner(){
  const active=state.orders.filter(o=>!['completed','declined'].includes(o.status));
  const completed=state.orders.filter(o=>o.status==='completed').reduce((s,o)=>s+o.total,0);
  const feedback=state.orders.filter(o=>o.feedback).slice(0,8);
  root.innerHTML=`${heading('STALL WORKSPACE',`Welcome, ${esc(state.user.name.split(' ')[0])}.`,`Run ${state.user.stall_name||'your stall'} with one clear view of the day.`,`<span class="live-pill"><i></i>Owner account</span>`)}
  <section class="stats-grid">${stat('Open orders',active.length,'Orders to work on','↗')}${stat('Completed sales',money(completed),'From completed orders','₱')}${stat('Menu items',state.products.filter(p=>p.stall_id===state.user.stall_id).length,'Your current menu','▦')}</section>
  <div class="owner-layout"><section class="panel"><div class="section-title"><div><span class="eyebrow">ORDER QUEUE</span><h2>Incoming orders</h2></div><span class="result-count">${active.length} active</span></div>${active.length?`<div class="order-list">${active.map(orderCard).join('')}</div>`:emptyState('✓','All caught up','New orders will appear here.')}</section>
  <aside class="panel menu-manager"><div class="section-title"><div><span class="eyebrow">YOUR STALL</span><h2>Menu management</h2></div></div><form class="stack-form product-form" data-form="product"><label>Item name<input name="name" maxlength="80" required placeholder="e.g. Chicken rice bowl"></label><label>Description <span class="field-hint">Optional</span><input name="description" maxlength="240" placeholder="What makes it special?"></label><div class="form-split"><label>Category<select name="category"><option>Meals</option><option>Snacks</option><option>Drinks</option></select></label><label>Price<input name="price" type="number" min="0.01" max="1000000" step="0.01" required placeholder="₱ 0.00"></label></div><label>Food icon<select name="emoji"><option>🍽️</option><option>🍚</option><option>🍜</option><option>🥪</option><option>🥗</option><option>🍰</option><option>🧋</option><option>🍟</option><option>🍗</option></select></label><button class="button button-primary button-wide">Add to menu <span>+</span></button></form><div class="inventory-list">${state.products.filter(p=>p.stall_id===state.user.stall_id).map(p=>`<article class="inventory-item"><span class="inventory-emoji">${esc(p.emoji)}</span><div class="inventory-copy"><strong>${esc(p.name)}</strong><small>${money(p.price)} · ${esc(p.category)}</small></div><button class="button button-outline button-small" data-edit-product="${p.id}">Edit</button><label class="availability-toggle"><input type="checkbox" data-availability="${p.id}" ${p.available?'checked':''}><span>${p.available?'In menu':'Unavailable'}</span></label><button class="icon-button delete-product" data-delete-product="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></article>`).join('')||`<p class="helper-text">Your menu is empty. Add an item above to get started.</p>`}</div></aside></div><section class="panel owner-feedback"><div class="section-title"><div><span class="eyebrow">HEAR FROM YOUR CUSTOMERS</span><h2>Recent feedback</h2></div><span class="result-count">${feedback.length} reviews</span></div>${feedback.length?`<div class="feedback-list">${feedback.map(order=>`<article class="feedback-entry"><div><strong>Order #${order.id} · ${esc(order.buyer)}</strong><small>${new Date(order.created_at).toLocaleDateString()}</small></div><span class="feedback-stars">${'★'.repeat(order.feedback.rating)}${'☆'.repeat(5-order.feedback.rating)}</span>${order.feedback.comment?`<p>${esc(order.feedback.comment)}</p>`:'<p class="muted-feedback">No written comment.</p>'}</article>`).join('')}</div>`:emptyState('★','No customer feedback yet','Reviews arrive here after completed orders.')}</section>`;
  root.querySelectorAll('.inventory-item').forEach(item=>{const id=Number(item.querySelector('[data-edit-product]')?.dataset.editProduct),product=state.products.find(entry=>entry.id===id);if(product?.photo_url){const art=item.querySelector('.inventory-emoji');if(art)art.innerHTML=`<img src="${esc(product.photo_url)}" alt="">`}});
}
function renderRunner(){
  const active=state.orders.filter(o=>!['completed','declined'].includes(o.status));
  const delivered=state.orders.filter(o=>o.status==='completed').length;
  root.innerHTML=`${heading('CAMPUS RUNNER WORKSPACE','Every handoff, in sync.','Your assigned campus deliveries, from stall pickup to buyer handoff.',`<span class="live-pill"><i></i>Runner account</span>`)}<section class="stats-grid">${stat('Active deliveries',active.length,'Assigned to you','↗')}${stat('Delivered',delivered,'Completed handoffs','✓')}${stat('Next up',active[0]?.status==='ready'?'Pick up':'—',active[0]?.stall||'No pending pickup','⌖')}</section><section class="panel"><div class="section-title"><div><span class="eyebrow">YOUR DELIVERY QUEUE</span><h2>Assigned runs</h2></div><span class="result-count">${active.length} active</span></div>${active.length?`<div class="order-list">${active.map(orderCard).join('')}</div>`:emptyState('⌖','No assigned deliveries','When a stall assigns you an order, it will appear here.')}</section>`;
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
  const amount=totals.orders.reduce((s,o)=>s+o.sales,0)/100;
  root.innerHTML=`${heading('CAMPUS ADMINISTRATION','The hub, at a glance.','Manage service availability and see activity across campus.',`<button class="button ${state.paused?'button-primary':'button-dark'}" data-action="toggle-pause">${state.paused?'Resume ordering':'Pause ordering'}</button>`)}<section class="stats-grid">${stat('Campus accounts',Object.values(totals.users).reduce((a,b)=>a+b,0),'Across all account types','◎')}${stat('Campus stalls',totals.stalls,'Registered stall owners','⌂')}${stat('Menu items',totals.products,'Listed on the hub','▦')}${stat('Completed sales',money(amount),'Paid at campus stalls','₱')}</section><section class="panel admin-accounts"><div class="section-title"><div><span class="eyebrow">ACCOUNT DIRECTORY</span><h2>Campus roles</h2></div><span class="result-count">Account counts</span></div><div class="role-directory">${[['buyer','Campus customers','🥡'],['owner','Stall owners','⌂'],['runner','Campus runners','↗'],['admin','Administrators','⚙']].map(([key,label,icon])=>`<article><span>${icon}</span><div><strong>${esc(label)}</strong><small>${totals.users[key]||0} accounts</small></div></article>`).join('')}</div></section><section class="panel"><div class="section-title"><div><span class="eyebrow">CAMPUS ORDER LEDGER</span><h2>All orders</h2></div><span class="result-count">${state.orders.length} recorded</span></div>${state.orders.length?`<div class="order-list">${state.orders.map(orderCard).join('')}</div>`:emptyState('▤','No orders yet','Orders across campus will be recorded here.')}</section>`;
}
function renderStallApprovals(){
  const stalls=state.overview?.stall_list||[];
  const pending=stalls.filter(stall=>stall.status==='pending').length;
  return `<section class="panel stall-approvals"><div class="section-title"><div><span class="eyebrow">CAMPUS STALLS</span><h2>Stall approvals</h2></div><span class="result-count">${pending} pending</span></div>${stalls.length?`<div class="stall-review-list">${stalls.map(stall=>{const action=stall.status==='pending'?['approved','Approve stall']:stall.status==='approved'?['paused','Pause stall']:['approved','Resume stall'];return `<article class="stall-review-item"><div class="stall-review-copy"><strong>${esc(stall.name)}</strong><span>${esc(stall.owner_name)} · ${esc(stall.owner_email)}</span><small>${stall.product_count} menu ${stall.product_count===1?'item':'items'} · Joined ${new Date(stall.created_at).toLocaleDateString()}</small></div><span class="stall-status-badge status-${esc(stall.status)}">${esc(stall.status)}</span><button class="button ${stall.status==='pending'?'button-primary':'button-outline'} button-small" data-stall-status="${stall.id}" data-next-status="${action[0]}">${action[1]}</button></article>`}).join('')}</div>`:emptyState('⌂','No stall accounts yet','New owner registrations will appear here for review.')}</section>`;
}
function renderOwnerStallNotice(){
  const status=state.user.stall_status;
  if(status==='approved')return;
  const paused=status==='paused';
  root.insertAdjacentHTML('afterbegin',`<aside class="stall-status-notice ${paused?'is-paused':''}"><strong>${paused?'Stall paused':'Approval pending'}</strong><p>${paused?'Customers cannot see or order from your stall while it is paused. Contact an administrator to resume it.':'Your stall is hidden from customers while an administrator reviews it. You can prepare your menu while you wait.'}</p></aside>`);
}
function render(){
  accountTools();
  if(!state.user)return renderAuthWall();
  document.querySelector('#app')?.classList.remove('auth-open');
  if(state.user.role==='buyer'){renderBuyerView();renderNotificationBanner();return}
  if(state.user.role==='owner'){
    renderOwner();renderOwnerStallNotice();
    root.querySelector('.owner-layout')?.insertAdjacentHTML('beforebegin',renderOwnerHoursPanel());
    root.querySelector('.owner-layout')?.insertAdjacentHTML('beforebegin',renderOwnerProfilePanel());
    addProductMetadataFields(root.querySelector('form[data-form="product"]'));
    renderNotificationBanner();
    return;
  }
  if(state.user.role==='runner'){renderRunner();renderNotificationBanner();return}
  renderAdmin();
  root.insertAdjacentHTML('beforeend',renderStallApprovals());
  renderNotificationBanner();
}
function renderError(message){root.innerHTML=`${heading('CONNECTION ISSUE','The hub could not load.','Check the local server, then try again.')}<section class="panel error-panel"><p>${esc(message)}</p><button class="button button-primary" data-action="retry">Try again</button></section>`}
async function showAuth(mode='login'){$('#auth-dialog').close?.();renderAuthForm(mode);$('#auth-dialog').showModal()}
function cartEntries(){return [...state.cart.values()]}
function cartTotal(){return cartEntries().reduce((sum,p)=>sum+p.price*p.quantity,0)}
function renderCart(){
  const items=cartEntries();
  const pickupOptions=state.pickupSlots.map(slot=>`<option value="${esc(slot.pickup_at)}" ${state.pickupSlot===slot.pickup_at?'selected':''}>${esc(slot.label)} · ${slot.remaining} ${slot.remaining===1?'place':'places'} left</option>`).join('');
  $('#cart-content').innerHTML=`<div class="cart-heading"><span class="eyebrow">YOUR CAMPUS ORDER</span><h2 id="cart-title">Your bag</h2><p>${items.length?`${cartCount()} ${cartCount()===1?'item':'items'} in your bag`:'Pick something good for your break.'}</p>${items.length?'<button class="text-button" data-action="clear-cart">Clear bag</button>':''}</div>${items.length?`<div class="cart-lines">${items.map(p=>`<article class="cart-line"><span class="inventory-emoji">${esc(p.emoji)}</span><div><strong>${esc(p.name)}</strong><small>${money(p.price)} each · ${esc(p.stall_name)}</small><small class="line-total">Line total ${money(p.price*p.quantity)}</small></div><div class="quantity-control"><button data-quantity="-1" data-id="${p.id}" aria-label="Remove one ${esc(p.name)}">−</button><span>${p.quantity}</span><button data-quantity="1" data-id="${p.id}" aria-label="Add one ${esc(p.name)}" ${p.quantity>=50?'disabled':''}>+</button></div></article>`).join('')}</div><label class="fulfillment-label">Fulfillment<select id="fulfillment"><option value="pickup" ${state.fulfillment==='pickup'?'selected':''}>Pick up at the stall</option><option value="delivery" ${state.fulfillment==='delivery'?'selected':''}>PNS campus delivery</option></select></label><label class="pickup-slot-label" id="pickup-slot-label" ${state.fulfillment==='delivery'?'hidden':''}>Choose a 30-minute pickup window<select id="pickup-slot"><option value="">${state.pickupSlots.length?'Choose a time':'Loading available times…'}</option>${pickupOptions}</select><small>Each window has a limited number of orders.</small></label><div class="delivery-map-wrap" id="delivery-map-wrap" ${state.fulfillment!=='delivery'?'hidden':''}><strong>Choose your handoff point</strong><small>Delivery is available only inside Palawan National School. Off-campus drop-offs aren’t available.</small>${campusMap(null,true)}<span class="map-key"><i class="map-key-destination"></i>Campus handoff point</span><span id="delivery-map-status">${state.deliveryLocation?`Selected ${state.deliveryLocation.latitude.toFixed(6)}, ${state.deliveryLocation.longitude.toFixed(6)}`:'No delivery point selected'}</span></div><label class="note-label">Note for the stall <span class="field-hint">Optional</span><textarea id="order-note" maxlength="240" rows="2" placeholder="Allergies or pickup details"></textarea></label><div class="cart-total"><span>Total · ${cartCount()} ${cartCount()===1?'item':'items'}</span><strong>${money(cartTotal())}</strong></div><button class="button button-primary button-wide" data-action="place-order" ${state.paused||(state.fulfillment==='pickup'&&!state.pickupSlot)||(state.fulfillment==='delivery'&&!state.deliveryLocation)?'disabled':''}>${state.paused?'Ordering paused':'Place order'} <span>→</span></button><p class="checkout-note">Pay the stall directly at pickup or handoff.</p>`:emptyState('🥡','Your bag is empty','Add a menu item to get started.')}`;
  $('#cart-content').querySelectorAll('.cart-line').forEach(line=>{const id=Number(line.querySelector('[data-quantity]')?.dataset.id),item=state.cart.get(id);if(item?.photo_url){const art=line.querySelector('.inventory-emoji');if(art)art.innerHTML=`<img src="${esc(item.photo_url)}" alt="">`}});
  $('#cart-content').querySelectorAll('[data-quantity="1"]').forEach(button=>{
    const item=state.cart.get(Number(button.dataset.id));
    const limit=item?.stock_count===null||item?.stock_count===undefined?50:Math.min(50,item.stock_count);
    button.disabled=!item||item.quantity>=limit;
  });
  if(!$('#cart-dialog').open)$('#cart-dialog').showModal();
  if(items.length)loadPickupSlots();
}
async function loadPickupSlots(){
  const first=cartEntries()[0];if(!first)return;
  const request=++state.pickupSlotRequest;
  try{
    const result=await api(`/api/pickup-slots?stall_id=${first.stall_id}`);
    if(request!==state.pickupSlotRequest||!$('#cart-dialog').open)return;
    state.pickupSlots=result.slots;
    if(!result.slots.some(slot=>slot.pickup_at===state.pickupSlot))state.pickupSlot=null;
    const select=$('#pickup-slot');
    if(select){select.innerHTML=`<option value="">${result.slots.length?'Choose a time':'No pickup windows available'}</option>${result.slots.map(slot=>`<option value="${esc(slot.pickup_at)}" ${state.pickupSlot===slot.pickup_at?'selected':''}>${esc(slot.label)} · ${slot.remaining} ${slot.remaining===1?'place':'places'} left</option>`).join('')}`}
  }catch(error){if(request===state.pickupSlotRequest)toast(error.message)}
  const place=$('#cart-content [data-action="place-order"]');
  if(place)place.disabled=state.paused||(state.fulfillment==='pickup'&&!state.pickupSlot);
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
function changeQuantity(id,delta){const item=state.cart.get(Number(id));if(!item)return;const limit=item.stock_count===null?50:Math.min(50,item.stock_count);if(item.quantity+delta>limit){toast(item.stock_count===null?'You can order up to 50 of each item.':`Only ${item.stock_count} available.`);return}item.quantity+=delta;if(item.quantity<=0)state.cart.delete(Number(id));accountTools();renderCart()}
function renderProductDetails(id){
  const product=state.products.find(item=>item.id===Number(id));if(!product)return;
  $('#product-content').innerHTML=`<form method="dialog" class="modal-dismiss"><button class="icon-button" aria-label="Close item details">×</button></form><div class="product-detail-art">${esc(product.emoji)}</div><span class="eyebrow">${esc(product.category)} · ${esc(product.stall_name)}</span><h2>${esc(product.name)}</h2><p>${esc(product.description||'Fresh from the stall, ready for your break.')}</p>${product.stall_description?`<p class="stall-description">${esc(product.stall_description)}</p>`:''}<div class="product-detail-footer"><strong>${money(product.price)}</strong><button class="button button-primary" data-add="${product.id}" ${state.paused||!product.available?'disabled':''}>${!product.available?'Unavailable':state.paused?'Ordering paused':'Add to bag'}</button></div>`;
  if(product.photo_url)$('#product-content .product-detail-art').innerHTML=`<img class="product-detail-photo" src="${esc(product.photo_url)}" alt="Photo of ${esc(product.name)}">`;
  const footer=$('#product-content .product-detail-footer');
  footer?.insertAdjacentHTML('beforebegin',`<p class="detail-stock">Stall hours: ${esc(product.opens_at)}–${esc(product.closes_at)} Philippine time</p>`);
  if(productTags(product))footer?.insertAdjacentHTML('beforebegin',`<div class="product-tag-summary detail-tags">${productTags(product)}</div>`);
  if(product.stock_count!==null)footer?.insertAdjacentHTML('beforebegin',`<p class="detail-stock">${product.available?`${product.stock_count} remaining`:'Sold out'}</p>`);
  if(!product.stall_open)footer?.insertAdjacentHTML('beforebegin',`<p class="detail-stock">Closed · opens at ${esc(product.opens_at)}</p>`);
  const add=$('#product-content [data-add]');
  if(add){add.disabled=state.paused||!product.stall_open||!product.available;add.textContent=state.paused?'Ordering paused':!product.stall_open?'Stall closed':!product.available?'Sold out':'Add to bag'}
  if(!$('#product-dialog').open)$('#product-dialog').showModal();
}
function renderProductEdit(id){
  const product=state.products.find(item=>item.id===Number(id));if(!product)return;
  $('#product-edit-content').innerHTML=`<form method="dialog" class="modal-dismiss"><button class="icon-button" aria-label="Close edit item">×</button></form><span class="eyebrow">YOUR STALL MENU</span><h2>Edit menu item</h2><form class="stack-form" data-form="product-edit" data-id="${product.id}"><label>Item name<input name="name" maxlength="80" required value="${esc(product.name)}"></label><label>Description <span class="field-hint">Optional</span><input name="description" maxlength="240" value="${esc(product.description)}"></label><div class="form-split"><label>Category<select name="category">${['Meals','Snacks','Drinks'].map(category=>`<option ${product.category===category?'selected':''}>${category}</option>`).join('')}</select></label><label>Price<input name="price" type="number" min="0.01" max="1000000" step="0.01" required value="${Number(product.price).toFixed(2)}"></label></div><label>Food icon<select name="emoji">${['🍽️','🍚','🍜','🥪','🥗','🍰','🧋','🍟','🍗'].map(icon=>`<option ${product.emoji===icon?'selected':''}>${icon}</option>`).join('')}</select></label><button class="button button-primary button-wide">Save changes</button></form>`;
  addProductMetadataFields($('#product-edit-content form[data-form="product-edit"]'),product);
  if(!$('#product-edit-dialog').open)$('#product-edit-dialog').showModal();
}
async function orderAction(button){
  const id=button.dataset.id,action=button.dataset.orderAction,payload={action};
  if(action==='assign'){payload.runner_id=Number($(`[data-assign-runner="${id}"]`)?.value);if(!payload.runner_id)throw new Error('Choose a runner to assign this order.')}
  await api(`/api/orders/${id}`,{method:'PATCH',body:json(payload)});toast('Order updated.');await refresh();
}
root.addEventListener('input',e=>{
  if(e.target.id==='menu-search'){state.query=e.target.value;const start=e.target.selectionStart;renderBuyerView();const input=$('#menu-search');input.focus();input.setSelectionRange(start,start)}
});
document.addEventListener('change',e=>{
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
document.addEventListener('click',async e=>{
  const stallProfile=e.target.closest('[data-stall-profile]');if(stallProfile){try{await renderStallProfile(stallProfile.dataset.stallProfile)}catch(error){toast(error.message)}return}
  const enableAlerts=e.target.closest('[data-action="enable-notifications"]');if(enableAlerts){enableAlerts.disabled=true;try{await enablePushNotifications()}catch(error){toast(error.message);enableAlerts.disabled=false}return}
  const disableAlerts=e.target.closest('[data-action="disable-notifications"]');if(disableAlerts){disableAlerts.disabled=true;try{await disablePushNotifications()}catch(error){toast(error.message);disableAlerts.disabled=false}return}
  const zoom=e.target.closest('[data-map-zoom]');if(zoom){setMapZoom(zoom.dataset.mapZoom);return}
  const mapPicker=e.target.closest('[data-map-picker]');if(mapPicker){const rect=mapPicker.getBoundingClientRect(),x=e.detail===0?0.5:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y=e.detail===0?0.5:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height)),span=100/state.mapZoom,origin=50-span/2,mapX=origin+x*span,mapY=origin+y*span;state.deliveryLocation={latitude:CAMPUS.south+(100-mapY)/100*(CAMPUS.north-CAMPUS.south),longitude:CAMPUS.west+mapX/100*(CAMPUS.east-CAMPUS.west)};mapPicker.closest('.campus-map-shell').outerHTML=campusMap(null,true);$('#delivery-map-status').textContent=`Selected ${state.deliveryLocation.latitude.toFixed(6)}, ${state.deliveryLocation.longitude.toFixed(6)}`;const place=$('#cart-content [data-action="place-order"]');if(place)place.disabled=state.paused;return}
  const authTab=e.target.closest('[data-auth-mode]');if(authTab){state.authRole=authTab.dataset.authRole||state.authRole;renderAuthWall(authTab.dataset.authMode==='choose'?'choose':'login',state.authRole);return}
  const roleChoice=e.target.closest('[data-signup-role]');if(roleChoice){renderAuthWall('signup',roleChoice.dataset.signupRole);return}
  const details=e.target.closest('[data-product-details]');if(details){renderProductDetails(details.dataset.productDetails);return}
  const add=e.target.closest('[data-add]');if(add){const product=state.products.find(p=>p.id===Number(add.dataset.add));if(product)addToCart(product);if($('#product-dialog').open)$('#product-dialog').close();return}
  const edit=e.target.closest('[data-edit-product]');if(edit){renderProductEdit(edit.dataset.editProduct);return}
  const filter=e.target.closest('[data-filter]');if(filter){state.filter=filter.dataset.filter;renderBuyerView();return}
  const quant=e.target.closest('[data-quantity]');if(quant){changeQuantity(quant.dataset.id,Number(quant.dataset.quantity));return}
  const orderButton=e.target.closest('[data-order-action]');if(orderButton){orderButton.disabled=true;try{await orderAction(orderButton)}catch(error){toast(error.message);orderButton.disabled=false}return}
  const stallStatus=e.target.closest('[data-stall-status]');if(stallStatus){stallStatus.disabled=true;try{await api(`/api/admin/stalls/${stallStatus.dataset.stallStatus}`,{method:'PATCH',body:json({status:stallStatus.dataset.nextStatus})});toast(stallStatus.dataset.nextStatus==='approved'?'Stall approved and visible to customers.':stallStatus.dataset.nextStatus==='paused'?'Stall paused.':'Stall resumed.');await refresh()}catch(error){toast(error.message);stallStatus.disabled=false}return}
  const remove=e.target.closest('[data-delete-product]');if(remove){if(!confirm('Remove this item from your menu?'))return;try{await api(`/api/products/${remove.dataset.deleteProduct}`,{method:'DELETE'});toast('Menu item removed.');await refresh()}catch(error){toast(error.message)}return}
  const action=e.target.closest('[data-action]');if(!action)return;
  if(action.dataset.action==='open-cart'){renderCart();return}
  if(action.dataset.action==='logout'){await api('/api/logout',{method:'POST',body:'{}'});clearTimeout(refreshTimer);if(state.trackingWatch!==null)navigator.geolocation?.clearWatch(state.trackingWatch);state.trackingWatch=null;state.user=null;state.cart.clear();renderAuthWall();toast('You are signed out.');return}
  if(action.dataset.action==='clear-cart'){state.cart.clear();state.pickupSlot=null;state.pickupSlots=[];state.fulfillment='pickup';accountTools();renderCart();return}
  if(action.dataset.action==='retry'){await boot();return}
  if(action.dataset.action==='toggle-pause'){try{const result=await api('/api/admin/pause',{method:'POST',body:json({paused:!state.paused})});state.paused=result.ordering_paused;toast(state.paused?'Ordering paused.':'Ordering is open.');await refresh()}catch(error){toast(error.message)}return}
  if(action.dataset.action==='place-order'){action.disabled=true;try{const result=await api('/api/orders',{method:'POST',body:json({fulfillment:state.fulfillment,pickup_at:state.fulfillment==='pickup'?state.pickupSlot:null,delivery_location:state.fulfillment==='delivery'?state.deliveryLocation:null,note:$('#order-note').value,items:cartEntries().map(p=>({product_id:p.id,quantity:p.quantity}))})});state.cart.clear();state.pickupSlot=null;state.pickupSlots=[];state.deliveryLocation=null;state.fulfillment='pickup';$('#cart-dialog').close();toast(`Order #${result.order_id} sent to the stall.`);await refresh()}catch(error){toast(error.message);action.disabled=false}}
});
$('#cart-dialog').addEventListener('click',e=>{if(e.target===$('#cart-dialog'))$('#cart-dialog').close()});
$('#cart-dialog').addEventListener('change',e=>{
  if(e.target.id==='fulfillment'){
    state.fulfillment=e.target.value;
    $('#pickup-slot-label').hidden=state.fulfillment==='delivery';
    $('#delivery-map-wrap').hidden=state.fulfillment!=='delivery';
    if(state.fulfillment==='pickup')loadPickupSlots();
    const place=$('#cart-content [data-action="place-order"]');
    if(place)place.disabled=state.paused||(state.fulfillment==='pickup'&&!state.pickupSlot)||(state.fulfillment==='delivery'&&!state.deliveryLocation);
  }
  if(e.target.id==='pickup-slot'){
    state.pickupSlot=e.target.value||null;
    const place=$('#cart-content [data-action="place-order"]');
    if(place)place.disabled=state.paused||(state.fulfillment==='pickup'&&!state.pickupSlot)||(state.fulfillment==='delivery'&&!state.deliveryLocation);
  }
});
$('#account-tools').addEventListener('click',e=>{if(e.target.closest('[data-action="logout"]'))return});
document.addEventListener('submit',async e=>{
  const form=e.target.closest('[data-form]');if(!form)return;e.preventDefault();const submit=form.querySelector('button[type="submit"],button:not([type])');if(submit)submit.disabled=true;
  try{
    const formData=new FormData(form),values=Object.fromEntries(formData.entries());
    if(['product','product-edit'].includes(form.dataset.form)){
      const photoFile=formData.get('photo_file');delete values.photo_file;delete values.remove_photo;
      if(photoFile instanceof File&&photoFile.size){if(photoFile.size>2*1024*1024||!['image/jpeg','image/png','image/webp'].includes(photoFile.type))throw new Error('Choose a JPG, PNG, or WebP photo under 2 MB.');values.photo_data=await fileAsBase64(photoFile);values.photo_type=photoFile.type}
      else if(formData.get('remove_photo'))values.remove_photo=true;
      values.stock_count=values.stock_count===''?null:Number(values.stock_count);
      values.dietary_tags=formData.getAll('dietary_tags');
      values.allergen_tags=formData.getAll('allergen_tags');
    }
    if(form.dataset.form==='login'||form.dataset.form==='signup'){
      const result=await api(`/api/${form.dataset.form}`,{method:'POST',body:json(values)});state.user=result.user;startAutoRefresh();$('#auth-dialog').close();toast(form.dataset.form==='signup'&&result.user.role==='owner'?'Stall account created. Waiting for admin approval.':form.dataset.form==='signup'?'Your account is ready.':'Welcome back.');await refresh();loadNotificationState();return;
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
      values.prep_minutes=Number(values.prep_minutes);values.pickup_slot_capacity=Number(values.pickup_slot_capacity);const result=await api('/api/stall/hours',{method:'PATCH',body:json(values)});state.user.stall_opens_at=result.opens_at;state.user.stall_closes_at=result.closes_at;state.user.stall_prep_minutes=result.prep_minutes;state.user.stall_pickup_slot_capacity=result.pickup_slot_capacity;toast('Stall hours and pickup limit saved.');await refresh();return;
    }
    if(form.dataset.form==='stall-profile'){
      const result=await api('/api/stall/profile',{method:'PATCH',body:json(values)});state.user.stall_name=result.name;state.user.stall_description=result.description;toast('Public stall profile saved.');await refresh();return;
    }
  }catch(error){toast(error.message)}finally{if(submit)submit.disabled=false}
});
async function boot(){
  try{const session=await api('/api/session');state.user=session.user;if(state.user){startAutoRefresh();await refresh();loadNotificationState()}else renderAuthWall()}
  catch(error){renderError(`${error.message} Start the server with “py server.py” from the FOODHUB folder.`)}
}
boot();
