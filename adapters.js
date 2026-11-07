/** External public sources. No credentials and no fabricated shipping or stock data. */
const VV = 'https://mcp.vkusvill.ru/mcp';
const GEO = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const ua = process.env.GROCERYBOT_USER_AGENT || 'GroceryBotMVP/0.1 (experimental personal project; OpenStreetMap geocoding)';
const timeout = (ms) => AbortSignal.timeout(ms);
// Nominatim public API policy: cap this process to about one lookup per second.
let geocodeGate = Promise.resolve();
let lastGeocodeAt = 0;
async function pacedGeocode(fn) {
  const next = geocodeGate.then(async () => {
    const remaining = 1100 - (Date.now() - lastGeocodeAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    lastGeocodeAt = Date.now();
    return fn();
  });
  geocodeGate = next.then(() => undefined, () => undefined);
  return next;
}

async function jsonFetch(url, opts={}) {
  const response = await fetch(url,{...opts,signal:timeout(18000),headers:{'User-Agent':ua,...opts.headers}});
  if(!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  return response.json();
}
export async function geocode(address) {
  if (!address || address.length>250) throw new Error('Адрес должен содержать от 1 до 250 символов');
  const url = GEO + '?' + new URLSearchParams({q:address,format:'jsonv2',addressdetails:'1',limit:'1'});
  const results = await pacedGeocode(() => jsonFetch(url,{headers:{'Accept-Language':'ru'}}));
  if(!results.length) throw new Error('Адрес не найден. Уточните город, улицу и дом.');
  const v=results[0];
  return {lat:+v.lat,lon:+v.lon,label:v.display_name,countryCode:v.address?.country_code||'',city:v.address?.city||v.address?.town||v.address?.state||''};
}
export async function discoverStores(point) {
  const query=`[out:json][timeout:15];(nwr["shop"~"^(supermarket|grocery|convenience)$"](around:5000,${point.lat},${point.lon}););out center 100;`;
  const data=await jsonFetch(OVERPASS,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({data:query}).toString()});
  const uniq=new Map();
  for (const element of data.elements || []) {
    const name=(element.tags?.name||element.tags?.brand||'').trim();
    if(!name) continue;
    const key=name.toLocaleLowerCase('ru');
    if(!uniq.has(key)) uniq.set(key,{name,address:[element.tags?.['addr:street'],element.tags?.['addr:housenumber']].filter(Boolean).join(', '),website:element.tags?.website||null});
  }
  return [...uniq.values()].slice(0,40);
}

function unwrapRpc(rawText) {
  let body;
  if(rawText.trimStart().startsWith('data:') || rawText.includes('\ndata:')) {
    const lines=rawText.split(/\r?\n/).filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).filter(x=>x!=='[DONE]');
    if(!lines.length) throw new Error('Пустой SSE-ответ магазина');
    body=JSON.parse(lines.at(-1));
  } else body=JSON.parse(rawText);
  if(body.error) throw new Error('ВкусВилл: '+(body.error.message||'ошибка MCP'));
  let val=body.result||body;
  if(val.isError) throw new Error('ВкусВилл: запрос не выполнен');
  if(val.structuredContent) val=val.structuredContent;
  else if(Array.isArray(val.content)) {
    const blocks=val.content.filter(c=>c.type==='text').map(c=>c.text);
    if(!blocks.length) throw new Error('ВкусВилл: нет данных');
    const txt=blocks.join('\n');
    try {val=JSON.parse(txt);} catch { const m=txt.match(/\{[\s\S]*\}/); if(!m) throw new Error('ВкусВилл: неожиданный формат');val=JSON.parse(m[0]); }
  }
  if(val.ok===false) throw new Error('ВкусВилл: '+(val.error?.message||val.error||'ошибка поиска'));
  return val.data||val;
}
export async function vvCall(name,args) {
  const response=await fetch(VV,{method:'POST',signal:timeout(20000),headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream','User-Agent':ua},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  if(!response.ok) throw new Error('ВкусВилл MCP: HTTP '+response.status);
  return unwrapRpc(await response.text());
}
function number(v) {
  if(typeof v==='number')return v;
  if(typeof v==='string')return Number(v.replace(/\s|₽|руб\.?/g,'').replace(',','.'));
  return NaN;
}
function parseSize(s) {
  const match = String(s).toLowerCase().replace(/\s/g,' ').match(/(\d+(?:[,.]\d+)?)\s*(кг|г|мл|л|шт)(?=$|[\s,.)])/);
  if(!match)return null;
  const count = +match[1].replace(',','.');const unit=match[2];
  return unit==='кг'?{quantity:count*1000,unit:'г'}:unit==='л'?{quantity:count*1000,unit:'мл'}:{quantity:count,unit};
}
export function parseLine(raw, idx) {
  let text=String(raw).trim();
  if(!text) return null;
  text=text.replace(/^[-*•\d.)\s]+/,'').trim();
  const matching = text.match(/(?:^|[,\s])(?:x\s*)?(\d+(?:[,.]\d+)?)\s*(кг|г|мл|л|шт)(?=$|[\s,.)])/i);
  let needed=matching?{quantity:+matching[1].replace(',','.'),unit:matching[2].toLowerCase()}:null;
  if(needed?.unit==='кг')needed={quantity:needed.quantity*1000,unit:'г'};
  if(needed?.unit==='л')needed={quantity:needed.quantity*1000,unit:'мл'};
  const query=text.replace(/(?:^|[,\s])(?:x\s*)?\d+(?:[,.]\d+)?\s*(кг|г|мл|л|шт)(?=$|[\s,.)])/i,' ').replace(/\s+/g,' ').trim()||text;
  return {id:'i'+idx,raw:text,query,needed};
}
function stem(token) {
  const synonyms = { 'яйца':'яйцо','яиц':'яйцо','яйцо':'яйцо',
    'бананы':'банан','банана':'банан','банан':'банан',
    'яблоки':'яблоко','яблока':'яблоко','яблоко':'яблоко',
    'огурцы':'огурец','огурцов':'огурец','огурец':'огурец',
    'помидоры':'томат','помидор':'томат','томаты':'томат','томат':'томат',
    'сырники':'сырник','сырник':'сырник',
    'апельсины':'апельсин','апельсин':'апельсин',
    'картошка':'картофель','картофель':'картофель'};
  if(synonyms[token])return synonyms[token];
  if(token.length>5)return token.replace(/(ами|ями|ого|ему|ими|ые|ие|ая|яя|ых|их|ов|ев|ой|ой|ы|и|а|я)$/u,'');
  return token;
}
function scoreName(query,name) {
  const tokens=(query.toLowerCase().match(/[\p{L}\d]+/gu)||[]).map(stem);
  const title=(name.toLowerCase().match(/[\p{L}\d]+/gu)||[]).map(stem);
  if(!tokens.length)return 0;
  return tokens.filter(t=>title.some(v=>v===t||v.startsWith(t)&&t.length>=4||t.startsWith(v)&&v.length>=4)).length/tokens.length;
}

