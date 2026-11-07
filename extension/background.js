import {normalizedOffers} from './offer-matching.js';

const BASE='https://grocerybot-web-production.up.railway.app';
const HOMES={
  magnit:'https://magnit.ru/', '5ka':'https://5ka.ru/',
  perekrestok:'https://www.perekrestok.ru/', vkusvill:'https://vkusvill.ru/',
  kuper:'https://kuper.ru/', yandex_eda:'https://eda.yandex.ru/'
};
const HOSTS={
  magnit:['magnit.ru'], '5ka':['5ka.ru'],perekrestok:['perekrestok.ru'],
  vkusvill:['vkusvill.ru'],kuper:['kuper.ru'],yandex_eda:['eda.yandex.ru']
};
let running=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function siteOf(url){
  try {const hostname=new URL(url).hostname;
    return Object.keys(HOSTS).find(id=>HOSTS[id].some(h=>hostname===h||hostname.endsWith('.'+h)))||null;
  } catch {return null;}
}
async function rpc(path,data) {
  const response=await fetch(BASE+'/api/bridge/'+path,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(data),signal:AbortSignal.timeout(20000)});
  const parsed=await response.json();
  if(!response.ok)throw new Error(parsed.error||`HTTP ${response.status}`);
  return parsed;
}
async function setStatus(status){await chrome.storage.local.set({lastStatus:status,lastRun:Date.now()});}
async function getKey(){return (await chrome.storage.local.get('pairKey')).pairKey||null;}

