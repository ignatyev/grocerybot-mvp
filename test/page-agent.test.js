import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const js=readFileSync(new URL('../extension/page-agent.js',import.meta.url),'utf8');
const sandbox=vm.createContext({});vm.runInContext(js,sandbox);
const {parsePrice,cleanupName}=sandbox.__groceryDomAgent;

test('price recognition: Magnit, Pyaterochka, Perekrestok and Vkusvill',()=>{
  const samples={'79,99 ₽':7999,'219 99 ₽':21999,'1 299,99 ₽':129999,'93 руб/шт':9300,'Цена 89,99 ₽':8999};
  for(const [text,price] of Object.entries(samples))assert.equal(parsePrice(text),price,text);
});
test('Magnit marketing prefix and reviews are not mistaken for product title',()=>{
  assert.equal(cleanupName('Финальная цена +5% с Премиум 79,99 ₽ Молоко Агрокомплекс пастеризованное 2.5% 900мл 4.9 · 188 отзывов В корзину'),
    'Молоко Агрокомплекс пастеризованное 2.5% 900мл');
});
