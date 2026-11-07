/** Russian delivery services that must never be silently omitted from comparison. */
export const REQUIRED_RU = Object.freeze([
  {id:'magnit',name:'Магнит',site:'https://dostavka.magnit.ru/',kind:'retailer',aliases:['магнит','магнит семейный','магнит экстра']},
  {id:'pyaterochka',name:'Пятёрочка',site:'https://5ka.ru/',kind:'retailer',aliases:['пятёрочка','пятерочка','5ка','5ka']},
  {id:'perekrestok',name:'Перекрёсток',site:'https://www.perekrestok.ru/',kind:'retailer',aliases:['перекрёсток','перекресток','перекресток экспресс']},
  {id:'vkusvill',name:'ВкусВилл',site:'https://vkusvill.ru/',kind:'retailer',aliases:['вкусвилл','вкус вилл']},
  {id:'kuper',name:'Купер',site:'https://kuper.ru/',kind:'aggregator',aliases:[]},
  {id:'yandex_eda',name:'Яндекс Еда',site:'https://eda.yandex.ru/',kind:'aggregator',aliases:[]}
]);
export const OTHER_CHAINS = Object.freeze([
  {id:'lenta',name:'Лента',site:'https://lenta.com/',aliases:['лента','супер лента']},
  {id:'auchan',name:'Ашан',site:'https://www.auchan.ru/',aliases:['ашан','атак']},
  {id:'okey',name:'О’КЕЙ',site:'https://www.okeydostavka.ru/',aliases:['окей','о кей','о’кей','о\'кей']},
  {id:'metro',name:'METRO',site:'https://online.metro-cc.ru/',aliases:['metro','метро кеш энд керри']},
  {id:'samokat',name:'Самокат',site:'https://samokat.ru/',aliases:['самокат']},
  {id:'chizhik',name:'Чижик',site:'https://chizhik.club/',aliases:['чижик']},
  {id:'fixprice',name:'Fix Price',site:'https://fix-price.com/',aliases:['fix price','фикс прайс']}
]);
function norm(x){return String(x||'').toLocaleLowerCase('ru').normalize('NFKC').replaceAll('ё','е').replace(/[^\p{L}\d]+/gu,' ').trim()}
export const requiredStoreIds = () => REQUIRED_RU.map(s=>s.id);
export function getStore(id){return [...REQUIRED_RU,...OTHER_CHAINS].find(s=>s.id===id)||null}
export function canonicalId(name){
  const n=norm(name);
  if(!n)return null;
  for(const item of [...REQUIRED_RU,...OTHER_CHAINS]) {
    if([item.name,...item.aliases].some(x=>norm(x)===n))return item.id;
  }
  return null;
}
/**
 * OSM only verifies a physical store is mapped nearby. It does NOT verify home delivery.
 * Aggregators are always included separately from the shops they aggregate.
 */
export function buildServiceCatalog({countryCode='ru',localStores=[],connectedIds=[],nativeIds=[]}={}){
  if(String(countryCode).toLowerCase()!=='ru')return {required:[],additional:[],all:[],requiredIds:[]};
  const connected=new Set(connectedIds);
  const native=new Set(nativeIds);
  const byBrand=new Map();
  const unknown=new Map();
  for(const s of localStores){
    const id=canonicalId(s.brand||s.name)||canonicalId(s.name);
    if(id){byBrand.set(id,(byBrand.get(id)||0)+1);continue;}
    const name=String(s.name||'').trim();
    const key=norm(name);
    if(name&&!unknown.has(key))unknown.set(key,{name,site: typeof s.website==='string' && /^https:\/\//.test(s.website)?s.website:null});
  }
  const create=(s,required)=>({id:s.id,name:s.name,site:s.site,kind:s.kind||'retailer',required,
    nearbyMappedStores:byBrand.get(s.id)||0,
    catalogStatus:connected.has(s.id)?'connector-configured':s.id==='vkusvill'?'public-catalog':native.has(s.id)?'experimental':'not-connected',
    deliveryStatus:'unverified'});
  const required=REQUIRED_RU.map(s=>create(s,true));
  const additional=OTHER_CHAINS.filter(s=>byBrand.has(s.id)||connected.has(s.id)).map(s=>create(s,false));
  for(const {name,site} of unknown.values()){
    // Stable deterministic ID for a site discovery; never let a discovered label override a required provider.
    const id='local-'+Array.from(norm(name)).reduce((v,c)=>(v*31+c.codePointAt(0))>>>0,7).toString(36);
    additional.push({id,name,site,kind:'retailer',required:false,nearbyMappedStores:1,
      catalogStatus:connected.has(id)?'connector-configured':'not-connected',deliveryStatus:'unverified'});
  }
  return {required,additional,all:[...required,...additional],requiredIds:requiredStoreIds()};
}
