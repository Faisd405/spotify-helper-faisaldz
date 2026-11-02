package main

import (
	"encoding/json"
	"testing"
)

func TestParseCode(t *testing.T) {
	for in, want := range map[string]string{
		"vvmrn7": "VVMRN7",
		" https://spotify-helper-faisaldz.vercel.app/?room=AbC123 ": "ABC123",
		"hello":   "",
		"ABC1234": "",
	} {
		if got := parseCode(in); got != want {
			t.Errorf("parseCode(%q) = %q, want %q", in, got, want)
		}
	}
}

// The stream sends a full put, then patches (host's delta publishing), then null when the song stops.
func TestTrackState(t *testing.T) {
	s := trackState{}
	raw := func(v string) json.RawMessage { return json.RawMessage(v) }
	s.apply("put", "/", raw(`{"id":"a","title":"A","durationSec":200,"isPlaying":true,"progressMs":1000,"at":5000,"upcoming":[{"id":"x"}]}`))
	s.apply("patch", "/", raw(`{"progressMs":3000,"at":7000}`))
	s.apply("put", "/isPlaying", raw(`false`))
	s.apply("put", "/upcoming/0", raw(`{"id":"y"}`)) // deeper path: ignored
	tr := s.track()
	if tr == nil || tr.ID != "a" || tr.ProgressMs != 3000 || tr.IsPlaying || tr.predict(9000) != 3000 {
		t.Fatalf("after patches: %+v", tr)
	}
	s.apply("put", "/isPlaying", raw(`true`))
	if p := s.track().predict(8000); p != 4000 {
		t.Fatalf("predict = %v, want 4000", p)
	}
	s.apply("put", "/", raw(`null`))
	if s.track() != nil {
		t.Fatal("null put should clear the track")
	}
}
