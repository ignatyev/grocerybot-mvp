/**
 * Read-only catalogue connectors. They query real merchant endpoints, never invent
 * prices, never claim that an address-specific checkout/delivery fee was verified.
 * All endpoints below are public web endpoints or reverse-engineered interfaces;
 * sites may require an interactive browser, deny access or change their schema.
 * No browser impersonation, CAPTCHA circumvention, login or checkout writes.
 */
import {normalizeVV} from './adapters.js';

const HOSTS = Object.freeze({
  magnit: 'https://magnit.ru',
  pyaterochka: 'https://5ka.ru',
  perekrestok: 'https://www.perekrestok.ru',
  kuper: 'https://kuper.ru',
  yandex_eda: 'https://eda.yandex.ru'
});
const UA = process.env.GROCERYBOT_USER_AGENT || 'GroceryBotMVP/0.3 (read-only product catalog comparison)';
const MAX_ITEMS = 8; // bound public-site request volume and latency

async function request(url, options={}, fetchFn=fetch) {
  const signal = AbortSignal.timeout(8500);
  const res = await fetchFn(url, {
    ...options, signal, redirect:'follow',
    headers: {'Accept':options.expectHtml?'text/html,application/xhtml+xml':'application/json',
      'User-Agent':UA, 'Accept-Language':'ru-RU,ru;q=0.9', ...options.headers}
  });
  if(!res.ok) {
    const err=new Error(`${new URL(url).host}: HTTP ${res.status}`);
    err.code=[401,403,429,451].includes(res.status)?'BROWSER_REQUIRED':'REMOTE_ERROR';
    throw err;
  }
  const type=res.headers?.get?.('content-type')||'';
  if(options.expectHtml) {
    const txt=await res.text(); if(txt.length>4_000_000) throw new Error('Слишком большой HTML-ответ');
    return txt;
  }
  if(type && !/json/i.test(type)) throw new Error('Сайт не отдал JSON (возможна защита от роботов или требуется вход)');
  const txt=await res.text();
  if(txt.length>1_000_000)throw new Error('Слишком большой ответ каталога');
  try{return JSON.parse(txt)}catch{throw new Error('Каталог вернул ответ, который не является JSON')}
}

