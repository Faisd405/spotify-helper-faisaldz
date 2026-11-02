package main

// Spotify Web API: PKCE login through the browser (once; the refresh token is saved), then play / pause /
// seek on whichever Spotify app the user has open (PC or phone, via Spotify Connect). Needs Premium.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	redirectURI = "http://127.0.0.1:47823/callback" // must be added to the app in the Spotify Developer Dashboard
	scopes      = "user-read-playback-state user-modify-playback-state"
)

var (
	errNoDevice = errors.New("tidak ada Spotify yang terbuka")
	errPremium  = errors.New("butuh Spotify Premium")
	errLogin    = errors.New("belum login Spotify")
)

type rateLimited struct{ wait time.Duration }

func (e rateLimited) Error() string { return fmt.Sprintf("rate limit Spotify, tunggu %s", e.wait) }

type spToken struct {
	Access, Refresh string
	ExpiresAt       time.Time
}

type Spotify struct {
	clientID, file string
	dry            bool // test mode: no Spotify at all, commands are logged and simulated
	mu             sync.Mutex
	tok            *spToken
	loggingIn      atomic.Bool
	sim            struct {
		id      string
		pos     float64
		at      time.Time
		playing bool
	}
}

// token never opens the browser: a login is started from the tray menu (and once on the first start).
func (s *Spotify) token() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tok == nil {
		readJSON(s.file, &s.tok)
	}
	if s.tok == nil {
		return "", errLogin
	}
	if time.Until(s.tok.ExpiresAt) < time.Minute {
		next, err := s.fetchToken(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {s.tok.Refresh}})
		if err != nil {
			s.tok = nil // revoked or expired: needs a new login
			os.Remove(s.file)
			return "", errLogin
		}
		s.store(next)
	}
	return s.tok.Access, nil
}

func (s *Spotify) hasLogin() bool {
	_, err := s.token()
	return err == nil
}

// store keeps the refresh token when a refresh doesn't return a new one. Caller holds s.mu.
func (s *Spotify) store(next *spToken) {
	if next.Refresh == "" && s.tok != nil {
		next.Refresh = s.tok.Refresh
	}
	s.tok = next
	writeJSON(s.file, next)
}

func randString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)[:n]
}

// login opens the browser for the Spotify consent page and waits (up to 10 min) for the redirect on
// 127.0.0.1. It doesn't hold s.mu while waiting, so following and presence keep running.
func (s *Spotify) login() error {
	if !s.loggingIn.CompareAndSwap(false, true) {
		return errors.New("login sudah dibuka di browser")
	}
	defer s.loggingIn.Store(false)
	verifier, state := randString(64), randString(16)
	sum := sha256.Sum256([]byte(verifier))
	ln, err := net.Listen("tcp", "127.0.0.1:47823")
	if err != nil {
		return fmt.Errorf("port 47823 sedang dipakai: %w", err)
	}
	codes := make(chan string, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		q := r.URL.Query()
		code := q.Get("code")
		if q.Get("state") != state || code == "" {
			fmt.Fprintf(w, "Login Spotify gagal: %s", q.Get("error"))
			code = ""
		} else {
			fmt.Fprint(w, "Login Spotify berhasil. Tab ini boleh ditutup.")
		}
		select {
		case codes <- code:
		default:
		}
	})}
	go srv.Serve(ln)
	defer srv.Close()
	openBrowser("https://accounts.spotify.com/authorize?" + url.Values{
		"client_id": {s.clientID}, "response_type": {"code"}, "redirect_uri": {redirectURI}, "scope": {scopes},
		"code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "state": {state},
	}.Encode())
	select {
	case code := <-codes:
		if code == "" {
			return errors.New("login Spotify dibatalkan")
		}
		next, err := s.fetchToken(url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirectURI}, "code_verifier": {verifier}})
		if err != nil {
			return err
		}
		s.mu.Lock()
		s.store(next)
		s.mu.Unlock()
		return nil
	case <-time.After(10 * time.Minute):
		return errors.New("login Spotify tidak diselesaikan")
	}
}

func (s *Spotify) fetchToken(form url.Values) (*spToken, error) {
	form.Set("client_id", s.clientID)
	var r struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := postForm("https://accounts.spotify.com/api/token", form, &r); err != nil || r.AccessToken == "" {
		return nil, fmt.Errorf("token Spotify gagal: %v", err)
	}
	return &spToken{r.AccessToken, r.RefreshToken, time.Now().Add(time.Duration(r.ExpiresIn) * time.Second)}, nil
}

