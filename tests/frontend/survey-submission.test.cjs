const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the same plain script the page loads, with only the browser and network
// boundaries replaced. No map service, database, or extra test package is needed.
const source = fs.readFileSync(path.join(__dirname, '../../frontend/survey/submission.js'), 'utf8');
const accepted = () => ({ok: true, json: async () => ({submission_id: 'accepted-id'})});

function setup(fetchImpl = accepted) {
  const elements = Object.fromEntries(['ss-submit-btn', 'ss-submit-error', 'ss-comments', 'ss-summary', 'ss-confirm'].map(id => [id, {
    disabled: false, hidden: true, textContent: '', value: '  My ride  ',
    classList: new Set(id === 'ss-summary' ? ['visible'] : []),
  }]));
  for (const element of Object.values(elements)) element.classList.remove = element.classList.delete;
  const calls = [], cleared = [];
  let timeout;
  const context = vm.createContext({
    document: {getElementById: id => {assert.ok(elements[id], id); return elements[id];}},
    selectedSegments: new Map([[11, {segment_id: 'road-a'}]]),
    strokeOrderedSegmentIds: [11],
    surveySegments: [{route_name: 'Test Street', tile_ids: [11]}],
    surveyAnswers: [{lts_perceived: 2, safety_rating: 7, stress_factors: []}],
    sumTime: 'Morning', sumSat: 4, sumRideAgain: 'yes', sumTripPurpose: null,
    validateSummary: () => true,
    fetch: async (...args) => {calls.push(args); return fetchImpl(...args);},
    AbortController,
    setTimeout: callback => {timeout = callback; return 1;},
    clearTimeout: id => cleared.push(id),
    console: {log() {}, error() {}},
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run('resetSurveySubmission()');
  return {elements, context, calls, cleared, submit: () => run('submitSurvey()'), reset: () => run('resetSurveySubmission()'), expire: () => timeout()};
}

function assertRetryable(s) {
  assert.equal(s.elements['ss-summary'].classList.has('visible'), true);
  assert.equal(s.elements['ss-confirm'].classList.has('visible'), false);
  assert.equal(s.elements['ss-submit-error'].hidden, false);
  assert.match(s.elements['ss-submit-error'].textContent, /couldn't confirm.*saved/);
  assert.equal(s.elements['ss-submit-btn'].disabled, false);
  assert.equal(s.elements['ss-submit-btn'].textContent, 'Submit');
  assert.equal(s.elements['ss-comments'].value, '  My ride  ');
  assert.equal(s.context.surveyAnswers[0].safety_rating, 7);
}

test('accepted response shows confirmation and sends durable road IDs', async () => {
  const s = setup();
  await s.submit();
  assert.equal(s.elements['ss-summary'].classList.has('visible'), false);
  assert.equal(s.elements['ss-confirm'].classList.has('visible'), true);
  assert.equal(s.elements['ss-submit-error'].hidden, true);
  assert.equal(s.calls[0][0], '/api/submissions');
  assert.equal(s.calls[0][1].method, 'POST');
  const payload = JSON.parse(s.calls[0][1].body);
  assert.deepEqual(payload.segment_ids, ['road-a']);
  assert.deepEqual(payload.contiguous_segments[0].segment_ids, ['road-a']);
  assert.equal(payload.comments, 'My ride');
  assert.deepEqual(s.cleared, [1]);
});

for (const status of [422, 500, 503]) {
  test(`HTTP ${status} preserves answers and allows a successful retry`, async () => {
    let attempt = 0;
    const s = setup(() => ++attempt === 1 ? {ok: false, status} : accepted());
    await s.submit();
    assertRetryable(s);
    await s.submit();
    assert.equal(s.calls.length, 2);
    assert.equal(s.elements['ss-confirm'].classList.has('visible'), true);
    assert.equal(s.elements['ss-submit-error'].hidden, true);
    assert.deepEqual(s.cleared, [1, 1]);
  });
}

for (const [name, response] of [
  ['network failure', () => {throw new TypeError('Failed to fetch');}],
  ['invalid JSON', () => ({ok: true, json: async () => {throw new SyntaxError('Invalid JSON');}})],
  ['missing submission ID', () => ({ok: true, json: async () => ({})})],
]) {
  test(`${name} keeps the form available`, async () => {
    const s = setup(response);
    await s.submit();
    assertRetryable(s);
    assert.deepEqual(s.cleared, [1]);
  });
}

test('timeout aborts the request and keeps answers for retry', async () => {
  const s = setup((url, {signal}) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Request timed out')));
  }));
  const pending = s.submit();
  s.expire();
  await pending;
  assert.equal(s.calls[0][1].signal.aborted, true);
  assertRetryable(s);
  assert.deepEqual(s.cleared, [1]);
});

test('incomplete summary does not send a request', async () => {
  const s = setup();
  s.context.validateSummary = () => false;
  await s.submit();
  assert.equal(s.calls.length, 0);
  assert.equal(s.elements['ss-submit-btn'].disabled, false);
});

test('repeated submit while pending sends only one request', async () => {
  let resolve;
  const s = setup(() => new Promise(r => {resolve = r;}));
  const first = s.submit();
  assert.equal(s.elements['ss-submit-btn'].disabled, true);
  await s.submit();
  assert.equal(s.calls.length, 1);
  resolve(accepted());
  await first;
});

for (const ok of [true, false]) {
  test(`reopening the survey ignores an older ${ok ? 'success' : 'failure'}`, async () => {
    let resolve;
    const s = setup(() => new Promise(r => {resolve = r;}));
    const pending = s.submit();
    s.reset();
    resolve(ok ? accepted() : {ok: false, status: 500});
    await pending;
    assert.equal(s.elements['ss-confirm'].classList.has('visible'), false);
    assert.equal(s.elements['ss-submit-error'].hidden, true);
    assert.equal(s.elements['ss-submit-btn'].disabled, false);
    assert.deepEqual(s.cleared, [1]);
  });
}
