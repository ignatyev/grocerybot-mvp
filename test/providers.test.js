import {test} from 'node:test';
import assert from 'node:assert/strict';
import {REQUIRED_RU,requiredStoreIds,canonicalId,buildServiceCatalog} from '../store-registry.js';
import {configuredAdapters,normalizeAdapterResult,callAdapter,initialProviderStatuses,coverageSummary} from '../provider-connectors.js';
import {searchCatalogs} from '../server.js';
const six=['magnit','pyaterochka','perekrestok','vkusvill','kuper','yandex_eda'];
test('all six priority providers included even with no nearby stores',()=>{
  const c=buildServiceCatalog({countryCode:'ru',localStores:[]});
  assert.deepEqual(requiredStoreIds(),six);
  assert.deepEqual(c.required.map(s=>s.id),six);
  assert.equal(c.required.length,6);
  assert.equal(c.required.every(s=>s.deliveryStatus==='unverified'),true);
});
test('brand aliases recognized in OSM without confusing aggregator and retailer',()=>{
  const c=buildServiceCatalog({countryCode:'ru',localStores:[
    {name:'Пятерочка'},{name:'Пятёрочка'},{name:'Магнит Экстра'},
    {name:'Лента'},{name:'Местный продуктовый'}]});
  assert.equal(c.required.find(s=>s.id==='pyaterochka').nearbyMappedStores,2);
  assert.equal(c.required.find(s=>s.id==='magnit').nearbyMappedStores,1);
  assert.equal(c.required.find(s=>s.id==='kuper').nearbyMappedStores,0);
  assert.ok(c.additional.some(s=>s.id==='lenta'));
  assert.ok(c.additional.some(s=>s.name==='Местный продуктовый'));
  assert.equal(canonicalId('Перекресток'),'perekrestok');
});
test('outside Russia no hard-coded Russian sources',()=>{
  assert.deepEqual(buildServiceCatalog({countryCode:'bg'}).all,[]);
});
test('adapter configuration allows only HTTPS or local development HTTP',()=>{
  const configured=configuredAdapters({GROCERYBOT_ADAPTERS_JSON:JSON.stringify({magnit:{url:'https://example.com/api'},kuper:{url:'http://localhost:4000/api'}}),NODE_ENV:'development'});
  assert.deepEqual(Object.keys(configured),['magnit','kuper']);
  assert.throws(()=>configuredAdapters({GROCERYBOT_ADAPTERS_JSON:JSON.stringify({magnit:{url:'http://evil.example/api'}}),NODE_ENV:'production'}));
});
test('adapter verifies address and delivery; unsafe/incomplete quotes excluded',()=>{
  const items=[{id:'i0',query:'молоко'}];
  const raw={addressChecked:true,stores:[
    {storeId:'magnit',name:'Магнит',addressAvailable:true,verifiedDelivery:true,deliveryKopecks:9900},
    {storeId:'pyaterochka',name:'Пятёрочка',addressAvailable:false,verifiedDelivery:false,deliveryKopecks:0}],
  offers:[{requestedId:'i0',storeId:'magnit',sku:'1',name:'Молоко 1 л',priceKopecks:14900,packages:1,matchScore:.89,url:'https://magnit.ru/item/1'},
    {requestedId:'i0',storeId:'pyaterochka',sku:'1',name:'Молоко',priceKopecks:100,packages:1,matchScore:1}]};
  const out=normalizeAdapterResult('magnit',raw,items);
  assert.equal(out.stores.length,1);
  assert.equal(out.offers.length,1);
  assert.equal(out.offers[0].storeId,'magnit');
});
test('aggregator outlets remain separate delivery options',()=>{
  const out=normalizeAdapterResult('yandex_eda',{stores:[
    {storeId:'yandex_eda:magnit-1',name:'Яндекс Еда · Магнит 1',addressAvailable:true,verifiedDelivery:true,deliveryKopecks:10000},
    {storeId:'yandex_eda:pyaterochka-2',name:'Яндекс Еда · Пятёрочка 2',addressAvailable:true,verifiedDelivery:true,deliveryKopecks:12000}],
    offers:[{requestedId:'i0',storeId:'yandex_eda:magnit-1',sku:'abc',name:'Молоко',priceKopecks:9900,packages:1,matchScore:1}]},[{id:'i0',query:'молоко'}]);
  assert.equal(out.stores.length,2);
  assert.equal(out.offers[0].storeId,'yandex_eda:magnit-1');
});
test('adapter POST includes delivery address, products and bearer credential',async()=>{
  const calls=[];const fetchFn=async(url,opts)=>{calls.push({url,opts});return new Response(JSON.stringify({addressChecked:true,available:false,stores:[],offers:[]}),{status:200});};
  const out=await callAdapter('kuper',{url:'https://adapter.example/api',token:'dummy'},{address:'Россия, Сочи, Ленина 1',point:{lat:43,lon:39},items:[{id:'i0',query:'молоко'}],allowSubstitutions:true},fetchFn);
  assert.equal(out.availability,'unavailable');
  assert.equal(calls[0].opts.headers.Authorization,'Bearer dummy');
  assert.match(calls[0].opts.body,/Сочи/);
});
test('incomplete required providers keep global coverage unverified',()=>{
  const statuses=initialProviderStatuses(buildServiceCatalog({countryCode:'ru'}),[]);
  statuses.find(s=>s.id==='vkusvill').status='catalog-only';
  assert.equal(coverageSummary(statuses).completeMarketComparison,false);
  assert.equal(coverageSummary(statuses).missingRequired.length,6);
});
test('search orchestrator touches all configured providers, preserving statuses',async()=>{
  const catalog=buildServiceCatalog({countryCode:'ru'});
  const adapters={magnit:{url:'https://adapter.example/magnit'},yandex_eda:{url:'https://adapter.example/eda'}};
  const seen=[];
  const data=await searchCatalogs({list:'молоко 1 л',address:'Россия, Сочи, Навагинская 9',countryCode:'ru'}, {
    adapters,
    searchVV:async()=>[{storeId:'vkusvill',sku:'1',name:'Молоко',priceKopecks:15900,packages:1,matchScore:1}],
    callAdapter:async(id)=>{seen.push(id);return {stores:[{id,quoteVerified:true,deliveryKopecks:9900}],offers:[{storeId:id,requestedId:'i0',sku:'123',name:'Молоко',priceKopecks:10000,packages:1,matchScore:1}],availability:'verified',checkedAt:new Date().toISOString()};}
  });
  assert.deepEqual(seen.sort(),['magnit','yandex_eda']);
  assert.deepEqual(data.providers.filter(s=>s.required).map(s=>s.id),catalog.required.map(s=>s.id));
  assert.equal(data.providers.find(s=>s.id==='magnit').status,'address-priced');
  assert.equal(data.providers.find(s=>s.id==='perekrestok').status,'not-connected');
  assert.equal(data.coverage.completeMarketComparison,false);
  assert.equal(data.items[0].offers.length,3);
});
test('newly found local networks block a claim of globally optimal cart until checked',()=>{
  const catalog=buildServiceCatalog({countryCode:'ru',localStores:[{name:'Неизвестная сеть'}]});
  const statuses=initialProviderStatuses(catalog,[]).map(s=>({...s,status:'unavailable'}));
  statuses.find(s=>s.name==='Неизвестная сеть').status='not-connected';
  const result=coverageSummary(statuses);
  assert.equal(result.allMandatoryChecked,true);
  assert.equal(result.completeMarketComparison,false);
  assert.deepEqual(result.missingAdditional,['Неизвестная сеть']);
});
