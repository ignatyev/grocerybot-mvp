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
// Inject a packaged DOM helper into the isolated extension world. Does not read cookies or site storage.
async function pageAction(tabId,action,...args){
  await chrome.scripting.executeScript({target:{tabId},files:['page-agent.js']});
  const [result]=await chrome.scripting.executeScript({target:{tabId},
    func:(name,parameters)=>globalThis.__groceryDomAgent?.[name]?.(...parameters),args:[action,args]});
  return result?.result||null;
}
async function capture(tabId){
  const result=await pageAction(tabId,'scan');
  return result||{cards:[],reason:'Страница не разрешает чтение результатов'};
}
function fingerprint(view){
  return (view?.cards||[]).slice(0,15).map(x=>x.name+'|'+x.priceKopecks).join('\n');
}
const VV_SEARCH='https://vkusvill.ru/search/?q='; // Confirmed public search route.
// Verified public category pages. They are category fallbacks, not general search URLs.
const CATEGORY_FALLBACKS={
  magnit:{moloko:'https://magnit.ru/catalog/117673-molochnyy_prilavok_2'},
  '5ka':{moloko:'https://5ka.ru/catalog/moloko--251C51947/'},
  perekrestok:{moloko:'https://www.perekrestok.ru/cat/c/114/moloko'}
};
function categoryFallback(providerId,query){
  const q=query.toLowerCase().trim().replace(/ё/g,'е');
  const category=/^молок(?:о|а|у|ом)?(?:\s|$)/.test(q)?'moloko':null;
  return category?CATEGORY_FALLBACKS[providerId]?.[category]||null:null;
}
const MAX_SCAN_WAIT=10500;
async function searchOne(tabId,providerId,query){
  if(providerId==='vkusvill'){
    await chrome.tabs.update(tabId,{url:VV_SEARCH+encodeURIComponent(query)});
    await waitForTab(tabId);
    await sleep(850);
    const view=await capture(tabId);
    return {view,confirmed:!view.blocked && view.cards.length>0,
      reason:view.cards.length?'':'Поиск ВкусВилла не вернул видимых карточек (проверьте вход и адрес)'};
  }
  const categoryUrl=categoryFallback(providerId,query);
  if(categoryUrl){
    await chrome.tabs.update(tabId,{url:categoryUrl});
    await waitForTab(tabId);
    await sleep(850);
    const candidate=await capture(tabId);
    if(candidate.cards?.length) return {view:candidate,confirmed:!candidate.blocked,
      reason:candidate.blocked?candidate.reason:'Каталог категории (не проверенный поиск по произвольному названию)'};
    // If the category is empty or unavailable, try the site's own search UI.
  }
  const before=await capture(tabId);
  if(before.blocked)return {view:before,confirmed:false,reason:before.reason};
  const result=await pageAction(tabId,'search',query);
  if(!result?.submitted)return {view:before,confirmed:false,reason:result?.reason||'Не найдено поле поиска'};
  const started=Date.now();let view=before;let confirmed=false;
  while(Date.now()-started<MAX_SCAN_WAIT){
    await sleep(850);
    try {view=await capture(tabId);}catch(e){
      // React/SPA navigation can unload the frame between search and capture.
      await waitForTab(tabId,3000);continue;
    }
    if(view.blocked)return {view,confirmed:false,reason:view.reason};
    const oldUrl=before.location||result.url;
    const newUrl=view.location||'';
    const changed=fingerprint(view)!==fingerprint(before);
    const onSearchPage=oldUrl!==newUrl || /(?:search|поиск|найдено|результат)/i.test(view.pageTitle||'');
    confirmed=view.cards.length>0 && (changed||onSearchPage);
    if(confirmed)break;
  }
  return {view,confirmed,reason:confirmed?'':
    `Поиск «${query}» не подтвердился: список товаров не обновился. Найдите товар на сайте и считайте открытую вкладку.`};
}
async function providerTab(providerId){
  const open=await chrome.tabs.query({});
  const candidate=open.find(t=>t.url && siteOf(t.url)===providerId && /https:\/\//.test(t.url));
  return chrome.tabs.create({url:candidate?.url||HOMES[providerId],active:false});
}
async function runJob(job){
  if(!Object.hasOwn(HOMES,job.providerId))return {status:'error',offers:[],error:'Сервис не поддерживается расширением'};
  const tab=await providerTab(job.providerId);
  const offers=[];const errors=[];
  try {
    await waitForTab(tab.id);
    for(const item of job.items){
      const {view,confirmed,reason}=await searchOne(tab.id,job.providerId,item.query);
      if(view?.blocked){errors.push(reason||view.reason);break;}
      if(!confirmed){errors.push(reason);continue;}
      const matched=normalizedOffers({providerId:job.providerId,item,cards:view.cards});
      if(!matched.length){errors.push(`Цены по «${item.query}» не распознаны — откройте результаты поиска вручную.`);continue;}
      offers.push(...matched);
    }
  }catch(e){errors.push(e.message||'Не удалось прочитать страницу');}
  finally {await chrome.tabs.remove(tab.id).catch(()=>{});}
  return {status:errors.length?'needs-user':'done',offers,error:errors.slice(0,3).join('; ').slice(0,240)||null};
}
export async function pollNow(){
  if(running)return {busy:true};
  const key=await getKey();if(!key)return {connected:false};
  running=true;
  let completed=0,offerCount=0,errors=[];
  try {
    await rpc('connect',{key});
    // Drain queued shops immediately instead of processing just one every 30 seconds.
    for(let n=0;n<6;n++){
      const {job}=await rpc('pull',{key});
      if(!job)break;
      await setStatus(`Поиск ${n+1}/6: ${job.providerId}`);
      const found=await runJob(job);
      const saved=await rpc('complete',{key,jobId:job.id,providerId:job.providerId,...found});
      completed++;offerCount+=(saved.offers||0);
      if(found.error)errors.push(`${job.providerId}: ${found.error}`);
      await setStatus(`${job.providerId}: ${saved.offers||0} предложений${found.error?'; '+found.error:''}`);
    }
    if(!completed){await setStatus('Связь работает, новых заданий нет');return {connected:true,job:null};}
    await setStatus(`Проверено ${completed} магазинов, ${offerCount} предложений. ${errors.slice(0,2).join(' | ')}`.slice(0,340));
    return {connected:true,job:`${completed} магазинов`,status:errors.length?'needs-user':'done',offers:offerCount};
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
  const view=await capture(tab.id);
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
