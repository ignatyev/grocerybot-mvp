/**
 * Temporary, read-only browser/website pairing. No account, no cookies, no payment actions.
 * Keys are generated client-side using crypto.getRandomValues() and never appear in URLs.
 * Sessions are held in RAM and disappear on restart. API only transfers product offers.
 */
import {createHash, randomUUID} from 'node:crypto';

export const BRIDGE_PROVIDERS = Object.freeze(['magnit', '5ka', 'perekrestok', 'vkusvill', 'kuper', 'yandex_eda']);
const providerSet = new Set(BRIDGE_PROVIDERS);
const KEY_PATTERN = /^[a-f0-9]{48,64}$/;
const SESSION_TTL = 90 * 60 * 1000;
const JOB_TTL = 15 * 60 * 1000;
const MAX_SESSIONS = 100;
const MAX_QUEUE = 12;
const MAX_PRICE = 100_000_000;
const linkedHosts = {
  magnit: ['magnit.ru'], '5ka': ['5ka.ru'], perekrestok: ['perekrestok.ru'],
  vkusvill: ['vkusvill.ru'], kuper: ['kuper.ru'], yandex_eda: ['eda.yandex.ru', 'yandex.ru']
};
const err = (message, status = 400) => Object.assign(new Error(message), {status});
const now = () => Date.now();
const hash = key => createHash('sha256').update(key).digest('hex');
const safeText = (v, length = 160) => String(v ?? '').trim().slice(0, length);
const validKey = key => typeof key === 'string' && KEY_PATTERN.test(key);

