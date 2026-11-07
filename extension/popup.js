const $=id=>document.getElementById(id);
function send(type,fields={}) {return new Promise((resolve,reject)=>chrome.runtime.sendMessage({type,...fields},reply=>{
  const problem=chrome.runtime.lastError?.message;
  if(problem)return reject(new Error(problem));
  if(reply?.error)return reject(new Error(reply.error));resolve(reply);
}));}
function status(msg){$('status').textContent=msg;}
async function refresh(){
  try {
    const data=await send('STATUS');
    $('connected').classList.toggle('hidden',!data.connected);
    $('pairArea').classList.toggle('hidden',!!data.connected);
    if(data.connected)status(data.lastStatus||'Подключено к GroceryBot');
  } catch(e) { $('pairArea').classList.remove('hidden'); }
}
async function command(btn,fn){const old=btn.textContent;btn.disabled=true;try{const x=await fn();if(x)status(x);}catch(e){alert('GroceryBot: '+e.message);}finally{btn.disabled=false;btn.textContent=old;await refresh();}}
$('connect').onclick=()=>command($('connect'),async()=>{
  await send('CONNECT',{key:$('key').value.trim().toLowerCase()});$('key').value='';return 'Подключено';
});
$('poll').onclick=()=>command($('poll'),async()=>{
  const r=await send('POLL');return r.job?`Запрос ${r.job}: ${r.offers} предложений`:(r.error||'Новых заданий нет');
});
$('disconnect').onclick=()=>command($('disconnect'),async()=>{await send('DISCONNECT');return 'Отключено';});
$('manual').onclick=()=>command($('manual'),async()=>{
  const q=$('manualQuery').value.trim();if(q.length<2)throw new Error('Введите название товара');
  const r=await send('MANUAL_CAPTURE',{query:q});return `Считано ${r.offers} цен (${r.providerId})`;
});
void refresh();
