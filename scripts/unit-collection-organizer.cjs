'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const organizer = require('../main/collectionOrganizer');

function item(id, dir, description = `description ${id}`) {
  return { id, dir: path.resolve(dir), name: id, description, productId: 'p', scope: 'global', parentId: '', nested: false };
}

test('common directories permit subdirectories and never cross product boundaries', () => {
  const base = path.join('fixture', 'skills');
  const data = [item('a', path.join(base, 'suite', 'a')), item('b', path.join(base, 'suite', 'sub', 'b')),
    { ...item('c', path.join(base, 'suite', 'c')), productId: 'other' }];
  const result = organizer.candidates(data);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].items.map(x => x.id), ['a', 'b']);
  assert.equal(result[0].dir, path.resolve(base, 'suite'));
});

test('AI result is reviewed, persisted, restored and invalidated when descriptions change', async () => {
  const base = path.join('fixture', 'skills', 'suite');
  const data = ['a', 'b', 'c'].map(id => item(id, path.join(base, id)));
  const preview = await organizer.propose(data, async (messages, options) => {
    assert.equal(options.json, true);
    assert.match(messages[1].content, /description a/);
    return { content: JSON.stringify({ groups: [{ name: '一组', ids: ['a', 'b'], reason: '用途相关' }] }) };
  });
  assert.equal(preview.count, 3);
  const decisions = organizer.decisionsFor(preview, data);
  const rescanned = data.map(s => ({ ...s, nested: true, collectionId: 'heuristic' }));
  organizer.applyDecisions(rescanned, decisions);
  assert.equal(rescanned[0].collectionId, preview.groups[0].id);
  assert.equal(rescanned[2].collectionId, '');
  const changed = rescanned.map(s => ({ ...s }));
  changed[1].description = 'changed';
  organizer.applyDecisions(changed, decisions);
  assert.equal(changed[0].collectionId, '');
  assert.equal(changed[1].collectionId, '');
  assert.throws(() => organizer.decisionsFor(preview, changed), /已变化/);
});

test('unknown, duplicate and malformed AI membership is rejected', async () => {
  const data = ['a', 'b'].map(id => item(id, path.join('fixture', 'skills', 'suite', id)));
  for (const groups of [
    [{ name: 'bad', ids: ['a', 'missing'] }],
    [{ name: 'bad', ids: ['a', 'a'] }],
    [{ name: 'bad', ids: ['a'] }]
  ]) {
    await assert.rejects(organizer.propose(data, async () => ({ content: JSON.stringify({ groups }) })));
  }
});

test('skills without descriptions remain ungrouped without sending an AI request', async () => {
  const data = ['a', 'b'].map(id => item(id, path.join('fixture', 'skills', 'suite', id), ''));
  const preview = await organizer.propose(data, async () => { throw new Error('must not call'); });
  assert.equal(preview.count, 2);
  assert.deepEqual(preview.groups, []);
  assert.equal(organizer.decisionsFor(preview, data).a.group, null);
});
