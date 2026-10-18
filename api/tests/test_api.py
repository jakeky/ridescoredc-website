from copy import deepcopy
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from tests.conftest import make_mock_conn


VALID_PAYLOAD = {
    "segment_ids": ["110020210", "110020211", "110020212"],
    "contiguous_segments": [
        {
            "sequence_index": 0,
            "route_name": "Test Route",
            "segment_ids": ["110020210", "110020211", "110020212"],
            "lts_perceived": 2,
            "safety_rating": 7,
            "stress_factors": ["parked_cars"],
        }
    ],
    "time_of_day": "morning",
    "overall_satisfaction": 4,
    "would_ride_again": "yes",
    "trip_purpose": "commute",
    "comments": "Nice ride",
}


@pytest.fixture
def client():
    with patch("main.init_db"), patch("main.get_conn", return_value=make_mock_conn()):
        from main import app
        with TestClient(app) as c:
            yield c


# ── /health ──────────────────────────────────────────────────────────────────

def test_health_ok(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_db_down():
    with patch("main.init_db"), patch("main.get_conn", side_effect=Exception("connection refused")):
        from main import app
        with TestClient(app) as c:
            response = c.get("/health")
    assert response.status_code == 503


# ── /api/submissions ──────────────────────────────────────────────────────────

def test_submission_invalid_payload(client):
    response = client.post("/api/submissions", json={})
    assert response.status_code == 422


def test_submission_valid(client):
    response = client.post("/api/submissions", json=VALID_PAYLOAD)
    assert response.status_code == 201
    data = response.json()
    assert "submission_id" in data
    # verify it's a valid UUID shape
    assert len(data["submission_id"]) == 36


def test_submission_stores_durable_segment_ids():
    """The text segment_id is written, not a row number, and the response
    records which published road data those ids came from."""
    conn = make_mock_conn()
    with patch("main.init_db"), patch("main.get_conn", return_value=conn):
        from main import app
        with TestClient(app) as c:
            assert c.post("/api/submissions", json=VALID_PAYLOAD).status_code == 201

    written = [call.args for call in conn.cursor.return_value.execute.call_args_list]
    submission = next(a for a in written if "app.survey_submissions" in a[0])
    assert submission[1][1] == ["110020210", "110020211", "110020212"]
    assert submission[1][2] == "ridescoredc-data-preview@0.1"

    granular = [a for a in written if "app.survey_granular_segments" in a[0]]
    assert [a[1][1] for a in granular] == ["110020210", "110020211", "110020212"]


def test_submission_refused_when_no_road_data_loaded():
    """Without road data there is nothing the segment ids could refer to, so the
    response is refused rather than stored with an unknown provenance."""
    conn = make_mock_conn(package=None)
    with patch("main.init_db"), patch("main.get_conn", return_value=conn):
        from main import app
        with TestClient(app) as c:
            response = c.post("/api/submissions", json=VALID_PAYLOAD)
    assert response.status_code == 503


def test_submission_db_error():
    conn = make_mock_conn()
    conn.__exit__ = MagicMock(side_effect=Exception("db write failed"))
    with patch("main.init_db"), patch("main.get_conn", return_value=conn):
        from main import app
        with TestClient(app) as c:
            response = c.post("/api/submissions", json=VALID_PAYLOAD)
    assert response.status_code == 500


# Invalid surveys must be rejected before opening a database connection. Rating
# limits match api/migrations/0001_app_schema.sql; skipped ratings stay optional.
@pytest.mark.parametrize("field,value", [
    ("segment_ids", []),
    ("segment_ids", [""]),
    ("segment_ids", ["   "]),
    ("contiguous_segments", []),
    ("overall_satisfaction", 0),
    ("overall_satisfaction", 6),
    ("overall_satisfaction", 99),
])
def test_invalid_submission_is_rejected_before_database(client, field, value):
    payload = deepcopy(VALID_PAYLOAD)
    payload[field] = value
    with patch("main.get_conn") as get_conn:
        response = client.post("/api/submissions", json=payload)
    assert response.status_code == 422
    assert any(error["loc"][:2] == ["body", field]
               for error in response.json()["detail"])
    get_conn.assert_not_called()


@pytest.mark.parametrize("field,value", [
    ("segment_ids", []),
    ("segment_ids", [""]),
    ("segment_ids", ["   "]),
    ("sequence_index", -1),
    ("lts_perceived", 0),
    ("lts_perceived", 5),
    ("safety_rating", 0),
    ("safety_rating", 11),
])
def test_invalid_segment_is_rejected_before_database(client, field, value):
    payload = deepcopy(VALID_PAYLOAD)
    payload["contiguous_segments"][0][field] = value
    with patch("main.get_conn") as get_conn:
        response = client.post("/api/submissions", json=payload)
    assert response.status_code == 422
    assert any(error["loc"][:4] == ["body", "contiguous_segments", 0, field]
               for error in response.json()["detail"])
    get_conn.assert_not_called()


@pytest.mark.parametrize("lts,safety,satisfaction", [(1, 1, 1), (4, 10, 5), (None, None, None)])
def test_rating_boundaries_and_skipped_ratings_are_accepted(client, lts, safety, satisfaction):
    payload = deepcopy(VALID_PAYLOAD)
    payload["contiguous_segments"][0]["lts_perceived"] = lts
    payload["contiguous_segments"][0]["safety_rating"] = safety
    payload["overall_satisfaction"] = satisfaction
    assert client.post("/api/submissions", json=payload).status_code == 201


def test_omitted_optional_ratings_are_accepted(client):
    payload = deepcopy(VALID_PAYLOAD)
    del payload["contiguous_segments"][0]["lts_perceived"]
    del payload["contiguous_segments"][0]["safety_rating"]
    del payload["overall_satisfaction"]
    assert client.post("/api/submissions", json=payload).status_code == 201
