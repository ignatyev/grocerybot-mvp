import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBridge,BRIDGE_PROVIDERS} from '../bridge.js';
import {normalizedOffers,relevance} from '../extension/offer-matching.js';
const key='1234567890abcdef'.repeat(4);
const key2='deadbeefdeadbeef'.repeat(4);
const item={id:'i0',query:'Молоко',needed:{quantity:2000,unit:'мл'}};
const offer={requestedId:'i0',storeId:'magnit',sku:'123',name:'Молоко 3,2% 1 л',priceKopecks:9900,packages:2,matchScore:.9,unitWarning:false,url:'https://magnit.ru/product/abc?ref=tracking'};

test('pair keys are high entropy and not interchangeable',()=>{
 const b=createBridge();
 assert.throws(()=>b.open({key:'12345'}),/Код/);
 b.open({key});
 assert.throws(()=>b.status({key:key2}),/истекло/);
 assert.equal(b.connect({key}).connected,true);
 assert.equal(b.status({key}).connected,true);
});
test('queue is restricted to allowed store IDs; no arbitrary browser URL commands',()=>{
 const b=createBridge();b.open({key});
 assert.deepEqual(BRIDGE_PROVIDERS,['magnit','5ka','perekrestok','vkusvill','kuper','yandex_eda']);
 assert.throws(()=>b.enqueue({key,providers:['http://evil.org'],items:[item]}),/Недоступный/);
 assert.throws(()=>b.enqueue({key,providers:['magnit'],items:[{id:'a',query:'a'}]}),/список/);
 const r=b.enqueue({key,providers:['magnit','kuper'],items:[item]});
 assert.equal(r.queued,2);
 assert.equal(b.pull({key}).job.providerId,'magnit');
 assert.throws(()=>b.enqueue({key,providers:['magnit'],items:[item]}),/Предыдущий поиск/);
});
test('bridge stores ONLY safe product data, not URL tracking tokens',()=>{
 const b=createBridge();b.open({key});b.enqueue({key,providers:['magnit'],items:[item]});
 const {job}=b.pull({key});
 const res=b.complete({key,jobId:job.id,providerId:'magnit',status:'done',offers:[offer,{...offer,name:'password token',sku:'sensitive'},{...offer,storeId:'other'},{...offer,priceKopecks:-1}]});
 assert.equal(res.offers,1);
 const results=b.status({key});
 assert.equal(results.jobs[0].offers.length,1);
 const first=results.jobs[0].offers[0];
 assert.equal(first.url,'https://magnit.ru/product/abc');
 assert.equal(first.unitWarning,false);
 assert.ok(!JSON.stringify(first).includes('tracking'));
 assert.equal(b.complete({key,jobId:job.id,providerId:'magnit',status:'done',offers:[]}).duplicate,true);
});
test('manual capture can recover a needs-user job without queue restart',()=>{
 const b=createBridge();b.open({key});b.enqueue({key,providers:['perekrestok'],items:[item]});
 const {job}=b.pull({key});
 b.complete({key,jobId:job.id,providerId:'perekrestok',status:'needs-user',error:'Search missing'});
 assert.equal(b.status({key}).jobs[0].status,'needs-user');
 const recovery=b.complete({key,jobId:job.id,providerId:'perekrestok',status:'done',offers:[{...offer,storeId:'perekrestok'}]});
 assert.equal(recovery.offers,1);
 assert.equal(b.status({key}).jobs[0].status,'done');
});
test('expired session rejects calls and does not reveal other sessions',()=>{
 let time=5000;const b=createBridge({clock:()=>time});b.open({key});
 b.open({key:key2});
 time+=91*60*1000;
 assert.throws(()=>b.pull({key}),/истекло/);
 assert.throws(()=>b.status({key:key2}),/истекло/);
});
test('mixed Russian inflection and exact quantity conversion',()=>{
 assert.equal(relevance('бананы','Банан свежий'),1);
 const r=normalizedOffers({providerId:'magnit',item,cards:[{name:'Молоко 3,2%, 1 л',priceKopecks:9300,url:'https://magnit.ru/123'}]});
 assert.equal(r.length,1);
 assert.equal(r[0].packages,2);
 assert.equal(r[0].unitWarning,false);
 const wrong=normalizedOffers({providerId:'magnit',item,cards:[{name:'Молоко 3,2%, 200 г',priceKopecks:9300}]});
 assert.equal(wrong[0].unitWarning,true);
});
test('unverified items are not substituted silently when no pack information',()=>{
 const r=normalizedOffers({providerId:'5ka',item,cards:[{name:'Молоко 3,2%',priceKopecks:9000}]});
 assert.equal(r[0].unitWarning,true);
});

test('partial browser results persist until all requested items have prices',()=>{
 const b=createBridge();b.open({key});
 b.enqueue({key,providers:['magnit'],items:[item,{id:'i1',query:'сыр'}]});
 const {job}=b.pull({key});
 const first=b.complete({key,jobId:job.id,providerId:'magnit',status:'needs-user',offers:[offer],error:'не найден сыр'});
 assert.equal(first.status,'needs-user');assert.equal(first.covered,1);
 const other={...offer,requestedId:'i1',name:'Сыр Российский 200 г',sku:'2'};
 const second=b.complete({key,jobId:job.id,providerId:'magnit',status:'done',offers:[other]});
 assert.equal(second.status,'done');assert.equal(b.status({key}).jobs[0].offers.length,2);
});
