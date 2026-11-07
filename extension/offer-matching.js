/** Data-only product matching. Never invent a price or a product. */
export function tokenize(s) {
  const aliases={яйца:'яйцо',яиц:'яйцо',бананы:'банан',огурцы:'огурец',помидоры:'томат',томаты:'томат',молока:'молоко'};
  return String(s||'').toLowerCase().normalize('NFKC').match(/[\p{L}\d]+/gu)?.map(t=>aliases[t]||t)||[];
}
export function relevance(query, name) {
  const q=tokenize(query), n=tokenize(name);
  if(!q.length) return 0;
  return q.filter(qt=>n.some(nt=>nt===qt || (qt.length>=4&&nt.startsWith(qt)) || (nt.length>=4&&qt.startsWith(nt)))).length/q.length;
}
function unitPack(name) {
  const match=String(name).toLowerCase().replaceAll('\u00a0',' ').match(/(\d+(?:[.,]\d+)?)\s*(кг|г|мл|л|шт)(?=$|[\s,.)])/);
  if(!match)return null;
  const quantity=Number(match[1].replace(',','.'));
  const unit=match[2];
  return unit==='кг'?{quantity:quantity*1000,unit:'г'}:unit==='л'?{quantity:quantity*1000,unit:'мл'}:{quantity,unit};
}
export function normalizedOffers({providerId,item,cards}) {
  if(!Array.isArray(cards))return [];
  return cards.slice(0,80).flatMap((c,index)=>{
    const score=relevance(item.query,c.name);
    const price=Number(c.priceKopecks);
    if(score<0.42||!Number.isSafeInteger(price)||price<=0||price>100_000_000)return [];
    const pack=unitPack(c.name);const needed=item.needed;
    const matchesSize=!needed || (pack && pack.unit===needed.unit && pack.quantity>0);
    const packages=needed&&matchesSize?Math.ceil(needed.quantity/pack.quantity):1;
    if(packages>30 || packages<1)return [];
    return [{requestedId:item.id,storeId:providerId,sku:`chrome-${providerId}-${index}-${item.id}`,
      name:String(c.name).slice(0,200),priceKopecks:price,packages,matchScore:score,
      exactMatch:tokenize(c.name).join(' ')===tokenize(item.query).join(' '),
      unitWarning:!!needed&&!matchesSize,url:c.url||null,source:`Chrome: ${providerId}`}];
  }).sort((a,b)=>b.matchScore-a.matchScore || a.priceKopecks-b.priceKopecks).slice(0,6);
}
