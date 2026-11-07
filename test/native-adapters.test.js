import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractJsonLdProducts,searchDirectRetailer,parseYandexPlaces,searchYandexEda,searchKuper} from '../native-adapters.js';
import {searchCatalogs} from '../server.js';

const item = {id:'i0',query:'молоко',needed:{quantity:1000,unit:'мл'}};
const json = (data) => new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
const html = (body) => new Response(body,{status:200,headers:{'content-type':'text/html'}});

test('retailer JSON-LD catalog parser extracts real listed prices, never invents items',()=>{
 const raw='<script type="application/ld+json">'+JSON.stringify({'@type':'ItemList',itemListElement:[{'@type':'ListItem',item:{'@type':'Product',name:'Молоко 1 л',sku:'123',offers:{price:'120.50',priceCurrency:'RUB'}}}]})+'</script>';
 assert.deepEqual(extractJsonLdProducts(raw).map(x=>[x.name,x.price]),[['Молоко 1 л','120.50']]);
 assert.deepEqual(extractJsonLdProducts('<html>no prices</html>'),[]);
});
test('Magnit read-only price search uses site and never marks delivery as verified', async()=>{
 let requests=0;
 const r=await searchDirectRetailer('magnit',[item],{fetchFn:async url=>{
   assert.match(url,/magnit.ru\/search\?term=/);requests++;
   return html('<script type="application/ld+json">{"@type":"Product","name":"Молоко 1 л","sku":"A1","offers":{"price":99.99}}</script>');
 }});
 assert.equal(requests,1);assert.equal(r.status,'catalog-only');
 assert.equal(r.offers[0].priceKopecks,9999);assert.equal(r.offers[0].storeId,'magnit');
 assert.equal(r.checkedDelivery,false);assert.equal(r.offers[0].verifiedForAddress,false);
});
test('retailer blocked or HTML without prices cannot claim prices',async()=>{
 const r=await searchDirectRetailer('pyaterochka',[item],{fetchFn:async()=>html('<html>no jsonld</html>')});
 assert.equal(r.status,'no-quote');assert.equal(r.offers.length,0);
});
test('Yandex Eda retail parsing and address-scoped read-only pricing',async()=>{
 assert.deepEqual(parseYandexPlaces('<a href="/retail/magnit?placeSlug=magnit_celevaya_k6g7p">M</a>'),['magnit_celevaya_k6g7p']);
 const calls=[];
 const r=await searchYandexEda([item],{lat:43.5,lon:39.7},{fetchFn:async(url,opts)=>{
   calls.push({url,opts});
   if(url.includes('/retail?'))return html('<a href="/retail/magnit?placeSlug=magnit_celevaya_k6g7p">Магнит</a>');
   assert.equal(JSON.parse(opts.body).text,'молоко');
   return json({payload:{items:[{id:'itm1',name:'Молоко 1 л',price:89,weight:'1 л'}]}});
 }});
 assert.equal(r.status,'catalog-only');assert.equal(r.offers[0].priceKopecks,8900);
 assert.equal(r.offers[0].storeId,'yandex_eda:magnit_celevaya_k6g7p');
 assert.equal(r.checkedDelivery,false);assert.equal(calls.length,2);
});
test('Kuper read-only store discovery and price comparison scoped to coordinates',async()=>{
 const calls=[];
 const r=await searchKuper([item],{lat:43.5,lon:39.7},{fetchFn:async(url)=>{
   calls.push(url);
   if(url.includes('/api/v2/stores'))return json({stores:[{id:321,name:'Витрина',retailer:{name:'Пятёрочка'}}]});
   return json({products:[{id:123,name:'Молоко 1 л',price:91}]});
 }});
 assert.equal(r.status,'catalog-only');assert.equal(r.stores[0].name,'Купер · Пятёрочка');
 assert.equal(r.offers[0].storeId,'kuper:321');assert.equal(r.offers[0].priceKopecks,9100);
 assert.ok(calls.some(c=>c.includes('lat=43.5')));
 assert.equal(r.checkedDelivery,false);
});
test('search orchestrator includes price-only providers but global verification stays false',async()=>{
 const r=await searchCatalogs({list:'молоко',point:{lat:43,lon:39},countryCode:'ru'}, {
   nativeAdapterIds:['magnit','kuper'],adapters:{},
   searchVV:async()=>[],runNativeAdapter:async(id)=>({provider:id,offers:[{storeId:id,requestedId:'i0',sku:id,name:'Молоко',priceKopecks:10000,packages:1,matchScore:1}],checkedDelivery:false,status:'catalog-only',stores:[],errors:[]})
 });
 assert.equal(r.providers.find(s=>s.id==='magnit').status,'catalog-only');
 assert.equal(r.items[0].offers.length,2);assert.equal(r.quotes.length,0);
 assert.equal(r.coverage.completeMarketComparison,false);
});

test('403 is browser-required and stops repeated requests to a protected store',async()=>{
 let count=0;
 const blocked=await searchDirectRetailer('pyaterochka',[item,{...item,id:'i1',query:'хлеб'}],{
   fetchFn:async()=>{count++;return new Response('Forbidden',{status:403})}
 });
 assert.equal(count,1);
 assert.equal(blocked.status,'browser-required');
 assert.equal(blocked.offers.length,0);
 assert.match(blocked.errors[0].message,/403/);
});
