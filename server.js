import http from 'node:http';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {geocode,discoverStores,parseLine,searchVV,vvBasketLink} from './adapters.js';
import {optimize} from './optimizer.js';
const dir=path.dirname(fileURLToPath(import.meta.url));
const html=fs.readFileSync(path.join(dir,'public/index.html'));
const PORT=Number(process.env.PORT||3000);
const cache=new Map();
const rate=new Map();
function send(res,status,obj) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
async function body(req) {
  let s='';for await(const chunk of req) {s+=chunk.toString();if(s.length>32000)throw new Error('Запрос слишком большой');}
  return JSON.parse(s||'{}');
}
async function once(key,ttl,fn) {
  const stored=cache.get(key);if(stored&&stored.expiry>Date.now())return stored.value;
  const value=await fn();cache.set(key,{value,expiry:Date.now()+ttl});if(cache.size>500)cache.delete(cache.keys().next().value);return value;
}
function allow(ip) {const now=Date.now();const p=rate.get(ip)||{count:0,until:now+60000};if(now>p.until){p.count=0;p.until=now+60000;}p.count++;rate.set(ip,p);return p.count<=18;}
const knownStores=[
  {id:'vkusvill',name:'ВкусВилл',site:'https://vkusvill.ru/',status:'catalog-search'},
  {id:'magnit',name:'Магнит',site:'https://dostavka.magnit.ru/',status:'not-integrated'},
  {id:'5ka',name:'Пятёрочка',site:'https://5ka.ru/',status:'not-integrated'},
  {id:'lenta',name:'Лента',site:'https://lenta.com/',status:'not-integrated'},
  {id:'kuper',name:'Купер',site:'https://kuper.ru/',status:'not-integrated'}
];
async function handle(req,res) {
  const pathname=new URL(req.url||'/',`http://localhost:${PORT}`).pathname;
  if(req.method==='GET'&&pathname==='/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=60'});res.end(html);return;}
  if(req.method==='GET'&&pathname==='/health')return send(res,200,{ok:true,version:'0.1.0'});
  if(req.method!=='POST')return send(res,404,{error:'Не найдено'});
  const ip=req.socket.remoteAddress||'unknown';if(!allow(ip))return send(res,429,{error:'Слишком много запросов; повторите через минуту'});
  const data=await body(req);
  if(pathname==='/api/discover') {
    const point=await once('geo:'+data.address,1000*60*60,()=>geocode(String(data.address||'')));
    let local=[],warnings=[];
    try {local=await once('shops:'+point.lat+':'+point.lon,1000*60*30,()=>discoverStores(point));}
    catch(e){warnings.push('Поиск соседних магазинов временно недоступен: '+e.message);}
    return send(res,200,{point,localStores:local,catalogProviders:point.countryCode==='ru'?knownStores:[],warnings,
      deliveryVerified:false,note:'Найденные физические магазины не обязательно доставляют по адресу.'});
  }
  if(pathname==='/api/search') {
    const lines=String(data.list||'').split(/\r?\n/).map(parseLine).filter(Boolean).slice(0,12);
    if(!lines.length)return send(res,400,{error:'Укажите хотя бы один товар'});
    const countryCode=String(data.countryCode||'ru').toLowerCase();
    const errors=[];const results=lines.map(item=>({...item,offers:[]}));
    if(countryCode==='ru'){
      for(let i=0;i<results.length;i+=3) {
        await Promise.all(results.slice(i,i+3).map(async item=>{
          try {item.offers=await once('vv:'+item.query+':'+!!data.allowSubstitutions,1000*60*5,()=>searchVV(item,data.allowSubstitutions!==false));}
          catch(e){errors.push({query:item.query,message:e.message});}
        }));
      }
    } else errors.push({message:'ВкусВилл доступен только в России; для других стран пока нет автоматического ценового адаптера.'});
    return send(res,200,{items:results,errors,source:'ВкусВилл MCP',deliveryChecked:false,
      note:'Это реальные каталоговые цены, не гарантированные суммы доставки или наличие по вашему адресу.'});
  }
  if(pathname==='/api/optimize') {
    if(!Array.isArray(data.items)||!Array.isArray(data.stores))return send(res,400,{error:'Требуются items и stores'});
    if(data.items.length>18||data.stores.length>15)return send(res,400,{error:'Превышен размер MVP-корзины'});
    return send(res,200,optimize(data.items,data.stores,{maxDeliveries:2,minSplitSavingsKopecks:30000,allowSubstitutions:data.allowSubstitutions!==false}));
  }
  if(pathname==='/api/cart/vkusvill')return send(res,200,{link:await vvBasketLink(Array.isArray(data.items)?data.items:[])});
  send(res,404,{error:'Не найдено'});
}
export function createServer(){return http.createServer((req,res)=>handle(req,res).catch(e=>send(res,400,{error:e.message||'Неизвестная ошибка'})));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))createServer().listen(PORT,'0.0.0.0',()=>console.log(`GroceryBot MVP http://0.0.0.0:${PORT}`));