const htmlEntity=s=>s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
function asPrice(p){
  const raw=p?.current??p?.value??p?.price??p?.amount??p;
  if(typeof raw==='number')return raw;
  if(typeof raw==='string')return Number(raw.replace(/[^\d.,]/g,'').replace(',','.'));
  return NaN;
}
function normalized(item, product, storeId, source, fallbackUrl){
  const p={...product,price:asPrice(product.price??product.priceData??product.sale_price)};
  const list=normalizeVV(item,[p]);
  return list.map(o=>({ ...o, storeId, source, url: typeof product.url==='string' && /^https:\/\//.test(product.url)?product.url:fallbackUrl,
    verifiedForAddress:false, catalogOnly:true }));
}
function report(provider, offers, errors=[],extra={}){
  const restricted=errors.some(e=>e.code==='BROWSER_REQUIRED'||/HTTP (?:401|403|429|451)/.test(e.message||''));
  return {provider,status:offers.length?'catalog-only':restricted?'browser-required':errors.length?'error':'no-quote',
    offers,errors,checkedAt:new Date().toISOString(),checkedDelivery:false,
    note:offers.length?'Публичные цены каталога, не тариф доставки по адресу.':undefined,...extra};
}
export function extractJsonLdProducts(html) {
  const result=[];
  const scripts=html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const walk=(value, depth=0)=>{
    if(depth>8 || value==null)return;
    if(Array.isArray(value)){for(const v of value.slice(0,150))walk(v,depth+1);return}
    if(typeof value!=='object')return;
    const type=String(value['@type']||'').toLowerCase();
    if(type==='product'||type==='listitem'&&value.item){
      const p=type==='listitem'?value.item:value;
      if(p.name){
        const offers=p.offers?.[0]||p.offers;
        result.push({id:p.sku||p.productID||p.gtin13||p.url||'',name:p.name,
          price:offers?.price??offers?.lowPrice??p.price,
          url:p.url||offers?.url,weight:p.weight});
      }
    }
    if(value['@graph'])walk(value['@graph'],depth+1);
    if(value.itemListElement)walk(value.itemListElement,depth+1);
    if(value.mainEntity)walk(value.mainEntity,depth+1);
  };
  for(const match of scripts){
    try{walk(JSON.parse(htmlEntity(match[1])))}catch{}
  }
  return result;
}
function directSearchURL(id,q){
  switch(id){
    case 'magnit':return HOSTS.magnit+'/search?term='+encodeURIComponent(q);
    case 'pyaterochka':return HOSTS.pyaterochka+'/search?query='+encodeURIComponent(q);
    case 'perekrestok':return HOSTS.perekrestok+'/search?query='+encodeURIComponent(q);
    default:throw new Error('Неизвестная торговая сеть');
  }
}
/** Best effort direct retailer HTML search. Scrapes structured public JSON-LD ONLY. */
export async function searchDirectRetailer(id, items, {fetchFn=fetch}={}){
  if(!['magnit','pyaterochka','perekrestok'].includes(id))throw new Error('Unsupported retailer');
  const errors=[];const offers=[];
  const selected=items.slice(0,MAX_ITEMS);
  for(const item of selected){
    try {
      const url=directSearchURL(id,item.query);
      const html=await request(url,{expectHtml:true},fetchFn);
      const candidates=extractJsonLdProducts(html).filter(p=>p.id&&Number.isFinite(asPrice(p.price))&&asPrice(p.price)>0);
      const best=candidates.flatMap(p=>normalized(item,p,id,`Каталог ${id} (JSON-LD)`,url));
      offers.push(...best.slice(0,4));
    }catch(e){
      errors.push({query:item.query,message:e.message,code:e.code});
      if(e.code==='BROWSER_REQUIRED')break; // do not hammer a protected endpoint
    }
  }
  return report(id,offers,errors,{transport:'public-html-jsonld'});
}

function retailerName(s){
  const raw=s.retailer?.name||s.retailer?.title||s.retailer_name||s.name||'Магазин';
  return String(raw).slice(0,100);
}
function safeStoreId(id){return /^\d{1,12}$/.test(String(id))?String(id):null}
export async function searchKuper(items,point,{fetchFn=fetch, maxStores=3}={}){
  if(!Number.isFinite(point?.lat)||!Number.isFinite(point?.lon))return report('kuper',[],[{message:'Неизвестны координаты доставки'}]);
  const errors=[];const offers=[];const seen=[];
  try {
    const storesUrl=HOSTS.kuper+'/api/v2/stores?'+new URLSearchParams({lat:String(point.lat),lon:String(point.lon),shipping_method:'delivery',page:'1',per_page:'24'});
    const response=await request(storesUrl,{},fetchFn);
    const stores=Array.isArray(response.stores)?response.stores:response.data?.stores;
    if(!Array.isArray(stores))throw new Error('Купер: список магазинов отсутствует в ответе');
    for(const s of stores){
      const id=safeStoreId(s.id);if(!id)continue;
      const name=retailerName(s);seen.push({id:`kuper:${id}`,name:`Купер · ${name}`,provider:'kuper',sourceUrl:HOSTS.kuper+'/'});
    }
    await Promise.all(seen.slice(0,Math.max(1,Math.min(maxStores,5))).map(async store=>{
      const sid=store.id.split(':')[1];
      const selected=items.slice(0,MAX_ITEMS);
      for(let start=0;start<selected.length;start+=3){
        const batch=selected.slice(start,start+3);
        const before=errors.length;
        await Promise.all(batch.map(async item=>{
          try {
            const url=HOSTS.kuper+'/api/v2/products?'+new URLSearchParams({sid,q:item.query,page:'1',per_page:'12',sort:'popularity'});
            const out=await request(url,{},fetchFn);
            const found=Array.isArray(out.products)?out.products:out.data?.products;
            if(!Array.isArray(found))throw new Error('Купер: ответ каталога без товаров');
            for(const p of found.slice(0,12)){
              if(p.price_type==='per_kilo'||p.stock?.available===false)continue;
              offers.push(...normalized(item,{id:p.id,name:p.name,price:p.price?.current??p.price?.amount??p.price,
                weight:p.human_volume||p.weight,unit:p.unit},store.id,store.name,HOSTS.kuper+'/')); 
            }
          }catch(e){errors.push({query:item.query,storeId:store.id,message:e.message});}
        }));
        if(errors.length>before)break; // do not hammer protected or unavailable endpoints
      }
    }));
  }catch(e){errors.push({message:e.message,code:e.code})}
  return report('kuper',offers,errors,{stores:seen,transport:'kuper-public-readonly'});
}

