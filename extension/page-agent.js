/* GroceryBot content helper: operates only on the open shop page. No requests, cookies or payments. */
(() => {
  const SEARCH_WORDS = /(?:поиск|искать|найти|search|по товарам|найдите товар|название товара|продукт)/i;
  const DANGEROUS = /(?:корзин|оплат|оформ|заказ|купить|удалить|clear|checkout|cart|pay|logout|выйти)/i;
  const trim = s => String(s || '').replace(/[\s\u00a0\u202f\u2009]+/g, ' ').trim();
  const visible = node => {
    if (!node || !node.isConnected || node.closest?.('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && node.getClientRects().length > 0;
  };
  const all = selector => {
    const list = [...document.querySelectorAll(selector)];
    // Open shadow roots only. Do not traverse closed roots or cross-origin frames.
    const roots = [document];
    for (let i = 0; i < roots.length && i < 60; i++) {
      for (const element of roots[i].querySelectorAll('*')) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        if (roots.length >= 60) break;
      }
    }
    for (const root of roots.slice(1)) list.push(...root.querySelectorAll(selector));
    return [...new Set(list)];
  };
  const inputLabel = input => trim([
    input.getAttribute('placeholder'), input.getAttribute('aria-label'), input.getAttribute('name'),
    input.getAttribute('id'), input.getAttribute('data-testid'), input.closest('label')?.innerText,
    input.labels ? [...input.labels].map(x => x.innerText).join(' ') : ''
  ].join(' '));
  function findInput() {
    const inputs = all('input, [role="searchbox"], [contenteditable="true"]');
    const ranked = inputs.filter(x => visible(x) && !x.disabled && !x.readOnly &&
      !/^(?:password|email|tel|number|checkbox|hidden|radio)$/i.test(x.type||'') &&
      !x.closest('[role="dialog"][aria-label*="Адрес"], [class*="payment"], [class*="checkout"]'))
      .map(x => ({node:x, priority:(x.type==='search'?8:0) + (x.getAttribute('role')==='searchbox'?8:0)
        + (SEARCH_WORDS.test(inputLabel(x))?7:0) + (/поиск|search/i.test(inputLabel(x))?4:0)
        - (/(?:адрес|город|промокод|купон|телефон|email|логин|корзина|скидка)/i.test(inputLabel(x))?20:0)}))
      .filter(x => x.priority >= 7).sort((a,b)=>b.priority-a.priority);
    return ranked[0]?.node || null;
  }
  function openerLabel(node) {
    return trim([node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('data-testid'),
      node.getAttribute('data-qa'), node.getAttribute('name'), node.innerText?.slice(0,80),
      [...node.querySelectorAll('svg, img')].slice(0,2).map(e => [e.getAttribute('aria-label'),e.getAttribute('data-testid'),e.getAttribute('class'),e.getAttribute('alt')].join(' ')).join(' ')].join(' '));
  }
  function findOpener() {
    const clickable = all('button, [role="button"], a[aria-label], a[title], [tabindex="0"]');
    return clickable.filter(x => visible(x) && !x.disabled && !x.closest('[role="dialog"]'))
      .map(x => ({node:x, label:openerLabel(x)}))
      .filter(x => SEARCH_WORDS.test(x.label) && !DANGEROUS.test(x.label) && x.label.length < 210 && (
        /поиск|искать|найти|search/i.test(x.node.getAttribute('aria-label')||x.node.getAttribute('title')||x.node.getAttribute('data-testid')||x.node.getAttribute('class')||'') ||
        /^(?:поиск|найти|искать|search|по товарам)\s*$/i.test(trim(x.node.innerText)) ||
        /search/i.test([...x.node.querySelectorAll('svg')].map(e=>e.getAttribute('class')||'').join(' '))
      ))
      .sort((a,b) => (/поиск|search/i.test(a.label)?-1:0) - (/поиск|search/i.test(b.label)?-1:0))[0]?.node||null;
  }
  const delay = ms => new Promise(resolve=>setTimeout(resolve, ms));
  async function search(term) {
    if (typeof term !== 'string' || term.trim().length < 2 || term.length > 100) return {submitted:false,reason:'Некорректный запрос'};
    const requested = term.trim();
    if (/(?:captcha|доступ ограничен|access denied|проверка браузера|вы не робот)/i.test((document.body?.innerText||'').slice(0,1000)))
      return {submitted:false,reason:'Магазин запросил проверку браузера'};
    let input=findInput();let opened=false;
    if (!input) {
      const opener=findOpener();
      if(opener){ opener.click(); opened=true;
        for(let i=0;i<8 && !input;i++) {await delay(300);input=findInput();}
      }
    }
    if(!input)return {submitted:false,opened,reason: opened ? 'Поиск открылся, но текстовое поле не появилось' : 'Кнопка и поле поиска не найдены на этой странице'};
    input.focus();
    if(input.isContentEditable){ input.textContent=requested;input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:requested}));}
    else {
      const proto=input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      if(setter) setter.call(input,requested); else input.value=requested;
      input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:requested}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    await delay(450);
    // Prefer an actual search button. Never click cart or checkout controls.
    const form=input.closest('form');
    const submits=(form ? [...form.querySelectorAll('button, input[type="submit"]')] : all('button[type="submit"], [role="button"]'))
      .filter(x=>visible(x) && !x.disabled && SEARCH_WORDS.test(openerLabel(x)) && !DANGEROUS.test(openerLabel(x)));
    if(submits[0])submits[0].click();
    else if(form && typeof form.requestSubmit==='function') form.requestSubmit();
    else {
      input.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter',keyCode:13,which:13}));
      input.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter',code:'Enter',keyCode:13,which:13}));
    }
    return {submitted:true,opened,inputLabel:inputLabel(input).slice(0,100),url:location.href};
  }
  function parsePrice(raw) {
    const text=trim(raw);
    // Russian prices can be written as "199 99 ₽" (separate rubles/kopecks).
    const spaced=text.match(/(?:^|\D)(\d{1,5})\s+(\d{2})\s*(?:₽|руб)/i);
    const decimal=text.match(/(?:^|\D)(\d{1,5}(?:\s\d{3})*(?:[,.]\d{1,2})?)\s*(?:₽|руб)/i);
    if(!spaced&&!decimal){
      if(/^\d{1,6}(?:[.,]\d{1,2})?$/.test(text))return Math.round(Number(text.replace(',','.'))*100);
      return null;
    }
    if(decimal && (!spaced || decimal.index <= spaced.index))return Math.round(Number(decimal[1].replace(/\s/g,'').replace(',','.'))*100);
    return Number(spaced[1])*100+Number(spaced[2]);
  }
  const PRICE_RE = /\d{1,5}(?:(?:[ \u00a0\u202f\u2009]\d{3})|(?:[,.]\d{1,2}))?\s*(?:₽|руб(?:лей|ля|\.)?)/i;
  function cleanupName(text) {
    let name=trim(text).replace(/(?:В корзину|Добавить в корзину|Подробнее|Купить|Поделиться).*$/i,'');
    // If price precedes the title (Magnit), strip the entire promotion/price prefix.
    if(/^(?:финальная цена|[+\-]?\d+%\s+с\s+премиум|только у нас|по карте|скидка)/i.test(name)){
      const match=name.match(PRICE_RE);
      if(match)name=trim(name.slice(match.index+match[0].length));
    }
    name=name.replace(/\b(?:\d[,.]\d{1,2}\s*[·•]\s*\d+\s*отзыв[а-я]*).*$/i,'')
      .replace(/\s+(?:\d[,.]\d\s*[·•]\s*\d+.*)$/,'')
      .replace(/\s+Цена\s+\d+.*$/i,'');
    return trim(name).slice(0,185);
  }
  function titleOf(card, fallback) {
    const selectors = ['[itemprop="name"]','[data-testid*="product-name"]','[data-testid*="product-title"]',
      '[class*="ProductName"]','[class*="productName"]','[class*="product-name"]','[class*="ProductTitle"]',
      '[class*="product-title"]','h3','h2','h4','a[title]','img[alt]'];
    for(const s of selectors) {
      const node=card.querySelector(s);
      const title=cleanupName(node?.getAttribute?.('title')||node?.getAttribute?.('alt')||node?.innerText||'');
      if(title.length>=4 && title.length<=185 && !/^(?:каталог|поиск|показать|акции|рецепты|в корзину|финальная цена|скидки)$/i.test(title))return title;
    }
    const links=[...card.querySelectorAll('a[href]')].filter(x=>x.getAttribute('href')?.match(/(?:product|goods|item|catalog)/));
    for(const link of links) {const title=cleanupName(link.getAttribute('title')||link.innerText||'');if(title.length>=5&&title.length<=160&&!PRICE_RE.test(title))return title;}
    const stripped=cleanupName(fallback);
    const firstPrice=stripped.search(PRICE_RE);
    if(firstPrice>2){
      const before=trim(stripped.slice(0,firstPrice));
      if(before.length>6&&!/^(?:финальная цена|по карте|скидка|\+\d+%)/i.test(before))return before.slice(0,185);
    }
    return stripped;
  }
  function candidateCards() {
    const selectors = [
      '[itemtype*="schema.org/Product"]','[itemtype*="/Product"]','[data-testid*="product-card"]','[data-qa*="product-card"]',
      '[class*="ProductCard"]','[class*="product-card"]','[class*="ProductItem"]','[class*="product-item"]',
      '[class*="productCard"]','[class*="productItem"]','article:has(a[href])',
      'li:has(a[href*="product"])','a[href*="/product/"]','a[href*="/goods/"]','a[href*="/cat/d/"]','a[href*="/item/"]'
    ];
    return [...new Set(selectors.flatMap(s=>{try{return all(s).slice(0,180)}catch{return []}}))].slice(0,240);
  }
  function scan() {
    const bodyText=(document.body?.innerText||'').slice(0,2000);
    if(/captcha|подтвердите, что вы не робот|access denied|forbidden|проверка браузера/i.test(bodyText))return {cards:[],blocked:true,reason:'Магазин требует проверку браузера'};
    const cards=[],seen=new Set();
    for(const n of candidateCards()) {
      const card=n.matches('a')?(n.closest('article,li,[data-testid*="product"],[class*="ProductCard"],[class*="product-card"]')||n):n;
      if(!visible(card))continue;
      const text=trim(card.innerText||'').slice(0,950);
      if(text.length<8||text.length>550||!PRICE_RE.test(text))continue;
      // Skip entire grid wrappers with several products.
      if((text.match(/(?:В корзину|Добавить в корзину)/gi)||[]).length>2)continue;
      const priceElements=[...card.querySelectorAll('[itemprop="price"], [data-testid*="price"], [class*="CurrentPrice"], [class*="currentPrice"], [class*="price-current"]')];
      const price = priceElements.map(e => parsePrice(e.getAttribute('content')||e.innerText))
        .find(p=>Number.isSafeInteger(p)&&p>=100&&p<=10_000_000) || parsePrice(text);
      if(!Number.isSafeInteger(price)||price<100||price>10_000_000)continue;
      const name=titleOf(card,text);
      if(name.length<4 || /(?:\bв корзину\b|\bзаказ\b)/i.test(name))continue;
      const link=(card.matches('a')?card:card.querySelector('a[href*="/product/"], a[href*="/goods/"], a[href*="/item/"], a[href]'));
      let url=location.href;
      try{if(link?.href && new URL(link.href,location.href).hostname===location.hostname)url=new URL(link.href,location.href).href;}catch{}
      const fingerprint=(name+'|'+price).toLowerCase();if(seen.has(fingerprint))continue;seen.add(fingerprint);
      cards.push({name,priceKopecks:price,url});if(cards.length>=50)break;
    }
    return {cards,blocked:false,pageTitle:document.title,location:location.href};
  }
  globalThis.__groceryDomAgent={search,scan,parsePrice,cleanupName,probe:()=>({hasInput:!!findInput(),hasOpener:!!findOpener(),location:location.href})};
})();