function safeStoreId(storeId, providerId) {
  return storeId === providerId || (
    ['kuper', 'yandex_eda'].includes(providerId) &&
    typeof storeId === 'string' && storeId.startsWith(providerId + ':') && /^[a-z0-9:_-]{1,85}$/i.test(storeId)
  );
}
function safeUrl(raw, providerId) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    const hosts = linkedHosts[providerId];
    if (url.protocol !== 'https:' || !hosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return null;
    url.username = ''; url.password = ''; url.hash = '';
    // Do not send search text or tracking tokens as part of the product link.
    url.search = '';
    return url.toString().slice(0, 500);
  } catch {return null;}
}
function normalizeOffer(raw, providerId, itemIds) {
  if (!raw || typeof raw !== 'object' || !itemIds.has(raw.requestedId)) return null;
  const storeId = safeText(raw.storeId || providerId, 85);
  if (!safeStoreId(storeId, providerId)) return null;
  const priceKopecks = raw.priceKopecks;
  if (!Number.isSafeInteger(priceKopecks) || priceKopecks <= 0 || priceKopecks > MAX_PRICE) return null;
  const name = safeText(raw.name, 200);
  if (name.length < 2 || /\b(пароль|password|token|cookie|sessionid)\b/i.test(name)) return null;
  return {
    requestedId: raw.requestedId, storeId, sku: safeText(raw.sku || `browser-${providerId}-${raw.requestedId}`, 90),
    name, priceKopecks, packages: Number.isInteger(raw.packages) && raw.packages >= 1 && raw.packages <= 50 ? raw.packages : 1,
    matchScore: Number.isFinite(raw.matchScore) ? Math.max(.42, Math.min(1, raw.matchScore)) : .75,
    exactMatch: raw.exactMatch === true,
    url: safeUrl(raw.url, providerId), source: `Chrome: ${providerId}`, verifiedDelivery: false,
    unitWarning: raw.unitWarning !== false, // unless a trusted provider later checks the packaging
    capturedAt: new Date().toISOString()
  };
}
export function createBridge({clock = now} = {}) {
  const sessions = new Map();
  function clean() {
    const t = clock();
    for (const [h,s] of sessions) if (s.expires < t) sessions.delete(h);
    for (const s of sessions.values()) for (const [id,j] of s.jobs) if (j.created + JOB_TTL < t) s.jobs.delete(id);
  }
  function session(key) {
    if (!validKey(key)) throw err('Неверный код сопряжения');
    clean();
    const s = sessions.get(hash(key));
    if (!s) throw err('Сопряжение истекло. Создайте новый код.', 404);
    return s;
  }
  function open({key}) {
    if (!validKey(key)) throw err('Код должен быть случайной строкой из 48–64 шестнадцатеричных символов');
    clean();
    if (sessions.size >= MAX_SESSIONS && !sessions.has(hash(key))) throw err('Сервер сопряжений занят', 503);
    const h = hash(key);
    const previous = sessions.get(h);
    if (previous) return {connected:true,expiresAt:previous.expires};
    sessions.set(h,{expires:clock()+SESSION_TTL, jobs:new Map(), lastSeen:0, connectedAt:0});
    return {connected:true,expiresAt:clock()+SESSION_TTL};
  }
  function connect({key}) {
    const s = session(key);
    s.lastSeen = clock(); s.connectedAt ||= s.lastSeen;
    return {connected:true,expiresAt:s.expires};
  }
  function enqueue({key,items,providers}) {
    const s = session(key); clean();
    if (!Array.isArray(items) || !items.length || items.length > 12) throw err('Нужно от 1 до 12 товаров');
    const normalizedItems=items.map((item,index)=>({
      id: safeText(item?.id,40) || `i${index}`, query: safeText(item?.query,100),
      needed: (item?.needed && Number.isFinite(item.needed.quantity) && item.needed.quantity>0 && item.needed.quantity<=100000 && ['г','мл','шт'].includes(item.needed.unit)) ?
        {quantity:item.needed.quantity,unit:item.needed.unit}:null
    }));
    if(normalizedItems.some(i=>i.query.length<2) || new Set(normalizedItems.map(i=>i.id)).size!==normalizedItems.length)throw err('Некорректный список товаров');
    if(!Array.isArray(providers)||!providers.length||providers.length>BRIDGE_PROVIDERS.length)throw err('Некорректный список магазинов');
    if(providers.some(p=>!providerSet.has(p)) || new Set(providers).size!==providers.length)throw err('Недоступный магазин');
    const active=[...s.jobs.values()].filter(j=>j.status==='pending'||j.status==='running');
    if(active.length) throw err('Предыдущий поиск ещё выполняется');
    s.jobs.clear();
    for (const providerId of providers) {
      if (s.jobs.size >= MAX_QUEUE) throw err('Слишком много заданий');
      const id=randomUUID();
      s.jobs.set(id,{id,providerId,items:normalizedItems,created:clock(),status:'pending',assignedAt:0,offers:[],error:null});
    }
    return {queued:s.jobs.size,jobIds:[...s.jobs.keys()]};
  }
  function pull({key}) {
    const s = session(key);
    s.lastSeen = clock();s.connectedAt ||= s.lastSeen;
    const t = clock();
    for (const job of s.jobs.values()) {
      if(job.status==='running' && job.assignedAt+120_000 < t) job.status='pending';
      if(job.status==='pending') {
        job.status='running';job.assignedAt=t;
        return {job:{id:job.id,providerId:job.providerId,items:job.items},pending:[...s.jobs.values()].filter(j=>j.status==='pending').length};
      }
    }
    return {job:null,pending:0};
  }
  function complete({key,jobId,providerId,status='done',offers=[],error=null}) {
    const s = session(key);
    const j=s.jobs.get(jobId);
    if(!j || j.providerId!==providerId)throw err('Задание не найдено',404);
    if(j.status==='done')return {saved:true,duplicate:true,offers:j.offers.length};
    if(!['done','needs-user','error'].includes(status))throw err('Некорректный статус');
    if(!Array.isArray(offers)||offers.length>80)throw err('Слишком много предложений');
    const ids=new Set(j.items.map(i=>i.id));
    const fresh=offers.map(o=>normalizeOffer(o,providerId,ids)).filter(Boolean);
    if(fresh.length) {
      const old=new Set(fresh.map(o=>o.requestedId));
      j.offers=[...j.offers.filter(o=>!old.has(o.requestedId)),...fresh].slice(0,80);
    }
    const covered=new Set(j.offers.map(o=>o.requestedId));
    const complete= j.items.every(i=>covered.has(i.id));
    j.status=complete?'done':status==='error'?'error':'needs-user';
    j.error=complete?null:(safeText(error,250)||'Часть товаров не найдена автоматически, откройте их вручную');
    return {saved:true,offers:j.offers.length,status:j.status,covered:covered.size,requested:j.items.length};
  }
  function status({key}) {
    const s=session(key);
    return {connected:s.connectedAt>0,workerLastSeen:s.lastSeen,
      expiresAt:s.expires,jobs:[...s.jobs.values()].map(j=>({id:j.id,providerId:j.providerId,status:j.status,error:j.error,offers:j.offers,items:j.items,created:j.created}))};
  }
  function close({key}) {session(key);sessions.delete(hash(key));return {closed:true};}
  return {open,connect,enqueue,pull,complete,status,close};
}
