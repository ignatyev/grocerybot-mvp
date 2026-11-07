import {test} from 'node:test';
import assert from 'node:assert/strict';
import {searchVV,vvBasketLink} from '../adapters.js';

const response = value => new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:JSON.stringify({ok:true,data:value})}]}}),{status:200,headers:{'Content-Type':'application/json'}});

test('MCP adapter parses real-style nested JSON-RPC search response', async () => {
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async (url,opts) => {
      assert.equal(url,'https://mcp.vkusvill.ru/mcp');
      const rpc=JSON.parse(opts.body);
      assert.equal(rpc.params.name,'vkusvill_products_search');
      return response({items:[{id:1248,xml_id:1248,name:'Молоко 1 л',price:{current:119.90},rating:{average:4.8}}]});
    };
    const offers=await searchVV({id:'i0',query:'молоко',needed:{quantity:2000,unit:'мл'}});
    assert.equal(offers[0].priceKopecks,11990);
    assert.equal(offers[0].packages,2);
    assert.equal(offers[0].sku,'1248');
  } finally {globalThis.fetch=original;}
});

test('MCP basket link uses product IDs and quantity',async()=>{
 const original=globalThis.fetch;
 try{
 globalThis.fetch=async(url,opts)=>{
   const rpc=JSON.parse(opts.body); assert.equal(rpc.params.name,'vkusvill_cart_link_create');
   assert.deepEqual(rpc.params.arguments.products,[{xml_id:1248,q:2}]);
   return response({link:'https://vkusvill.ru/?share_basket=test'});
 };
 const link=await vvBasketLink([{sku:'1248',packages:2}]);
 assert.equal(link,'https://vkusvill.ru/?share_basket=test');
 }finally{globalThis.fetch=original;}
});
