import {test} from 'node:test';
import assert from 'node:assert/strict';
import {learnSearchTemplate,learnedSearchUrl} from '../extension/search-templates.js';

test('learns site-specific query parameter and substitutes next product',()=>{
  const learned=learnSearchTemplate('https://www.perekrestok.ru/search?query=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE&ref=utm','молоко','perekrestok');
  assert.equal(learned,'https://www.perekrestok.ru/search?query=__GROCERYBOT_SEARCH_TERM__');
  assert.equal(learnedSearchUrl(learned,'яйца','perekrestok'),'https://www.perekrestok.ru/search?query=%D1%8F%D0%B9%D1%86%D0%B0');
});
test('retains safe store ID locally while removing sensitive address and token params',()=>{
 const learned=learnSearchTemplate('https://5ka.ru/search/?q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE&address=%D1%83%D0%BB%D0%B8%D1%86%D0%B0&token=abc123&store_id=4321','молоко','5ka');
 assert.equal(learnedSearchUrl(learned,'кефир','5ka'),'https://5ka.ru/search/?q=%D0%BA%D0%B5%D1%84%D0%B8%D1%80&store_id=4321');
 assert.ok(!learned.includes('abc123'));assert.ok(!learned.includes('address'));
});
test('accepts search terms in URL path and blocks other sites',()=>{
 const learned=learnSearchTemplate('https://eda.yandex.ru/search/%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE','молоко','yandex_eda');
 assert.equal(learnedSearchUrl(learned,'яйца','yandex_eda'),'https://eda.yandex.ru/search/%D1%8F%D0%B9%D1%86%D0%B0');
 assert.throws(()=>learnSearchTemplate('https://evil.example/search?q=молоко','молоко','5ka'),/поддерживаемом/);
 assert.throws(()=>learnedSearchUrl('https://evil.example/search?q=__GROCERYBOT_SEARCH_TERM__','кефир','5ka'),/не принадлежит/);
});
test('shows actionable message if browser does not expose searched term in URL',()=>{
 assert.throws(()=>learnSearchTemplate('https://kuper.ru/','молоко','kuper'),/Диагностика/);
});
