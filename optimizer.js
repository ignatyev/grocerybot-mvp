/** Pure basket optimizer: figures in integer kopecks, no guessed shipping fees. */
export const MIN_SAVINGS = 30000;

export function selectPlan(single, split, minSavings = MIN_SAVINGS) {
  if (!single && !split) return null;
  if (!single) return { ...split, reason: 'Только две доставки покрывают весь список' };
  if (split && single.totalKopecks - split.totalKopecks >= minSavings) {
    return { ...split, reason: `Две доставки экономят ${(single.totalKopecks - split.totalKopecks) / 100} ₽` };
  }
  return { ...single, reason: split ? 'Экономия от разделения меньше 300 ₽' : 'Полный заказ из одного магазина' };
}

/**
 * Each item: {id, query, offers:[{storeId, sku, name, priceKopecks, packages, matchScore, ...}]}.
 * Each store: {id, name, deliveryKopecks: number|null, minOrderKopecks, freeDeliveryFromKopecks?}
 * Null deliveryKopecks means cost is unknown: do not rank it as a valid full-price plan.
 * Up to 2 stores and at most 12 items for exact exhaustive search; beyond use beam search.
 */
export function optimize(items, stores, {maxDeliveries=2,minSplitSavingsKopecks=MIN_SAVINGS, allowSubstitutions=true}={}) {
  const configured = new Map(stores.map(s => [s.id, s]));
  const filtered = items.map(item => ({...item, offers: (item.offers || []).filter(o =>
    configured.has(o.storeId) && Number.isInteger(o.priceKopecks) && o.priceKopecks >= 0 &&
    (allowSubstitutions || o.exactMatch) && o.unitWarning!==true && o.matchScore >= 0.42
  )}));
  const missing = filtered.filter(i => !i.offers.length).map(i => i.query);
  if (missing.length || !filtered.length) return {status:'INCOMPLETE', missing, bestSingle:null,bestSplit:null,selected:null};
  const feasible = stores.filter(s=>Number.isInteger(s.deliveryKopecks) && s.deliveryKopecks >= 0);
  const unquoted = stores.filter(s=>!Number.isInteger(s.deliveryKopecks)).map(s=>s.name);
  const bestByPair = [];
  const evaluation = (chosen, pair) => {
    const grouped = new Map();
    for (const offer of chosen) {
      if (!grouped.has(offer.storeId)) grouped.set(offer.storeId, []);
      grouped.get(offer.storeId).push(offer);
    }
    const baskets = [];
    for (const [storeId, entries] of grouped) {
      const store = configured.get(storeId);
      const products = entries.reduce((s,o)=>s+o.priceKopecks*o.packages,0);
      if (products < (store.minOrderKopecks || 0)) return;
      const shipping = store.freeDeliveryFromKopecks != null && products >= store.freeDeliveryFromKopecks ? 0 : store.deliveryKopecks;
      baskets.push({storeId,storeName:store.name,items:entries,productsKopecks:products,
        deliveryKopecks:shipping,feesKopecks:store.feesKopecks||0,
        totalKopecks:products + shipping + (store.feesKopecks||0)});
    }
    if (baskets.length!==pair.length || baskets.length>maxDeliveries) return;
    const totalKopecks=baskets.reduce((s,b)=>s+b.totalKopecks,0);
    const candidate={totalKopecks,baskets,deliveries:baskets.length};
    const prev=bestByPair.find(p=>p.key===pair.join('|'));
    if (!prev || candidate.totalKopecks < prev.plan.totalKopecks) {
      if(prev) prev.plan=candidate;
      else bestByPair.push({key:pair.join('|'),plan:candidate});
    }
  };
  const maxStores=Math.min(2,maxDeliveries);
  for(let i=0;i<feasible.length;i++) {
    for(let j=i;j<feasible.length && (j===i || maxStores===2);j++) {
      const pair=j===i?[feasible[i].id]:[feasible[i].id,feasible[j].id];
      const choices=filtered.map(item=>item.offers.filter(o=>pair.includes(o.storeId)));
      if (choices.some(x=>!x.length)) continue;
      // One lowest-price *acceptable* SKU per store and item. Keeps exact allocation to <= 2^12 states.
      // A full retail-grade solver can later include variant-level constraints and bundles.
      const candidates = choices.map(offers=>pair.flatMap(id=>{
        const available = offers.filter(o=>o.storeId===id).sort((a,b)=>a.priceKopecks*a.packages-b.priceKopecks*b.packages);
        return available.length ? [available[0]] : [];
      }));
      if (filtered.length<=12) {
        const cur=[];
        const enumerate=(idx)=>{
          if(idx===candidates.length) { evaluation(cur,pair);return; }
          for(const offer of candidates[idx]) {cur.push(offer);enumerate(idx+1);cur.pop();}
        };
        enumerate(0);
      } else {
        // Bounded search for larger lists; flag result approximate.
        let beam=[{cost:0, chosen:[]}];
        for(const offers of candidates) {
          beam=beam.flatMap(x=>offers.map(o=>({cost:x.cost+o.priceKopecks*o.packages,chosen:[...x.chosen,o]})))
            .sort((a,b)=>a.cost-b.cost).slice(0,400);
        }
        for(const state of beam) evaluation(state.chosen,pair);
      }
    }
  }
  const plans=bestByPair.map(x=>x.plan);
  const bestSingle=plans.filter(p=>p.deliveries===1).sort((a,b)=>a.totalKopecks-b.totalKopecks)[0]||null;
  const bestSplit=plans.filter(p=>p.deliveries===2).sort((a,b)=>a.totalKopecks-b.totalKopecks)[0]||null;
  const selected=selectPlan(bestSingle,bestSplit,minSplitSavingsKopecks);
  return {status:selected?'OK':'NO_FEASIBLE_QUOTE',bestSingle,bestSplit,selected,unquotedStores:unquoted,
    approximate:filtered.length>12, missing:[]};
}
