import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from '../server.js';

const key='abcdef0123456789'.repeat(4);
test('website and extension can exchange one bounded task through server HTTP',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const call=async (endpoint,body)=>{
    const response=await fetch(`http://127.0.0.1:${port}/api/bridge/${endpoint}`,{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {response,result:await response.json()};
  };
  try {
    const health=await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal((await health.json()).version,'0.4.0');
    assert.equal((await call('open',{key})).result.connected,true);
    assert.equal((await call('connect',{key})).result.connected,true);
    const queue=(await call('queue',{key,providers:['magnit'],items:[{id:'i0',query:'молоко'}]})).result;
    assert.equal(queue.queued,1);
    const task=(await call('pull',{key})).result.job;
    assert.equal(task.providerId,'magnit');
    const finished=await call('complete',{key,providerId:'magnit',jobId:task.id,status:'done',offers:[
      {requestedId:'i0',name:'Молоко 1 л',storeId:'magnit',sku:'sku',priceKopecks:9900,unitWarning:false}
    ]});
    assert.equal(finished.result.offers,1);
    assert.equal(finished.response.headers.get('access-control-allow-origin'),'*');
    const status=(await call('status',{key})).result;
    assert.equal(status.jobs[0].offers[0].priceKopecks,9900);
    assert.equal((await call('pull',{key})).result.job,null);
    const options=await fetch(`http://127.0.0.1:${port}/api/bridge/queue`,{method:'OPTIONS',headers:{Origin:'chrome-extension://abc','Access-Control-Request-Method':'POST'}});
    assert.equal(options.status,204);
    assert.equal(options.headers.get('access-control-allow-origin'),'*');
  } finally {await new Promise(resolve=>server.close(resolve));}
});
