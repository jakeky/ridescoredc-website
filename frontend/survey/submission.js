// Changes when the survey is reopened, so an older request cannot change the new form.
let surveySubmissionVersion = 0;

function resetSurveySubmission() {
  surveySubmissionVersion++;
  const btn = document.getElementById('ss-submit-btn');
  btn.disabled = false;
  btn.textContent = 'Submit';
  const error = document.getElementById('ss-submit-error');
  error.hidden = true;
  error.textContent = '';
}

/* The map and the stored response identify a road differently, on purpose.
   tile_id numbers the segments of one build and is what MapLibre feature-state
   needs; it means nothing once the road data is rebuilt. segment_id belongs to
   the street and is what a response is stored against. selectedSegments already
   holds each chosen feature's properties, which carry both. */
function segmentIdsFor(tileIds) {
  return tileIds
    .map(id => {
      const props = selectedSegments.get(id)
                 || selectedSegments.get(Number(id))
                 || selectedSegments.get(String(id));
      return props && props.segment_id;
    })
    .filter(Boolean);
}

async function submitSurvey() {
  const btn = document.getElementById('ss-submit-btn');
  if (btn.disabled || !validateSummary()) return;

  const payload = {
    segment_ids: segmentIdsFor(strokeOrderedSegmentIds),
    contiguous_segments: surveySegments.map((seg, i) => ({
      sequence_index: i,
      route_name: seg.route_name,
      segment_ids: segmentIdsFor(seg.tile_ids),
      lts_perceived: surveyAnswers[i].lts_perceived,
      safety_rating: surveyAnswers[i].safety_rating,
      stress_factors: (surveyAnswers[i].stress_factors && surveyAnswers[i].stress_factors.length)
        ? surveyAnswers[i].stress_factors : null,
    })),
    time_of_day:          sumTime,
    overall_satisfaction: sumSat,
    would_ride_again:     sumRideAgain,
    trip_purpose:         sumTripPurpose,
    comments:             document.getElementById('ss-comments').value.trim() || null,
  };

  const version = ++surveySubmissionVersion;
  const error = document.getElementById('ss-submit-error');
  error.hidden = true;
  error.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (typeof data.submission_id !== 'string' || !data.submission_id.trim()) {
      throw new Error('Missing submission ID');
    }
    if (version !== surveySubmissionVersion) return;
    console.log('Submission accepted:', data.submission_id);
    document.getElementById('ss-summary').classList.remove('visible');
    document.getElementById('ss-confirm').classList.add('visible');
  } catch (err) {
    console.error('Submission error:', err);
    if (version !== surveySubmissionVersion) return;
    error.textContent = "We couldn't confirm your response was saved. Your answers are still here. Please try again.";
    error.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Submit';
  } finally {
    clearTimeout(timer);
  }
}
