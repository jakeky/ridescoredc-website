// Regression test for issue #24: a road could stay highlighted cyan ("being rated")
// after the rating panel was reopened, and nothing short of reloading the page
// removed it.
//
// The survey page is one HTML file with inline scripts, so this test reads the real
// panel functions out of it and runs them with the map and the page replaced by
// small stand-ins. No browser, map service, database or extra package is needed:
//   node --test tests/frontend/*.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/survey/index.html'), 'utf8');

// The functions that open, step through and close the rating panel.
const PANEL_FUNCTIONS = [
  'setSurveyActiveFeatureState', 'activateSurveySegment', 'segNext', 'openSurveyPanel', 'closeSurveySheet',
];

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() is no longer in frontend/survey/index.html; update this test`);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`could not find the end of ${name}()`);
}

function setup(route) {
  // tile_id -> feature state, kept the way MapLibre keeps it: each call merges.
  const featureState = new Map();
  const element = () => ({
    classList: { add() {}, remove() {}, contains: () => false },
    style: {}, value: '', disabled: false, textContent: '',
  });
  const context = vm.createContext({
    map: {
      setFeatureState(target, state) {
        featureState.set(target.id, { ...featureState.get(target.id), ...state });
      },
      resize() {},
    },
    document: { body: element(), getElementById: element, querySelectorAll: () => [] },
    // The panel waits for a CSS transition before highlighting; run it straight away.
    setTimeout: callback => callback(),

    // Page state the panel functions read and write.
    paintMode: false,
    unpaintMode: false,
    strokeOrderedSegmentIds: [1],
    surveySegments: [],
    surveyCur: 0,
    surveyAnswers: [],
    surveyActiveFids: new Set(),
    surveyShowSummary: false,
    sumTime: null, sumSat: null, sumRideAgain: null, sumTripPurpose: null,

    // The route as the map selection currently groups it.
    buildContiguousSegments: () => route.segments,

    // Drawing and map movement, not under test.
    fitMapToSegmentFids() {}, showSegmentPanel() {}, buildTrack() {}, renderQuestion() {},
    goToSummary() {}, togglePaintMode() {}, toggleUnpaintMode() {}, resetSurveySubmission() {},
  });
  vm.runInContext(PANEL_FUNCTIONS.map(extractFunction).join('\n'), context);
  return {
    run: code => vm.runInContext(code, context),
    highlighted: () => [...featureState]
      .filter(([, state]) => state.surveyActive)
      .map(([id]) => id)
      .sort((a, b) => a - b),
  };
}

test('Rate route pressed again on a later segment leaves nothing highlighted from before', () => {
  // Two streets painted: Rate route, Next segment, Rate route again, then close.
  const route = { segments: [{ route_name: 'A ST NW', tile_ids: [1] }, { route_name: 'B ST NW', tile_ids: [2] }] };
  const page = setup(route);

  page.run('openSurveyPanel()');
  assert.deepEqual(page.highlighted(), [1]);

  page.run('segNext()');
  assert.deepEqual(page.highlighted(), [2]);

  page.run('openSurveyPanel()');
  assert.deepEqual(page.highlighted(), [1], 'only the first street of the restarted panel should be highlighted');

  page.run('closeSurveySheet()');
  assert.deepEqual(page.highlighted(), [], 'closing the panel should leave no street highlighted');
});

test('Rate route pressed again after the route changed leaves nothing highlighted from the old route', () => {
  // Street A is being rated. With the panel open, A is erased and street B painted.
  const route = { segments: [{ route_name: 'A ST NW', tile_ids: [1] }] };
  const page = setup(route);

  page.run('openSurveyPanel()');
  assert.deepEqual(page.highlighted(), [1]);

  route.segments = [{ route_name: 'B ST NW', tile_ids: [2] }];
  page.run('openSurveyPanel()');
  assert.deepEqual(page.highlighted(), [2], 'the erased street should no longer be highlighted');

  page.run('closeSurveySheet()');
  assert.deepEqual(page.highlighted(), [], 'closing the panel should leave no street highlighted');
});
