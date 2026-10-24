const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matchLarkContacts } = require('./public/lark-contact-matching');
const contacts = require('./lark-contacts-import-latest.json').contacts;
test('match full names even when a contact has trailing emoji and nickname', () => {
  assert.equal(matchLarkContacts('เอกภพ เงินคำ', contacts)[0].userId, '1e925b36');
});
test('match unique short names and nicknames', () => {
  assert.equal(matchLarkContacts('อำพล', contacts)[0].userId, '17e23293');
  assert.equal(matchLarkContacts('มาย', contacts)[0].userId, '4fc2f59c');
});
test('do not infer changed full names or shared-resource owners', () => {
  assert.equal(matchLarkContacts('พัทธนันท์ นาเดียร์ (นาเดียร์ )', contacts).length, 0);
  assert.equal(matchLarkContacts('ทีม admin', contacts).length, 0);
});
test('ambiguous short names stay ambiguous rather than selecting the first person', () => {
  const candidates = matchLarkContacts('มาย', [
    {name:'คนหนึ่ง (มาย)',userId:'1',status:'Active'},
    {name:'คนสอง (มาย)',userId:'2',status:'Active'}
  ]);
  assert.equal(candidates.length, 2);
});