export function normalizeVV(item,products,allowSubstitutions=true) {
  return products.map((p,idx)=>{
    const name=String(p.name||p.title||'');
    const price=number(p.price?.current??p.price?.value??p.price?.price??p.price);
    const sku=String(p.xml_id||p.id||'');
    const score=scoreName(item.query,name);
    if(!name||!sku||!Number.isFinite(price)||price<=0||score<0.42)return null;
    if(!allowSubstitutions && score<0.999)return null;
    const pack=parseSize(name)||parseSize(p.weight+' '+p.unit);
    const req=item.needed;
    const compatible=req && pack && pack.unit===req.unit;
    let packages=compatible?Math.ceil(req.quantity/pack.quantity):1;
    if(!Number.isFinite(packages)||packages<1||packages>30)packages=1;
    return {storeId:'vkusvill',sku,name,url: typeof p.url==='string' && p.url.startsWith('https://vkusvill.ru/')?p.url:'https://vkusvill.ru/',
      priceKopecks:Math.round(price*100),packages,matchScore:score,exactMatch:score===1,
      requestedId:item.id,unitWarning:!!req&&!compatible,source:'ВкусВилл MCP',rating:p.rating?.average||null};
  }).filter(Boolean).sort((a,b)=> (b.matchScore-a.matchScore)|| (a.priceKopecks*a.packages-b.priceKopecks*b.packages)).slice(0,5);
}
export async function searchVV(item,allowSubstitutions=true) {
  const result=await vvCall('vkusvill_products_search',{q:item.query,mode:'full',limit:12,page:1,sort:'popularity',vvonly:0});
  const products=Array.isArray(result)?result:result.items||result.products||result.result?.items||[];
  if(!Array.isArray(products))throw new Error('ВкусВилл: нет массива товаров в ответе');
  return normalizeVV(item,products,allowSubstitutions);
}
export async function vvBasketLink(items) {
  if(!items.length || items.length>20)throw new Error('Ссылка поддерживает от 1 до 20 позиций');
  const products=items.map(x=>({xml_id:Number(x.sku),q:x.packages}));
  if(products.some(x=>!Number.isInteger(x.xml_id)||x.xml_id<=0))throw new Error('Некорректный ID товара');
  const result=await vvCall('vkusvill_cart_link_create',{products});
  const link=result.link||result.url||result.cart_url;
  if(typeof link!=='string'||!link.startsWith('https://vkusvill.ru/'))throw new Error('Магазин не вернул ссылку на корзину');
  return link;
}
