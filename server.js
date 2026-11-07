import http from 'node:http';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {geocode,discoverStores,parseLine,searchVV,vvBasketLink} from './adapters.js';
import {optimize} from './optimizer.js';
import {buildServiceCatalog} from './store-registry.js';
import {configuredAdapters,callAdapter,initialProviderStatuses,coverageSummary} from './provider-connectors.js';
import {nativeAdapterIds,runNativeAdapter} from './native-adapters.js';
import {createBridge} from './bridge.js';
const dir=path.dirname(fileURLToPath(import.meta.url));
const html=fs.readFileSync(path.join(dir,'public/index.html'));
const PORT=Number(process.env.PORT||3000);
const cache=new Map();
const rate=new Map();
const bridgeRate=new Map();
const bridge=createBridge();
function send(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
async function body(req){
  let s='';for await(const chunk of req){s+=chunk.toString();if(s.length>85000)throw new Error('Запрос слишком большой');}
  return JSON.parse(s||'{}');
}
async function once(key,ttl,fn){
  const stored=cache.get(key);if(stored&&stored.expiry>Date.now())return stored.value;
  const value=await fn();cache.set(key,{value,expiry:Date.now()+ttl});if(cache.size>500)cache.delete(cache.keys().next().value);return value;
}
function allow(ip){const now=Date.now();const p=rate.get(ip)||{count:0,until:now+60000};if(now>p.until){p.count=0;p.until=now+60000;}p.count++;rate.set(ip,p);return p.count<=18;}
function allowBridge(ip){const t=Date.now();let p=bridgeRate.get(ip);if(!p||p.until<t)p={count:0,until:t+60000};p.count++;bridgeRate.set(ip,p);if(bridgeRate.size>5000)bridgeRate.clear();return p.count<=80;}
export async function searchCatalogs({list,address='',point=null,countryCode='ru',allowSubstitutions=true,localStores=[]},deps={}){
  const lines=String(list||'').split(/\r?\n/).map(parseLine).filter(Boolean).slice(0,12);
  if(!lines.length)throw new Error('Укажите хотя бы один товар');
  const adapters=deps.adapters||configuredAdapters();
  const builtins=deps.nativeAdapterIds||nativeAdapterIds;
  const connectedIds=[...new Set([...Object.keys(adapters),...(isRussianCountry(countryCode)?builtins:[])])];
  const catalog=buildServiceCatalog({countryCode,localStores,connectedIds:Object.keys(adapters),nativeIds:builtins});
  const providerStatuses=initialProviderStatuses(catalog,connectedIds);
  const statusMap=new Map(providerStatuses.map(s=>[s.id,s]));
  const results=lines.map(item=>({...item,offers:[]}));
  const errors=[];
  const checkedStores=[];
  const catalogStores=[];
  const isRussian=isRussianCountry(countryCode);
  // VkusVill public MCP provides real catalog products, but not verified address checkout pricing.
  if(isRussian && !adapters.vkusvill){
    const status=statusMap.get('vkusvill');
    if(status){
      let succeeded=0;
      const vvSearch=deps.searchVV||searchVV;
      for(let i=0;i<results.length;i+=3){
        await Promise.all(results.slice(i,i+3).map(async item=>{
          try{
            item.offers=await once('vv:'+item.query+':'+allowSubstitutions,1000*60*5,()=>vvSearch(item,allowSubstitutions));
            succeeded++;
          }catch(e){errors.push({storeId:'vkusvill',query:item.query,message:e.message});}
        }));
      }
      status.offersCount=results.reduce((n,i)=>n+i.offers.length,0);
      status.status=succeeded?'catalog-only':'error';
      status.verifiedDelivery=false;
    }
  }
  const nativeCall=deps.runNativeAdapter||runNativeAdapter;
  const nativeTasks=catalog.all.filter(s=>isRussian && builtins.includes(s.id) && !adapters[s.id]).map(async store=>{
    const state=statusMap.get(store.id);
    try{
      const out=await once('native:'+store.id+':'+point?.lat+':'+point?.lon+':'+lines.map(x=>x.query).join('|'),
        1000*60*4,()=>nativeCall(store.id,{items:lines,point,address,allowSubstitutions}));
      catalogStores.push(...(out.stores||[]));
      for(const o of out.offers||[]){
        const item=results.find(i=>i.id===o.requestedId);
        if(item)item.offers.push(o);
      }
      state.offersCount=(out.offers||[]).length;
      state.status=out.status||'no-quote';
      state.verifiedDelivery=false;
      state.checkedAt=out.checkedAt;
      state.source=out.transport||'native';
      state.note=out.note||'';
      if(out.errors?.length){
        state.error=out.errors[0].message;
        errors.push({storeId:store.id,message:out.errors[0].message,failedQueries:out.errors.length});
      }
    }catch(e){state.status='error';state.error=e.message;errors.push({storeId:store.id,message:e.message});}
  });
  const adapterCall=deps.callAdapter||callAdapter;
  const tasks=catalog.all.filter(s=>adapters[s.id]).map(async store=>{
    const state=statusMap.get(store.id);
    try{
      const out=await adapterCall(store.id,adapters[store.id],{address,point,items:lines,allowSubstitutions});
      checkedStores.push(...out.stores);
      for(const o of out.offers){const item=results.find(i=>i.id===o.requestedId);if(item)item.offers.push(o);}
      state.offersCount=out.offers.length;
      state.verifiedDelivery=out.availability==='verified';
      state.status=out.availability==='unavailable'?'unavailable':out.availability==='verified'?'address-priced':'no-quote';
      state.checkedAt=out.checkedAt;
    }catch(e){state.status='error';state.error=e.message;errors.push({storeId:store.id,message:e.message});}
  });
  await Promise.all([...nativeTasks,...tasks]);
  return {items:results,providers:providerStatuses,quotes:checkedStores,catalogStores,coverage:coverageSummary(providerStatuses),errors,
    source:'ВкусВилл MCP + публичные read-only каталоги + подключённые адаптеры',deliveryChecked:checkedStores.length>0,
    note:'Публичный каталог не подтверждает наличие и цену доставки. Без проверки всех обязательных сервисов рейтинг является предварительным.'};
}
function isRussianCountry(code){return String(code).toLowerCase()==='ru'}
async function handle(req,res){
  const pathname=new URL(req.url||'/',`http://localhost:${PORT}`).pathname;
  if(req.method==='GET'&&pathname==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=60'});res.end(html);return;
  }
  if(req.method==='GET'&&pathname==='/health')return send(res,200,{ok:true,version:'0.4.0'});
  if(pathname.startsWith('/api/bridge/')) {
    // A temporary secret shared only by the website and extension authorizes the room.
    // CORS is required for chrome-extension:// origins; no browser cookies are used.
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    res.setHeader('Cache-Control','no-store');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method!=='POST')return send(res,405,{error:'Только POST'});
    if(!allowBridge(req.socket.remoteAddress||'unknown'))return send(res,429,{error:'Слишком много запросов'});
    const data=await body(req);
    const actions={
      '/api/bridge/open':bridge.open,
      '/api/bridge/connect':bridge.connect,
      '/api/bridge/queue':bridge.enqueue,
      '/api/bridge/pull':bridge.pull,
      '/api/bridge/complete':bridge.complete,
      '/api/bridge/status':bridge.status,
      '/api/bridge/close':bridge.close
    };
    const fn=actions[pathname];
    return fn?send(res,200,fn(data)):send(res,404,{error:'Не найдено'});
  }
  if(req.method!=='POST')return send(res,404,{error:'Не найдено'});
  const ip=req.socket.remoteAddress||'unknown';if(!allow(ip))return send(res,429,{error:'Слишком много запросов; повторите через минуту'});
  const data=await body(req);
  if(pathname==='/api/discover'){
    const address=String(data.address||'').trim();
    const point=await once('geo:'+address,1000*60*60,()=>geocode(address));
    let localStores=[],warnings=[],discoveryComplete=true;
    try{localStores=await once('shops:'+point.lat+':'+point.lon,1000*60*30,()=>discoverStores(point));}
    catch(e){discoveryComplete=false;warnings.push('Не удалось проверить расположение соседних магазинов: '+e.message);}
    const catalog=buildServiceCatalog({countryCode:point.countryCode,localStores,connectedIds:Object.keys(configuredAdapters()),nativeIds:nativeAdapterIds});
    return send(res,200,{point,localStores,catalogProviders:catalog.all,requiredProviders:catalog.required,
      additionalProviders:catalog.additional,requiredIds:catalog.requiredIds,warnings,discoveryComplete,deliveryVerified:false,
      note:'Все шесть обязательных сервисов включены независимо от наличия соседнего магазина; адресная доставка пока не подтверждена.'});
  }
  if(pathname==='/api/search'){
    const address=String(data.address||'').trim().slice(0,250);
    const countryCode=String(data.countryCode||'ru').toLowerCase();
    const localStores=Array.isArray(data.localStores)?data.localStores.slice(0,80):[];
    const output=await searchCatalogs({list:data.list,address,point:data.point,countryCode,
      allowSubstitutions:data.allowSubstitutions!==false,localStores});
    return send(res,200,output);
  }
  if(pathname==='/api/optimize'){
    if(!Array.isArray(data.items)||!Array.isArray(data.stores))return send(res,400,{error:'Требуются items и stores'});
    if(data.items.length>18||data.stores.length>60)return send(res,400,{error:'Превышен размер MVP-корзины'});
    const result=optimize(data.items,data.stores,{maxDeliveries:2,minSplitSavingsKopecks:30000,allowSubstitutions:data.allowSubstitutions!==false});
    const coverage=Array.isArray(data.providers)?coverageSummary(data.providers):null;
    return send(res,200,{...result,coverage,
      globalBestVerified:coverage?.completeMarketComparison===true && result.status==='OK' &&
        data.stores.filter(s=>s.deliveryKopecks!==null).every(s=>s.quoteVerified===true),
      scopeNote:'Оптимизируется только набор предложений, переданный в запросе; без проверки всех сервисов экономия предварительна.'});
  }
  if(pathname==='/api/cart/vkusvill')return send(res,200,{link:await vvBasketLink(Array.isArray(data.items)?data.items:[])});
  send(res,404,{error:'Не найдено'});
}
export function createServer(){return http.createServer((req,res)=>handle(req,res).catch(e=>send(res,e.status||400,{error:e.message||'Неизвестная ошибка'})));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))createServer().listen(PORT,'0.0.0.0',()=>console.log(`GroceryBot MVP http://0.0.0.0:${PORT}`));
