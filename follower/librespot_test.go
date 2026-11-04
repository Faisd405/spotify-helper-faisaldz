package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A stand-in for go-librespot's API: remembers what it was told, reports it back on /status.
func TestLocalBackend(t *testing.T) {
	var calls []string
	state := map[string]any{"stopped": true, "paused": false}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		calls = append(calls, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/status":
			if state["track"] == nil {
				w.WriteHeader(204)
				return
			}
			json.NewEncoder(w).Encode(state)
		case "/player/play":
			state["track"] = map[string]any{"uri": body["uri"], "position": body["position"]}
			state["stopped"], state["paused"] = false, false
		case "/player/pause":
			state["paused"] = true
		case "/player/seek":
			state["track"].(map[string]any)["position"] = body["position"]
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	librespotAPI = srv.URL
	l := &Local{}

	if p, err := l.player(); p != nil || err != nil {
		t.Fatalf("nothing loaded: got %+v, %v", p, err)
	}
	if err := l.play("abc", 61000); err != nil {
		t.Fatal(err)
	}
	p, err := l.player()
	if err != nil || p == nil || p.Item.ID != "abc" || !p.IsPlaying || p.ProgressMs != 61000 {
		t.Fatalf("after play: %+v, %v", p, err)
	}
	l.seek(90000)
	l.pause()
	if p, _ := l.player(); p.IsPlaying || p.ProgressMs != 90000 {
		t.Fatalf("after seek+pause: %+v", p)
	}
	if want := []string{"GET /status", "POST /player/play", "GET /status", "POST /player/seek", "POST /player/pause", "GET /status"}; len(calls) != len(want) {
		t.Fatalf("calls = %v", calls)
	}

	librespotAPI = "http://127.0.0.1:1" // nothing listening
	if err := l.play("abc", 0); err != errPlayerNotReady {
		t.Fatalf("no player: err = %v, want errPlayerNotReady", err)
	}
}

func TestExtractExe(t *testing.T) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for name, body := range map[string]string{"README.md": "hi", "go-librespot.exe": "MZ fake"} {
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body))})
		io.WriteString(tw, body)
	}
	tw.Close()
	zw.Close()
	data := buf.Bytes()
	sum := sha256.Sum256(data)
	dst := filepath.Join(t.TempDir(), "x", "go-librespot.exe")

	if err := extractExe(data, "00"+hex.EncodeToString(sum[1:]), dst); err == nil {
		t.Fatal("a wrong checksum must be refused")
	}
	if _, err := os.Stat(dst); err == nil {
		t.Fatal("nothing may be written when the checksum is wrong")
	}
	if err := extractExe(data, hex.EncodeToString(sum[:]), dst); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "MZ fake" {
		t.Fatalf("extracted %q", b)
	}
}