func (s *Spotify) api(method, path string, body any) (int, []byte, error) {
	if s.dry {
		return s.simulate(method, path, body)
	}
	for attempt := 0; ; attempt++ {
		tok, err := s.token()
		if err != nil {
			return 0, nil, err
		}
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, "https://api.spotify.com/v1"+path, rd)
		req.Header.Set("Authorization", "Bearer "+tok)
		res, err := httpClient.Do(req)
		if err != nil {
			return 0, nil, err
		}
		data, _ := io.ReadAll(res.Body)
		res.Body.Close()
		switch {
		case res.StatusCode == 401 && attempt == 0:
			s.mu.Lock()
			if s.tok != nil {
				s.tok.ExpiresAt = time.Time{} // force a refresh
			}
			s.mu.Unlock()
			continue
		case res.StatusCode == 429:
			sec, _ := strconv.Atoi(res.Header.Get("Retry-After"))
			return 429, nil, rateLimited{time.Duration(max(sec, 5)) * time.Second}
		case res.StatusCode == 403 && strings.Contains(string(data), "PREMIUM_REQUIRED"):
			return 403, data, errPremium
		}
		return res.StatusCode, data, nil
	}
}

type Player struct {
	IsPlaying  bool    `json:"is_playing"`
	ProgressMs float64 `json:"progress_ms"`
	Item       *struct{ ID string }
}

// player is nil when no Spotify app is active.
func (s *Spotify) player() (*Player, error) {
	status, data, err := s.api("GET", "/me/player", nil)
	if err != nil || status != 200 {
		return nil, err
	}
	var p Player
	return &p, json.Unmarshal(data, &p)
}

// play starts the track at posMs. With no active Spotify it picks an open one (PC first).
func (s *Spotify) play(id string, posMs int) error {
	body := map[string]any{"uris": []string{"spotify:track:" + id}, "position_ms": max(posMs, 0)}
	status, _, err := s.api("PUT", "/me/player/play", body)
	if err != nil || status < 300 {
		return err
	}
	if status != 404 {
		return fmt.Errorf("play HTTP %d", status)
	}
	_, data, err := s.api("GET", "/me/player/devices", nil)
	if err != nil {
		return err
	}
	var d struct {
		Devices []struct {
			ID, Type     string
			IsRestricted bool `json:"is_restricted"`
		}
	}
	json.Unmarshal(data, &d)
	device := ""
	for _, dev := range d.Devices {
		if !dev.IsRestricted && (device == "" || dev.Type == "Computer") {
			device = dev.ID
		}
	}
	if device == "" {
		return errNoDevice
	}
	status, _, err = s.api("PUT", "/me/player/play?device_id="+device, body)
	if err == nil && status >= 300 {
		err = fmt.Errorf("play HTTP %d", status)
	}
	return err
}

// Pausing an already paused player answers 403 "Restriction violated": harmless, so not an error.
func (s *Spotify) pause() error {
	_, _, err := s.api("PUT", "/me/player/pause", nil)
	return err
}

func (s *Spotify) seek(posMs int) error {
	_, _, err := s.api("PUT", fmt.Sprintf("/me/player/seek?position_ms=%d", max(posMs, 0)), nil)
	return err
}

func (s *Spotify) displayName() string {
	_, data, err := s.api("GET", "/me", nil)
	var me struct {
		DisplayName string `json:"display_name"`
	}
	if err == nil && json.Unmarshal(data, &me) == nil && me.DisplayName != "" {
		return me.DisplayName
	}
	return "Pendengar (App)"
}

// simulate stands in for Spotify in -dry mode: a player that does exactly what it is told.
func (s *Spotify) simulate(method, path string, body any) (int, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sim := &s.sim
	pos := func() float64 {
		if sim.playing {
			return sim.pos + float64(time.Since(sim.at).Milliseconds())
		}
		return sim.pos
	}
	if method != "GET" {
		log.Printf("[dry] %s %s %v", method, path, body)
	}
	switch {
	case path == "/me":
		return 200, []byte(`{"display_name":"Tes App"}`), nil
	case path == "/me/player":
		if sim.id == "" {
			return 204, nil, nil
		}
		b, _ := json.Marshal(map[string]any{"is_playing": sim.playing, "progress_ms": pos(), "item": map[string]string{"id": sim.id}})
		return 200, b, nil
	case strings.HasPrefix(path, "/me/player/play"):
		m := body.(map[string]any)
		sim.id = strings.TrimPrefix(m["uris"].([]string)[0], "spotify:track:")
		sim.pos, sim.at, sim.playing = float64(m["position_ms"].(int)), time.Now(), true
	case path == "/me/player/pause":
		sim.pos, sim.playing = pos(), false
	case strings.HasPrefix(path, "/me/player/seek"):
		p, _ := strconv.Atoi(strings.TrimPrefix(path, "/me/player/seek?position_ms="))
		sim.pos, sim.at = float64(p), time.Now()
	}
	return 204, nil, nil
}