// Yandex Eda has NO official consumer API. The following is an optional read-only
// experiment based on its /retail listing and public site search; never used to
// impersonate direct store checkout or claim that a channel's delivery fee is known.
export function parseYandexPlaces(html){
  const decoded=html.replaceAll('\\u0026','&').replaceAll('&amp;','&').replaceAll('\\"','"');
  const urls=[];
  for(const match of decoded.matchAll(/placeSlug(?:=|%3D|["']?\s*:\s*["'])([a-zA-Z0-9_\-]{6,100})/gi)){
    const slug=match[1];if(!urls.includes(slug))urls.push(slug);
  }
  return urls.slice(0,50);
}
export async function searchYandexEda(items,point,{fetchFn=fetch,maxStores=4}={}){
  if(!Number.isFinite(point?.lat)||!Number.isFinite(point?.lon))return report('yandex_eda',[],[{message:'Неизвестны координаты доставки'}]);
  const errors=[];const offers=[];let found=[];
  try{
    const params=new URLSearchParams({longitude:String(point.lon),latitude:String(point.lat)});
    const html=await request(HOSTS.yandex_eda+'/retail?'+params,{expectHtml:true},fetchFn);
    const slugs=parseYandexPlaces(html);
    if(!slugs.length)throw new Error('Яндекс Еда: список магазинов не найден в публичной странице');
    found=slugs.map(slug=>({id:'yandex_eda:'+slug,name:'Яндекс Еда · '+slug.replaceAll('_',' ').slice(0,50),
      slug,url:HOSTS.yandex_eda+'/retail?placeSlug='+encodeURIComponent(slug)}));
    await Promise.all(found.slice(0,Math.max(1,Math.min(maxStores,8))).map(async store=>{
      const selected=items.slice(0,MAX_ITEMS);
      for(let start=0;start<selected.length;start+=3){
        const batch=selected.slice(start,start+3);
        const before=errors.length;
        await Promise.all(batch.map(async item=>{
          try{
            const url=HOSTS.yandex_eda+'/api/v1/menu/search?'+new URLSearchParams({placeSlug:store.slug,longitude:String(point.lon),latitude:String(point.lat)});
            const out=await request(url,{method:'POST',headers:{'Content-Type':'application/json','Origin':HOSTS.yandex_eda,'Referer':store.url},body:JSON.stringify({place_slug:store.slug,text:item.query})},fetchFn);
            const products=out.payload?.items||out.items||out.data?.items;
            if(!Array.isArray(products))throw new Error('Яндекс Еда: ответ поиска без списка товаров');
            for(const p of products.slice(0,12)){
              offers.push(...normalized(item,{id:p.id,name:p.name,price:p.price,weight:p.weight},store.id,store.name,store.url));
            }
          }catch(e){errors.push({storeId:store.id,query:item.query,message:e.message})}
        }));
        if(errors.length>before)break;
      }
    }));
  }catch(e){errors.push({message:e.message,code:e.code})}
  return report('yandex_eda',offers,errors,{stores:found,transport:'yandex-retail-readonly'});
}
export const nativeAdapterIds=Object.freeze(['magnit','pyaterochka','perekrestok','kuper','yandex_eda']);
export async function runNativeAdapter(id,{items,point},opts={}){
  if(id==='kuper')return searchKuper(items,point,opts);
  if(id==='yandex_eda')return searchYandexEda(items,point,opts);
  return searchDirectRetailer(id,items,opts);
}