async function waitForTab(tabId,ms=18000) {
  const tab=await chrome.tabs.get(tabId).catch(()=>null);
  if(!tab)throw new Error('Вкладка закрыта');
  if(tab.status==='complete')return;
  await new Promise(resolve=>{
    const timer=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(listener);resolve();},ms);
    function listener(id,change){if(id===tabId && change.status==='complete'){
      clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);resolve();}}
    chrome.tabs.onUpdated.addListener(listener);
  });
}
async function searchDOM(tabId,query){
  const [result]=await chrome.scripting.executeScript({target:{tabId},func:(term)=>{
    const fields=[...document.querySelectorAll('input')].filter(e=>{
      const label=(e.placeholder+' '+e.getAttribute('aria-label')+' '+e.getAttribute('type')).toLowerCase();
      return e.getClientRects().length && !e.disabled && (e.type==='search'||/поиск|искать|найти|search|товар|продукт/.test(label));
    });
    const input=fields[0];
    if(!input)return {submitted:false,reason:'Не найдено поле поиска. Откройте поиск магазина вручную и нажмите «Считать текущую вкладку».'};
    input.focus();input.click();
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    if(setter)setter.call(input,term);else input.value=term;
    input.dispatchEvent(new InputEvent('input',{bubbles:true,data:term,inputType:'insertText'}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
    if(input.form){try{input.form.requestSubmit();}catch{}}
    return {submitted:true};
  },args:[query]});
  return result?.result||{submitted:false,reason:'Скрипт поиска не завершился'};
}

/** Injected function: strictly reads DOM of the current site. No cookies, no localStorage, no arbitrary requests. */
function extractVisibleCards() {
  const bodyText=(document.body?.innerText||'').slice(0,4500).toLowerCase();
  if(/captcha|подтвердите, что вы не робот|доступ ограничен|access denied|forbidden|проверка браузера/.test(bodyText))
    return {cards:[],blocked:true,reason:'Магазин требует проверку в браузере'};
  const selectors=[
    '[itemtype*="schema.org/Product"]','[itemtype*="/Product"]','[data-testid*="product-card"]',
    '[data-qa*="product-card"]','[class*="ProductCard"]','[class*="product-card"]',
    'article:has(a[href])','li:has(a[href*="product"])',
    'a[href*="/product/"]','a[href*="/goods/"]','a[href*="/catalog/"]'
  ];
  const nodes=[...new Set(selectors.flatMap(selector=>{
    try{return [...document.querySelectorAll(selector)].slice(0,120);}catch{return [];}
  }))].slice(0,180);
  const cards=[];const fingerprints=new Set();
  for(const node of nodes){
    const card=node.matches('a')?(node.closest('article,li,[class*="Card"],[class*="card"]')||node):node;
    const text=(card.innerText||'').replace(/\s+/g,' ').trim().slice(0,1200);
    if(text.length<6||text.length>650||!/[₽]|руб/.test(text))continue;
    const prices=[...text.matchAll(/(\d{1,5}(?:[ \u00a0]\d{3})*(?:[,.]\d{1,2})?)\s*(?:₽|руб(?:лей|\.)?)/gi)]
      .map(x=>Number(x[1].replace(/[ \u00a0]/g,'').replace(',','.'))).filter(x=>x>0&&x<100000);
    if(!prices.length)continue;
    // Seek the price from a dedicated visible element if present; otherwise first listed price.
    const priceEl=card.querySelector('[data-testid*="price"], [class*="currentPrice"], [class*="CurrentPrice"], [itemprop="price"]');
    const priceText=priceEl?.getAttribute('content')||priceEl?.innerText||'';
    const specific=priceText.match(/\d+(?:[ \u00a0]\d{3})*(?:[,.]\d{1,2})?/);
    const price=(specific?Number(specific[0].replace(/[ \u00a0]/g,'').replace(',','.')):prices[0]);
    if(!Number.isFinite(price)||price<=0)continue;
    const link=card.matches('a')?card:card.querySelector('a[href*="/product/"],a[href*="/goods/"],a[href*="/catalog/"],a[href]');
    const titleEl=card.querySelector('[itemprop="name"], [data-testid*="name"], [class*="ProductName"], [class*="product-title"], h2, h3, h4');
    let name=(titleEl?.innerText || link?.innerText || text.split(/\d{1,5}(?:[,.]\d+)?\s*₽/)[0]).replace(/\s+/g,' ').trim();
    if(name.length>180)name=name.slice(0,180);
    if(name.length<3)continue;
    let url=null;
    try {url=link?new URL(link.href,document.location.href).href:null;}catch{}
    if(!url)url=document.location.href;
    const fingerprint=name.toLowerCase()+'|'+price;
    if(fingerprints.has(fingerprint))continue;
    fingerprints.add(fingerprint);
    cards.push({name,priceKopecks:Math.round(price*100),url});
    if(cards.length>=40)break;
  }
  return {cards,blocked:false,pageTitle:document.title};
}
async function capture(tabId,query) {
  await sleep(2200);
  const [result]=await chrome.scripting.executeScript({target:{tabId},func:extractVisibleCards});
  return result?.result||{cards:[],reason:'Не удалось прочитать результаты магазина'};
}
async function runJob(job){
  if(!Object.hasOwn(HOMES,job.providerId))return {status:'error',offers:[],error:'Сервис не поддерживается расширением'};
  const tab=await chrome.tabs.create({url:HOMES[job.providerId],active:false});
  const offers=[];let needsUser=false;let reason='';
  try {
    await waitForTab(tab.id);
    for(const item of job.items){
      const search=await searchDOM(tab.id,item.query);
      if(!search.submitted){needsUser=true;reason=search.reason;break;}
      const view=await capture(tab.id,item.query);
      if(view.blocked){needsUser=true;reason=view.reason;break;}
      const matched=normalizedOffers({providerId:job.providerId,item,cards:view.cards});
      if(!matched.length){needsUser=true;reason=`Не удалось извлечь цены по «${item.query}»; сайт можно проверить вручную.`;continue;}
      offers.push(...matched);
    }
  }catch(e){needsUser=true;reason=e.message||'Сайт не разрешает чтение страницы';}
  finally {await chrome.tabs.remove(tab.id).catch(()=>{});}
  return {status:needsUser?'needs-user':'done',offers,error:needsUser?reason:null};
}
export async function pollNow(){
  if(running)return {busy:true};
  const key=await getKey();if(!key)return {connected:false};
  running=true;
  try {
    await rpc('connect',{key});
    const {job}=await rpc('pull',{key});
    if(!job){await setStatus('Связь работает, заданий пока нет');return {connected:true,job:null};}
    await setStatus(`Ищем цены: ${job.providerId}`);
    const found=await runJob(job);
    const saved=await rpc('complete',{key,jobId:job.id,providerId:job.providerId,...found});
    await setStatus(`${job.providerId}: передано ${saved.offers||0} цен. ${found.error||''}`);
    return {connected:true,job:job.providerId,status:found.status,offers:saved.offers};
  }catch(e){await setStatus(`Ошибка подключения: ${e.message}`);return {error:e.message};}
  finally {running=false;}
}

async function manualCapture(query){
  const key=await getKey();if(!key)throw new Error('Сначала подключите расширение к GroceryBot');
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const providerId=siteOf(tab?.url);
  if(!providerId)throw new Error('Откройте вкладку поддерживаемого магазина');
  const state=await rpc('status',{key});
  const job=state.jobs.find(j=>j.providerId===providerId && ['needs-user','running','pending','error'].includes(j.status));
  if(!job)throw new Error('На сайте GroceryBot запустите поиск через Chrome для этого магазина');
  const chosen=job.items?.find(i=>i.query.toLowerCase()===query.toLowerCase())||job.items?.[0];
  // The job includes product IDs/queries, never site credentials.
  if(!query.trim())throw new Error('Введите название товара, результаты которого видны на странице');
  const view=await capture(tab.id,query);
  if(view.blocked)throw new Error(view.reason);
  const item={id:chosen?.id||'i0',query};
  const offers=normalizedOffers({providerId,item,cards:view.cards});
  if(!offers.length)throw new Error('Цены не распознаны — откройте список товаров или страницу поиска');
  await rpc('complete',{key,jobId:job.id,providerId,status:'done',offers});
  await setStatus(`Вручную считано ${offers.length} предложений: ${providerId}`);
  return {offers:offers.length,providerId};
}

chrome.runtime.onInstalled.addListener(()=>chrome.alarms.create('grocerybot-poll',{periodInMinutes:.5}));
chrome.runtime.onStartup.addListener(()=>chrome.alarms.create('grocerybot-poll',{periodInMinutes:.5}));
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='grocerybot-poll')void pollNow()});
chrome.runtime.onMessage.addListener((msg,_sender,respond)=>{
  if(!['CONNECT','DISCONNECT','POLL','STATUS','MANUAL_CAPTURE'].includes(msg.type))return false;
  (async()=>{
    if(msg.type==='CONNECT'){
      if(!/^[a-f0-9]{48,64}$/.test(msg.key))throw new Error('Скопируйте код из сайта GroceryBot целиком');
      await rpc('connect',{key:msg.key});
      await chrome.storage.local.set({pairKey:msg.key});
      await chrome.alarms.create('grocerybot-poll',{periodInMinutes:.5});
      return {connected:true};
    }
    if(msg.type==='DISCONNECT'){
      const key=await getKey();await chrome.storage.local.remove('pairKey');
      if(key)await rpc('close',{key}).catch(()=>{});
      return {connected:false};
    }
    if(msg.type==='POLL')return await pollNow();
    if(msg.type==='MANUAL_CAPTURE')return await manualCapture(String(msg.query||''));
    const key=await getKey();const stored=await chrome.storage.local.get(['lastStatus','lastRun']);
    return {connected:!!key,lastStatus:stored.lastStatus||'Нет заданий',lastRun:stored.lastRun||0};
  })().then(respond,e=>respond({error:e.message||String(e)}));
  return true;
});
