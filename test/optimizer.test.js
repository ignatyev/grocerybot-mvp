import {test} from 'node:test';import assert from 'node:assert/strict';
import {selectPlan,optimize} from '../optimizer.js';
import {parseLine,normalizeVV} from '../adapters.js';
const plan=n=>({totalKopecks:n,deliveries:n?2:1,baskets:[]});
test('split threshold exact 300 rubles',()=>{let s={totalKopecks:50000,deliveries:1};let d={totalKopecks:20000,deliveries:2};assert.equal(selectPlan(s,d).deliveries,2);d.totalKopecks=20001;assert.equal(selectPlan(s,d).deliveries,1)});
test('forced split when single impossible',()=>{assert.equal(selectPlan(null,{totalKopecks:1000,deliveries:2}).deliveries,2)});
test('full price including delivery, threshold and minimum',()=>{const i=[
{id:'1',query:'сыр',offers:[{storeId:'a',sku:'a1',name:'сыр',priceKopecks:60000,packages:1,matchScore:1,exactMatch:true},{storeId:'b',sku:'b1',name:'сыр',priceKopecks:7000,packages:1,matchScore:1,exactMatch:true}]},
{id:'2',query:'кофе',offers:[{storeId:'a',sku:'a2',name:'кофе',priceKopecks:15000,packages:1,matchScore:1,exactMatch:true},{storeId:'b',sku:'b2',name:'кофе',priceKopecks:80000,packages:1,matchScore:1,exactMatch:true}]}];
const stores=[{id:'a',name:'A',deliveryKopecks:10000},{id:'b',name:'B',deliveryKopecks:5000}];const r=optimize(i,stores);assert.equal(r.status,'OK');assert.equal(r.bestSingle.totalKopecks,85000);assert.equal(r.bestSplit.totalKopecks,37000);assert.equal(r.selected.deliveries,2);stores[1].deliveryKopecks=60000;const r2=optimize(i,stores);assert.equal(r2.selected.deliveries,1);
});
test('unknown delivery cannot be ranked as free',()=>{const r=optimize([{id:'1',query:'a',offers:[{storeId:'a',sku:'1',name:'a',priceKopecks:100,packages:1,matchScore:1}]}],[{id:'a',name:'A',deliveryKopecks:null}]);assert.equal(r.selected,null);assert.equal(r.status,'NO_FEASIBLE_QUOTE');});
test('package parsing for cyrillic units',()=>{assert.deepEqual(parseLine('молоко 2 л',0).needed,{quantity:2000,unit:'мл'});const offers=normalizeVV({id:'i0',query:'молоко',needed:{quantity:2000,unit:'мл'}},[{id:123,name:'Молоко пастеризованное 1 л',price:{current:100}}]);assert.equal(offers[0].packages,2);});
test('disable substitutions when not exact',()=>{const r=optimize([{id:'1',query:'сыр',offers:[{storeId:'a',sku:'1',name:'тофу',priceKopecks:100,packages:1,matchScore:.6,exactMatch:false}]}],[{id:'a',name:'A',deliveryKopecks:0}],{allowSubstitutions:false});assert.equal(r.status,'INCOMPLETE');});
test('free shipping threshold',()=>{const r=optimize([{id:'1',query:'молоко',offers:[{storeId:'a',sku:'1',name:'молоко',priceKopecks:160000,packages:1,matchScore:1,exactMatch:true}]}],[{id:'a',name:'A',deliveryKopecks:9000,freeDeliveryFromKopecks:150000}]);assert.equal(r.selected.totalKopecks,160000)});
test('Russian inflection in product matching',()=>{const offers=normalizeVV({id:'i0',query:'яйца',needed:{quantity:10,unit:'шт'}},[{id:77,name:'Яйцо куриное С1, 10 шт',price:{current:119}}]);assert.equal(offers[0].packages,1)});

test('unknown pack size cannot satisfy a requested quantity in exact optimization',()=>{
 const r=optimize([{id:'1',query:'молоко 2 л',offers:[{storeId:'a',sku:'1',name:'молоко',priceKopecks:9300,packages:1,matchScore:1,unitWarning:true}]}],
   [{id:'a',name:'A',deliveryKopecks:0}]);
 assert.equal(r.status,'INCOMPLETE');
});
