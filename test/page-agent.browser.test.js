import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const agentUrl=pathToFileURL(fileURLToPath(new URL('../extension/page-agent.js',import.meta.url))).href;
function runFixture(body){
  const dir=mkdtempSync(path.join(tmpdir(),'grocery-browser-'));
  const file=path.join(dir,'fixture.html');
  const html=`<!doctype html><html lang="ru"><meta charset="utf-8"><body>${body}
<script src="${agentUrl}"></script>
<pre id="report"></pre>
<script>window.addEventListener('load',async()=>{try{const agent=globalThis.__groceryDomAgent;const before=agent.scan();const result=await agent.search('молоко');await new Promise(r=>setTimeout(r,250));const after=agent.scan();document.querySelector('#report').textContent='RESULT='+JSON.stringify({before,result,after});}catch(e){document.querySelector('#report').textContent='ERROR='+e.stack;}});</script></body></html>`;
  writeFileSync(file,html);
  try {
    const proc=spawnSync(process.env.CHROMIUM_BIN||'chromium', ['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-software-rasterizer','--virtual-time-budget=4000','--dump-dom',pathToFileURL(file).href],{timeout:15000,encoding:'utf8'});
    if(proc.error){if(proc.error.code==='ENOENT')return null;throw proc.error;}
    const match=proc.stdout.match(/RESULT=([^<]+)/);
    assert.ok(match,'Expected rendered RESULT; stderr: '+proc.stderr.slice(-500)+'\n'+proc.stdout.slice(-500));
    return JSON.parse(match[1].replaceAll('&quot;','"').replaceAll('&amp;','&'));
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('opens search icon, submits query and reads one accurate product card',{skip:process.env.GROCERYBOT_BROWSER_E2E!=='1'},t=>{
  const result=runFixture(`
    <button aria-label="Поиск товаров" id="open">🔍</button>
    <form id="searchForm" hidden><input placeholder="Название товара" type="search"><button type="submit">Найти</button></form>
    <main id="products"><div class="ProductCard"><h3>Бананы 1кг</h3><span>110,00 ₽</span></div></main>
    <script>document.querySelector('#open').onclick=()=>document.querySelector('#searchForm').hidden=false;
      document.querySelector('#searchForm').onsubmit=e=>{e.preventDefault();document.querySelector('#products').innerHTML='<div class="ProductCard"><div>Финальная цена +5% с Премиум 79,99 ₽ Молоко Агрокомплекс пастеризованное 2.5% 900мл 4.9 · 188 отзывов В корзину</div></div>';};</script>`);
  if(!result){t.skip('Chromium is unavailable');return;}
  assert.equal(result.result.submitted,true);
  assert.equal(result.after.cards[0].name,'Молоко Агрокомплекс пастеризованное 2.5% 900мл');
  assert.equal(result.after.cards[0].priceKopecks,7999);
});
test('does not click checkout button and reports absence of search',{skip:process.env.GROCERYBOT_BROWSER_E2E!=='1'},t=>{
 const result=runFixture(`<button aria-label="Оформить заказ">Оплатить</button><div class="ProductCard"><h3>Молоко 1 л</h3><span>100 ₽</span></div>`);
 if(!result){t.skip('Chromium is unavailable');return;}
 assert.equal(result.result.submitted,false);
 assert.match(result.result.reason,/не найдены/);
});
test('recognizes 5ka separated ruble/kopeck price',{skip:process.env.GROCERYBOT_BROWSER_E2E!=='1'},t=>{
 const result=runFixture(`<form><input type="search" placeholder="Поиск"><button type="submit">Найти</button></form>
 <article class="product-card"><h3>Молоко Братья Чебурашкины 1л</h3><div>219 99 ₽</div></article>
 <script>document.querySelector('form').onsubmit=e=>e.preventDefault();</script>`);
 if(!result){t.skip('Chromium is unavailable');return;}
 assert.equal(result.after.cards[0].priceKopecks,21999);
});
