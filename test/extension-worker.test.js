import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBridge} from '../bridge.js';

const key='abcdef0123456789'.repeat(4);
function browserEnvironment(){
  const bridge=createBridge();bridge.open({key});
  const stats={tabs:[],updates:[],injected:0};let nextId=0;
  globalThis.chrome={
    storage:{local:{get:async()=>({pairKey:key}),set:async()=>{},remove:async()=>{}}},
    alarms:{create:async()=>{},onAlarm:{addListener:()=>{}}},
    runtime:{onInstalled:{addListener:()=>{}},onStartup:{addListener:()=>{}},onMessage:{addListener:()=>{}}},
    tabs:{query:async()=>[],create:async({url})=>{const tab={id:++nextId,url,status:'complete'};stats.tabs.push(tab);return tab;},
      get:async id=>stats.tabs.find(t=>t.id===id),remove:async()=>{},update:async(id,{url})=>{stats.updates.push(url);return {id,url,status:'complete'}},
      onUpdated:{addListener:()=>{},removeListener:()=>{}}},
    scripting:{executeScript:async x=>{
      if(x.files){stats.injected++;return [{}];}
      const [action]=x.args||[];
      if(action==='scan')return [{result:{cards:[{name:'Молоко 3,2%, 1 л',priceKopecks:9300,url:'https://vkusvill.ru/goods/moloko-3-173/'}],location:'https://vkusvill.ru/search/?q=...',pageTitle:'Поиск молоко'}}];
      if(action==='search')return [{result:{submitted:true,url:'https://magnit.ru'}}];
      return [];
    }}
  };
  globalThis.fetch=async (url,options)=>{
    const action=url.toString().split('/').pop();const req=JSON.parse(options.body);
    let data;
    if(!bridge[action])throw Error('Unexpected bridge method '+action);
    data=bridge[action](req);
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
  return {bridge,stats};
}

test('worker uses verified VkusVill search URL without needing a visible search field',async()=>{
  const origChrome=globalThis.chrome, origFetch=globalThis.fetch;
  try{
    const {bridge,stats}=browserEnvironment();
    bridge.enqueue({key,providers:['vkusvill'],items:[{id:'i0',query:'молоко',needed:{quantity:1000,unit:'мл'}}]});
    const {pollNow}=await import('../extension/background.js');
    const result=await pollNow();
    assert.equal(result.offers,1);
    assert.equal(bridge.status({key}).jobs[0].status,'done');
    assert.equal(stats.updates[0],'https://vkusvill.ru/search/?q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE');
    assert.ok(stats.injected>0);
  }finally {globalThis.chrome=origChrome;globalThis.fetch=origFetch;}
});

test('worker reaches verified milk categories in 5ka and Perekrestok without search input',async()=>{
 const origChrome=globalThis.chrome,origFetch=globalThis.fetch;
 try{
   const {bridge,stats}=browserEnvironment();
   bridge.enqueue({key,providers:['5ka','perekrestok'],items:[{id:'i0',query:'молоко',needed:{quantity:1000,unit:'мл'}}]});
   const {pollNow}=await import('../extension/background.js?category-test');
   const result=await pollNow();
   assert.equal(result.offers,2);
   assert.deepEqual(stats.updates,[
     'https://5ka.ru/catalog/moloko--251C51947/',
     'https://www.perekrestok.ru/cat/c/114/moloko'
   ]);
   assert.deepEqual(bridge.status({key}).jobs.map(j=>j.status),['done','done']);
 }finally {globalThis.chrome=origChrome;globalThis.fetch=origFetch;}
});
