/**
 * Optional live price adapters. Backend-to-backend contracts only; no secret exposed to browser.
 * Configured server-side as GROCERYBOT_ADAPTERS_JSON:
 * {"magnit":{"url":"https://your-server/...","tokenEnv":"MAGNIT_ADAPTER_TOKEN"}, ...}
 * Providers must explicitly report addressAvailable:true and verifiedDelivery:true to be
 * eligible for final total-cost comparison. Missing or unverified quotes remain unpriced.
 */
import {getStore,REQUIRED_RU} from './store-registry.js';
export function configuredAdapters(env=process.env){
  let raw;
  try{raw=JSON.parse(env.GROCERYBOT_ADAPTERS_JSON||'{}')}
  catch{throw new Error('GROCERYBOT_ADAPTERS_JSON: invalid JSON')}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('GROCERYBOT_ADAPTERS_JSON: expected object');
  const result={};
  for(const [id,config] of Object.entries(raw)){
    if(!config||typeof config.url!=='string')continue;
    const url=new URL(config.url);
    const safe=url.protocol==='https:' || (env.NODE_ENV!=='production' && url.protocol==='http:' && ['127.0.0.1','localhost','::1'].includes(url.hostname));
    if(!safe||url.username||url.password)throw new Error(`Недопустимый URL для адаптера ${id}`);
    result[id]={url:url.toString(),token:config.tokenEnv?env[config.tokenEnv]||'':null};
  }
  return result;
}
const integer=(n)=>Number.isSafeInteger(n)&&n>=0;
function safeLink(raw){return typeof raw==='string'&&/^https:\/\//i.test(raw)?raw:null}
function matchesStore(offerStoreId,providerId){
  return offerStoreId===providerId ||
    ((providerId==='kuper'||providerId==='yandex_eda') && offerStoreId?.startsWith(providerId+':'));
}
export function normalizeAdapterResult(providerId,raw,items){
  if(!raw||typeof raw!=='object')throw new Error('Адаптер вернул неправильный ответ');
  const itemIds=new Set(items.map(x=>x.id));
  const stores=[];
  for(const s of raw.stores||[]){
    if(!matchesStore(s.storeId,providerId))continue;
    if(s.addressAvailable!==true||s.verifiedDelivery!==true||!integer(s.deliveryKopecks))continue;
    stores.push({id:s.storeId,name:String(s.name||getStore(providerId)?.name||providerId).slice(0,120),
      deliveryKopecks:s.deliveryKopecks,feesKopecks:integer(s.feesKopecks)?s.feesKopecks:0,
      minOrderKopecks:integer(s.minOrderKopecks)?s.minOrderKopecks:0,
      freeDeliveryFromKopecks:integer(s.freeDeliveryFromKopecks)?s.freeDeliveryFromKopecks:null,
      addressVerified:true,quoteVerified:true,source:'adapter:'+providerId});
  }
  const eligibleStoreIds=new Set(stores.map(s=>s.id));
  const offers=[];
  for(const o of raw.offers||[]){
    if(!itemIds.has(o.requestedId)||!eligibleStoreIds.has(o.storeId)||!integer(o.priceKopecks)||o.priceKopecks===0)continue;
    if(!o.sku||!o.name||!integer(o.packages)||o.packages===0)continue;
    const matchScore=Number(o.matchScore);
    if(!Number.isFinite(matchScore)||matchScore<0||matchScore>1)continue;
    offers.push({storeId:o.storeId,requestedId:o.requestedId,sku:String(o.sku),name:String(o.name).slice(0,250),
      priceKopecks:o.priceKopecks,packages:o.packages,matchScore,exactMatch:o.exactMatch===true,
      url:safeLink(o.url),source:'adapter:'+providerId,verifiedForAddress:true,
      unitWarning:o.unitWarning===true});
  }
  const availability = raw.addressChecked===true && raw.available===false ? 'unavailable' : stores.length?'verified':'no-quote';
  return {stores,offers,availability,checkedAt:typeof raw.checkedAt==='string'?raw.checkedAt:new Date().toISOString()};
}
export async function callAdapter(providerId, config, {address,point,items,allowSubstitutions}, fetchFn=fetch){
  const headers={'Content-Type':'application/json','Accept':'application/json'};
  if(config.token)headers.Authorization=`Bearer ${config.token}`;
  const response=await fetchFn(config.url,{method:'POST',headers,
    signal:AbortSignal.timeout(25000),body:JSON.stringify({providerId,address,point,items,allowSubstitutions})});
  if(!response.ok)throw new Error(`${providerId}: HTTP ${response.status}`);
  const data=await response.json();
  return normalizeAdapterResult(providerId,data,items);
}
export function initialProviderStatuses(catalog,connectedIds=[]){
  const connected=new Set(connectedIds);
  return catalog.all.map(s=>({id:s.id,name:s.name,required:s.required,status:connected.has(s.id)?'waiting':s.id==='vkusvill'?'waiting':'not-connected',
    verifiedDelivery:false,offersCount:0,kind:s.kind,site:s.site,nearbyMappedStores:s.nearbyMappedStores}));
}
export function coverageSummary(statuses){
  const required=statuses.filter(x=>x.required);
  return {requiredTotal:required.length,requiredWithLiveOffers:required.filter(x=>x.offersCount>0 && x.verifiedDelivery).length,
    requiredCatalogOnly:required.filter(x=>x.status==='catalog-only').length,
    missingRequired:required.filter(x=>!x.verifiedDelivery||!x.offersCount).map(x=>x.name),
    missingAdditional:statuses.filter(x=>!x.required && !['address-priced','unavailable'].includes(x.status)).map(x=>x.name),
    allMandatoryChecked:required.every(x=>['address-priced','unavailable'].includes(x.status)),
    completeMarketComparison:required.length>0 && statuses.every(x=>['address-priced','unavailable'].includes(x.status))};
}
