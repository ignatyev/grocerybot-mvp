/*
 * User-taught search routes. Kept in Chrome extension local storage only.
 * Search templates deliberately omit authentication, address and tracking parameters.
 */
const QUERY_MARKER = '__GROCERYBOT_SEARCH_TERM__';
const SEARCH_KEYS = new Set(['q', 'query', 'search', 'searchtext', 'searchterm', 'text', 'keyword', 'keywords', 'term', 'phrase', 'searchquery', 'querytext']);
const CONTEXT_KEYS = new Set(['storeid', 'store_id', 'regionid', 'region_id', 'shopid', 'shop_id', 'cityid', 'city_id']);
const ALLOWED = Object.freeze({
  magnit: ['magnit.ru'], '5ka': ['5ka.ru'], perekrestok: ['perekrestok.ru'],
  vkusvill: ['vkusvill.ru'], kuper: ['kuper.ru'], yandex_eda: ['eda.yandex.ru']
});
function hostMatches(provider, hostname) {
  return (ALLOWED[provider] || []).some(host => hostname === host || hostname.endsWith('.' + host));
}
function sameTerm(value, query) {
  return String(value).trim().toLocaleLowerCase('ru').normalize('NFKC') === String(query).trim().toLocaleLowerCase('ru').normalize('NFKC');
}
export function learnSearchTemplate(rawUrl, query, providerId) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100) throw new Error('Введите то же название товара, по которому вы искали на сайте');
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || !hostMatches(providerId, url.hostname) || url.username || url.password) {
    throw new Error('Откройте результаты поиска в поддерживаемом магазине');
  }
  // Only the query itself and safe shop/region IDs are stored; never keep tokens or address coordinates.
  const cleaned = new URL(url.origin + url.pathname);
  let found = false;
  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');
    if (sameTerm(value, query) && (SEARCH_KEYS.has(normalizedKey) || normalizedKey.includes('search'))) {
      cleaned.searchParams.set(key, QUERY_MARKER);
      found = true;
    } else if (CONTEXT_KEYS.has(key.toLowerCase()) && /^[a-z\d_-]{1,32}$/i.test(value)) {
      cleaned.searchParams.set(key, value);
    }
  }
  if (!found) {
    const fragments = url.pathname.split('/');
    for (let i=0;i<fragments.length;i++) {
      let decoded;
      try {decoded = decodeURIComponent(fragments[i]);} catch {continue;}
      if (sameTerm(decoded, query)) {fragments[i] = QUERY_MARKER;found = true;break;}
    }
    if (found) cleaned.pathname = fragments.join('/');
  }
  if (!found) throw new Error('Сайт не указал поисковый запрос в адресе страницы. Нажмите «Диагностика», чтобы настроить поиск по элементам страницы.');
  return cleaned.toString();
}
export function learnedSearchUrl(template, query, providerId) {
  if (typeof template !== 'string' || !template.includes(QUERY_MARKER)) throw new Error('Шаблон поиска не настроен');
  if (typeof query !== 'string' || query.length < 2 || query.length > 100) throw new Error('Некорректный запрос');
  const result = template.replaceAll(QUERY_MARKER, encodeURIComponent(query.trim()));
  const url = new URL(result);
  if(url.protocol !== 'https:' || !hostMatches(providerId, url.hostname) || url.username || url.password) {
    throw new Error('Адрес шаблона не принадлежит выбранному магазину');
  }
  return url.toString();
}

/** True only when the shop URL itself reflects this search. No full URL is sent to GroceryBot. */
export function searchTermInUrl(rawUrl, query, providerId) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || !hostMatches(providerId, url.hostname)) return false;
    for (const [key, value] of url.searchParams) {
      const normalized = key.toLowerCase().replace(/[-_]/g, '');
      if ((SEARCH_KEYS.has(normalized) || normalized.includes('search')) && sameTerm(value, query)) return true;
    }
    return url.pathname.split('/').some(segment => {
      try {return sameTerm(decodeURIComponent(segment), query);} catch {return false;}
    });
  } catch {return false;}
}
