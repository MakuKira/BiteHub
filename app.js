const state={user:null,products:[],orders:[],runners:[],overview:null,paused:false,cart:new Map(),filter:'All',query:''};
const $=s=>document.querySelector(s), root=$('#view-content'), toastNode=$('#toast');
const money=n=>new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2}).format(n||0);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const roleLabel={buyer:'Campus customer',owner:'Stall owner',runner:'Campus runner',admin:'Administrator'};
const statusLabel={placed:'New order',confirmed:'Accepted',preparing:'Preparing',ready:'Ready',out:'On the way',completed:'Completed',declined:'Declined'};
let toastTimer;
function toast(message){toastNode.textContent=message;toastNode.classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastNode.classList.remove('is-visible'),2800)}
async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body.error||`Request failed (${response.status}).`);
  return body;
}
const json=data=>JSON.stringify(data);
function accountTools(){
  const tools=$('#account-tools');
  if(!state.user){tools.hidden=true;tools.innerHTML='';return}
  tools.hidden=false;
  tools.innerHTML=`${state.user.role==='buyer'?'<button class="button button-outline button-compact" data-action="open-cart">Your bag</button>':''}<div class="account-chip"><span class="avatar">${esc(state.user.name.trim().charAt(0).toUpperCase())}</span><span><strong>${esc(state.user.name)}</strong><small>${esc(roleLabel[state.user.role])}${state.user.stall_name?` · ${esc(state.user.stall_name)}`:''}</small></span></div><button class="button button-outline button-compact" data-action="logout">Sign out</button>`;
}
async function refresh(){
  if(!state.user){renderAuthWall();return}
  try{
    const [menu,orders]=await Promise.all([api('/api/products'),api('/api/orders')]);
    state.products=menu.products;state.paused=menu.ordering_paused;state.orders=orders.orders;
    if(state.user.role==='owner')state.runners=(await api('/api/runners')).runners;
    if(state.user.role==='admin')state.overview=await api('/api/admin/overview');
    render();
  }catch(error){renderError(error.message)}
}
function renderAuthWall(){
  accountTools();
  root.innerHTML=`<section class="welcome-layout"><div class="welcome-copy"><span class="eyebrow">YOUR CAMPUS, A LITTLE TASTIER</span><h1>Good food.<br><span>Better breaks.</span></h1><p>Find campus favorites, order ahead, and keep every stall moving from one shared hub.</p><div class="welcome-points"><span>01 &nbsp; Browse campus menus</span><span>02 &nbsp; Follow every order</span><span>03 &nbsp; Keep your break yours</span></div><div class="welcome-art" aria-hidden="true"><span>🥗</span><i>✳</i><b>Fresh from campus</b></div></div><section class="auth-card"><div class="auth-tabs"><button class="auth-tab is-active" data-auth-mode="login">Sign in</button><button class="auth-tab" data-auth-mode="signup">Create account</button></div><div id="auth-form-slot"></div><p class="auth-footnote">Accounts, orders, and menus are saved to this server.</p></section></section>`;
  renderAuthForm('login');
}
function renderAuthForm(mode){
  const slot=$('#auth-form-slot');if(!slot)return;
  slot.innerHTML=mode==='login'?`<span class="eyebrow">WELCOME BACK</span><h2>Sign in to BiteHub</h2><p class="form-intro">Your next favorite is just around the corner.</p><form class="stack-form" data-form="login"><label>Email address<input name="email" type="email" autocomplete="username" maxlength="254" required placeholder="you@school.edu"></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="button button-primary button-wide">Sign in <span>→</span></button></form>`:`<span class="eyebrow">JOIN THE CAMPUS HUB</span><h2>Create your account</h2><p class="form-intro">Choose the workspace that fits what you do.</p><form class="stack-form" data-form="signup"><label>Your name<input name="name" autocomplete="name" maxlength="80" required placeholder="Full name"></label><label>Email address<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@school.edu"></label><label>Account type<select name="role"><option value="buyer">Campus customer</option><option value="owner">Stall owner</option><option value="runner">Campus runner</option></select></label><label data-stall-field hidden>Stall name<input name="stall_name" maxlength="80" placeholder="Your stall name"></label><label>Password <span class="field-hint">At least 10 characters</span><input name="password" type="password" autocomplete="new-password" minlength="10" required></label><button class="button button-primary button-wide">Create account <span>→</span></button></form>`;
}
function heading(eyebrow,title,copy,side=''){
  return `<header class="page-heading"><div><span class="eyebrow">${esc(eyebrow)}</span><h1>${title}</h1><p>${esc(copy)}</p></div>${side}</header>`;
}
function stat(label,value,note,icon){return `<article class="stat-card"><span class="stat-icon">${icon}</span><small>${esc(label)}</small><strong>${esc(value)}</strong><span class="stat-note">${esc(note)}</span></article>`}
function orderCard(order){
  const itemText=order.items.map(i=>`${i.quantity} × ${esc(i.name)}`).join(' · ');
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
  return `<article class="order-card"><div class="order-card-top"><div><span class="order-number">ORDER #${order.id} · ${new Date(order.created_at).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}</span><h3>${esc(order.stall)}</h3></div><span class="status-badge status-${esc(order.status)}">${esc(statusLabel[order.status]||order.status)}</span></div><div class="order-card-body"><div><p class="order-items-summary">${itemText}</p><p class="order-subline">${order.fulfillment==='delivery'?'Campus delivery':'Pickup'}${order.runner?` · Runner: ${esc(order.runner)}`:''}${order.buyer_note?` · “${esc(order.buyer_note)}”`:''}</p>${state.user.role!=='buyer'?`<p class="order-subline">Placed by ${esc(order.buyer)}${order.buyer_email?` · ${esc(order.buyer_email)}`:''}</p>`:''}</div><strong class="order-total">${money(order.total)}</strong></div>${actions?`<div class="order-actions">${actions}</div>`:''}</article>`;
}
function emptyState(icon,title,copy){return `<div class="empty-state"><span>${icon}</span><h3>${esc(title)}</h3><p>${esc(copy)}</p></div>`}
function renderBuyer(){
  const q=state.query.trim().toLowerCase();
  const products=state.products.filter(p=>(state.filter==='All'||p.category===state.filter)&&(!q||`${p.name} ${p.stall_name} ${p.category} ${p.description}`.toLowerCase().includes(q)));
  const categories=['All','Meals','Snacks','Drinks'];
  root.innerHTML=`${heading('BITEHUB · PNS CAMPUS','A good break starts here.','Campus favorites, made fresh by the stalls you love.',`<span class="live-pill ${state.paused?'is-paused':''}"><i></i>${state.paused?'Ordering paused':'Open for orders'}</span>`)}
  <section class="buyer-banner"><div><span class="eyebrow">MADE FRESH, RIGHT HERE</span><h2>Your break,<br>well spent.</h2><p>Find a campus favorite and we’ll get your order to the right stall.</p><a class="button button-light" href="#menu">Explore the menu <span>↓</span></a></div><div class="banner-art" aria-hidden="true"><div class="banner-sun"></div><span>🥙</span><i>✳</i><b>Good food<br>close by</b></div></section>
  <section class="section-block" id="menu"><div class="section-title"><div><span class="eyebrow">THE CAMPUS MENU</span><h2>Find your next favorite</h2></div><label class="search-field"><span>⌕</span><input type="search" id="menu-search" value="${esc(state.query)}" placeholder="Dish, stall, or craving" aria-label="Search menu"></label></div><div class="menu-controls"><div class="filter-row">${categories.map(c=>`<button class="filter-chip ${state.filter===c?'is-active':''}" data-filter="${c}">${c}</button>`).join('')}</div><span class="result-count">${products.length} ${products.length===1?'item':'items'}</span></div><div class="product-grid">${products.length?products.map(p=>`<article class="product-card"><div class="product-art"><span>${esc(p.emoji)}</span><small>${esc(p.category)}</small></div><div class="product-details"><div class="product-stall">${esc(p.stall_name)}</div><h3>${esc(p.name)}</h3><p>${esc(p.description||'Fresh from the stall, ready for your break.')}</p><div class="product-bottom"><strong>${money(p.price)}</strong><button class="button button-primary button-small" data-add="${p.id}" ${state.paused?'disabled':''}>${state.paused?'Paused':'Add +'}</button></div></div></article>`).join(''):emptyState('⌕','No menu items found','Try another search or category.')}</div></section>
  <section class="section-block orders-block"><div class="section-title"><div><span class="eyebrow">YOUR RECENT ACTIVITY</span><h2>Order updates</h2></div><span class="result-count">${state.orders.length} ${state.orders.length===1?'order':'orders'}</span></div>${state.orders.length?`<div class="order-list">${state.orders.slice(0,8).map(orderCard).join('')}</div>`:emptyState('↗','Your first order starts here','Place an order and its progress will show up here.')}</section>`;
}
function renderOwner(){
  const active=state.orders.filter(o=>!['completed','declined'].includes(o.status));
  const completed=state.orders.filter(o=>o.status==='completed').reduce((s,o)=>s+o.total,0);
  root.innerHTML=`${heading('STALL WORKSPACE',`Welcome, ${esc(state.user.name.split(' ')[0])}.`,`Run ${state.user.stall_name||'your stall'} with one clear view of the day.`,`<span class="live-pill"><i></i>Owner account</span>`)}
  <section class="stats-grid">${stat('Open orders',active.length,'Orders to work on','↗')}${stat('Completed sales',money(completed),'From completed orders','₱')}${stat('Menu items',state.products.filter(p=>p.stall_id===state.user.stall_id).length,'Your current menu','▦')}</section>
  <div class="owner-layout"><section class="panel"><div class="section-title"><div><span class="eyebrow">ORDER QUEUE</span><h2>Incoming orders</h2></div><span class="result-count">${active.length} active</span></div>${active.length?`<div class="order-list">${active.map(orderCard).join('')}</div>`:emptyState('✓','All caught up','New orders will appear here.')}</section>
  <aside class="panel menu-manager"><div class="section-title"><div><span class="eyebrow">YOUR STALL</span><h2>Menu management</h2></div></div><form class="stack-form product-form" data-form="product"><label>Item name<input name="name" maxlength="80" required placeholder="e.g. Chicken rice bowl"></label><label>Description <span class="field-hint">Optional</span><input name="description" maxlength="240" placeholder="What makes it special?"></label><div class="form-split"><label>Category<select name="category"><option>Meals</option><option>Snacks</option><option>Drinks</option></select></label><label>Price<input name="price" type="number" min="0.01" max="1000000" step="0.01" required placeholder="₱ 0.00"></label></div><label>Food icon<select name="emoji"><option>🍽️</option><option>🍚</option><option>🍜</option><option>🥪</option><option>🥗</option><option>🍰</option><option>🧋</option><option>🍟</option><option>🍗</option></select></label><button class="button button-primary button-wide">Add to menu <span>+</span></button></form><div class="inventory-list">${state.products.filter(p=>p.stall_id===state.user.stall_id).map(p=>`<article class="inventory-item"><span class="inventory-emoji">${esc(p.emoji)}</span><div class="inventory-copy"><strong>${esc(p.name)}</strong><small>${money(p.price)} · ${esc(p.category)}</small></div><label class="availability-toggle"><input type="checkbox" data-availability="${p.id}" ${p.available?'checked':''}><span>${p.available?'In menu':'Unavailable'}</span></label><button class="icon-button delete-product" data-delete-product="${p.id}" aria-label="Remove ${esc(p.name)}">×</button></article>`).join('')||`<p class="helper-text">Your menu is empty. Add an item above to get started.</p>`}</div></aside></div>`;
}
function renderRunner(){
  const active=state.orders.filter(o=>!['completed','declined'].includes(o.status));
  const delivered=state.orders.filter(o=>o.status==='completed').length;
  root.innerHTML=`${heading('CAMPUS RUNNER WORKSPACE','Every handoff, in sync.','Your assigned campus deliveries, from stall pickup to buyer handoff.',`<span class="live-pill"><i></i>Runner account</span>`)}<section class="stats-grid">${stat('Active deliveries',active.length,'Assigned to you','↗')}${stat('Delivered',delivered,'Completed handoffs','✓')}${stat('Next up',active[0]?.status==='ready'?'Pick up':'—',active[0]?.stall||'No pending pickup','⌖')}</section><section class="panel"><div class="section-title"><div><span class="eyebrow">YOUR DELIVERY QUEUE</span><h2>Assigned runs</h2></div><span class="result-count">${active.length} active</span></div>${active.length?`<div class="order-list">${active.map(orderCard).join('')}</div>`:emptyState('⌖','No assigned deliveries','When a stall assigns you an order, it will appear here.')}</section>`;
}
function renderAdmin(){
  const totals=state.overview||{users:{},stalls:0,products:0,orders:[],ordering_paused:state.paused};
  const amount=totals.orders.reduce((s,o)=>s+o.sales,0)/100;
  root.innerHTML=`${heading('CAMPUS ADMINISTRATION','The hub, at a glance.','Manage service availability and see activity across campus.',`<button class="button ${state.paused?'button-primary':'button-dark'}" data-action="toggle-pause">${state.paused?'Resume ordering':'Pause ordering'}</button>`)}<section class="stats-grid">${stat('Campus accounts',Object.values(totals.users).reduce((a,b)=>a+b,0),'Across all account types','◎')}${stat('Campus stalls',totals.stalls,'Registered stall owners','⌂')}${stat('Menu items',totals.products,'Listed on the hub','▦')}${stat('Completed sales',money(amount),'Paid at campus stalls','₱')}</section><section class="panel admin-accounts"><div class="section-title"><div><span class="eyebrow">ACCOUNT DIRECTORY</span><h2>Campus roles</h2></div><span class="result-count">Account counts</span></div><div class="role-directory">${[['buyer','Campus customers','🥡'],['owner','Stall owners','⌂'],['runner','Campus runners','↗'],['admin','Administrators','⚙']].map(([key,label,icon])=>`<article><span>${icon}</span><div><strong>${esc(label)}</strong><small>${totals.users[key]||0} accounts</small></div></article>`).join('')}</div></section><section class="panel"><div class="section-title"><div><span class="eyebrow">CAMPUS ORDER LEDGER</span><h2>All orders</h2></div><span class="result-count">${state.orders.length} recorded</span></div>${state.orders.length?`<div class="order-list">${state.orders.map(orderCard).join('')}</div>`:emptyState('▤','No orders yet','Orders across campus will be recorded here.')}</section>`;
}
function render(){accountTools();if(!state.user)return renderAuthWall();if(state.user.role==='buyer')renderBuyer();else if(state.user.role==='owner')renderOwner();else if(state.user.role==='runner')renderRunner();else renderAdmin()}
function renderError(message){root.innerHTML=`${heading('CONNECTION ISSUE','The hub could not load.','Check the local server, then try again.')}<section class="panel error-panel"><p>${esc(message)}</p><button class="button button-primary" data-action="retry">Try again</button></section>`}
async function showAuth(mode='login'){$('#auth-dialog').close?.();renderAuthForm(mode);$('#auth-dialog').showModal()}
function cartEntries(){return [...state.cart.values()]}
function cartTotal(){return cartEntries().reduce((sum,p)=>sum+p.price*p.quantity,0)}
function renderCart(){
  const items=cartEntries();
  $('#cart-content').innerHTML=`<div class="cart-heading"><span class="eyebrow">YOUR CAMPUS ORDER</span><h2 id="cart-title">Your bag</h2><p>${items.length?`${items.reduce((n,i)=>n+i.quantity,0)} items in your bag`:'Pick something good for your break.'}</p></div>${items.length?`<div class="cart-lines">${items.map(p=>`<article class="cart-line"><span class="inventory-emoji">${esc(p.emoji)}</span><div><strong>${esc(p.name)}</strong><small>${money(p.price)} each · ${esc(p.stall_name)}</small></div><div class="quantity-control"><button data-quantity="-1" data-id="${p.id}" aria-label="Remove one ${esc(p.name)}">−</button><span>${p.quantity}</span><button data-quantity="1" data-id="${p.id}" aria-label="Add one ${esc(p.name)}">+</button></div></article>`).join('')}</div><label class="fulfillment-label">Fulfillment<select id="fulfillment"><option value="pickup">Pick up at the stall</option><option value="delivery">Campus delivery</option></select></label><label class="note-label">Note for the stall <span class="field-hint">Optional</span><textarea id="order-note" maxlength="240" rows="2" placeholder="Allergies or pickup details"></textarea></label><div class="cart-total"><span>Total</span><strong>${money(cartTotal())}</strong></div><button class="button button-primary button-wide" data-action="place-order" ${state.paused?'disabled':''}>${state.paused?'Ordering paused':'Place order'} <span>→</span></button><p class="checkout-note">Pay the stall directly at pickup or handoff.</p>`:emptyState('🥡','Your bag is empty','Add a menu item to get started.')}`;
  $('#cart-dialog').showModal();
}
function changeQuantity(id,delta){const item=state.cart.get(Number(id));if(!item)return;item.quantity+=delta;if(item.quantity<=0)state.cart.delete(Number(id));renderCart()}
async function orderAction(button){
  const id=button.dataset.id,action=button.dataset.orderAction,payload={action};
  if(action==='assign'){payload.runner_id=Number($(`[data-assign-runner="${id}"]`)?.value);if(!payload.runner_id)throw new Error('Choose a runner to assign this order.')}
  await api(`/api/orders/${id}`,{method:'PATCH',body:json(payload)});toast('Order updated.');await refresh();
}
root.addEventListener('input',e=>{
  if(e.target.id==='menu-search'){state.query=e.target.value;const start=e.target.selectionStart;renderBuyer();const input=$('#menu-search');input.focus();input.setSelectionRange(start,start)}
});
root.addEventListener('change',async e=>{
  if(e.target.name==='role'){const field=$('[data-stall-field]');if(field)field.hidden=e.target.value!=='owner'}
  if(e.target.matches('[data-availability]')){try{await api(`/api/products/${e.target.dataset.availability}`,{method:'PATCH',body:json({available:e.target.checked})});toast('Menu availability saved.');await refresh()}catch(error){toast(error.message);await refresh()}}
});
document.addEventListener('click',async e=>{
  const authTab=e.target.closest('[data-auth-mode]');if(authTab){document.querySelectorAll('.auth-tab').forEach(b=>b.classList.toggle('is-active',b===authTab));renderAuthForm(authTab.dataset.authMode);return}
  const add=e.target.closest('[data-add]');if(add){const product=state.products.find(p=>p.id===Number(add.dataset.add));if(!product)return;if([...state.cart.values()].some(p=>p.stall_id!==product.stall_id)){toast('Place a separate order for each stall.');return}const item=state.cart.get(product.id)||{...product,quantity:0};item.quantity++;state.cart.set(product.id,item);toast(`${product.name} added to your bag.`);return}
  const quant=e.target.closest('[data-quantity]');if(quant){changeQuantity(quant.dataset.id,Number(quant.dataset.quantity));return}
  const orderButton=e.target.closest('[data-order-action]');if(orderButton){orderButton.disabled=true;try{await orderAction(orderButton)}catch(error){toast(error.message);orderButton.disabled=false}return}
  const remove=e.target.closest('[data-delete-product]');if(remove){if(!confirm('Remove this item from your menu?'))return;try{await api(`/api/products/${remove.dataset.deleteProduct}`,{method:'DELETE'});toast('Menu item removed.');await refresh()}catch(error){toast(error.message)}return}
  const action=e.target.closest('[data-action]');if(!action)return;
  if(action.dataset.action==='open-cart'){renderCart();return}
  if(action.dataset.action==='logout'){await api('/api/logout',{method:'POST',body:'{}'});state.user=null;state.cart.clear();renderAuthWall();toast('You are signed out.');return}
  if(action.dataset.action==='retry'){await boot();return}
  if(action.dataset.action==='toggle-pause'){try{const result=await api('/api/admin/pause',{method:'POST',body:json({paused:!state.paused})});state.paused=result.ordering_paused;toast(state.paused?'Ordering paused.':'Ordering is open.');await refresh()}catch(error){toast(error.message)}return}
  if(action.dataset.action==='place-order'){action.disabled=true;try{const result=await api('/api/orders',{method:'POST',body:json({fulfillment:$('#fulfillment').value,note:$('#order-note').value,items:cartEntries().map(p=>({product_id:p.id,quantity:p.quantity}))})});state.cart.clear();$('#cart-dialog').close();toast(`Order #${result.order_id} sent to the stall.`);await refresh()}catch(error){toast(error.message);action.disabled=false}}
});
$('#cart-dialog').addEventListener('click',e=>{if(e.target===$('#cart-dialog'))$('#cart-dialog').close()});
$('#account-tools').addEventListener('click',e=>{if(e.target.closest('[data-action="logout"]'))return});
document.addEventListener('submit',async e=>{
  const form=e.target.closest('[data-form]');if(!form)return;e.preventDefault();const submit=form.querySelector('button[type="submit"],button:not([type])');if(submit)submit.disabled=true;
  try{
    const values=Object.fromEntries(new FormData(form).entries());
    if(form.dataset.form==='login'||form.dataset.form==='signup'){
      const result=await api(`/api/${form.dataset.form}`,{method:'POST',body:json(values)});state.user=result.user;$('#auth-dialog').close();toast(form.dataset.form==='signup'?'Your account is ready.':'Welcome back.');await refresh();return;
    }
    if(form.dataset.form==='product'){
      values.price=Number(values.price);const result=await api('/api/products',{method:'POST',body:json(values)});toast(`${result.product.name} added to your menu.`);await refresh();return;
    }
  }catch(error){toast(error.message)}finally{if(submit)submit.disabled=false}
});
async function boot(){
  try{const session=await api('/api/session');state.user=session.user;if(state.user){await refresh()}else renderAuthWall()}
  catch(error){renderError(`${error.message} Start the server with “py server.py” from the FOODHUB folder.`)}
}
boot();
