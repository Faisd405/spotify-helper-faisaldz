package main

// Firebase over REST: anonymous sign-in, presence heartbeat, and the room's track as a server-sent event
// stream. Same paths and rules as the web app, the browser extension and Spicetify.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	errKicked      = errors.New("tidak diizinkan (di-kick dari room?)")
	errAuthRevoked = errors.New("token Firebase kedaluwarsa")
)

type fbAuth struct {
	IDToken      string
	RefreshToken string
	UID          string
	ExpiresAt    time.Time
}

type Firebase struct {
	dbURL, apiKey, file string
	mu                  sync.Mutex
	auth                *fbAuth
	offset              atomic.Int64 // server clock - local clock, ms
}

func (f *Firebase) serverNow() float64 { return float64(time.Now().UnixMilli() + f.offset.Load()) }

// token signs in anonymously once and refreshes the ID token (1 h) with the saved refresh token.
func (f *Firebase) token() (*fbAuth, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.auth == nil {
		readJSON(f.file, &f.auth)
	}
	if f.auth != nil && time.Until(f.auth.ExpiresAt) > time.Minute {
		return f.auth, nil
	}
	var next *fbAuth
	if f.auth != nil {
		var r struct {
			IDToken      string `json:"id_token"`
			RefreshToken string `json:"refresh_token"`
			UserID       string `json:"user_id"`
			ExpiresIn    string `json:"expires_in"`
		}
		form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {f.auth.RefreshToken}}
		if postForm("https://securetoken.googleapis.com/v1/token?key="+f.apiKey, form, &r) == nil && r.IDToken != "" {
			next = &fbAuth{r.IDToken, r.RefreshToken, r.UserID, expiry(r.ExpiresIn)}
		}
	}
	if next == nil {
		var r struct{ IDToken, RefreshToken, LocalID, ExpiresIn string }
		body, _ := json.Marshal(map[string]bool{"returnSecureToken": true})
		res, err := http.Post("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key="+f.apiKey, "application/json", bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if json.NewDecoder(res.Body).Decode(&r); r.IDToken == "" {
			return nil, fmt.Errorf("login Firebase gagal (HTTP %d)", res.StatusCode)
		}
		next = &fbAuth{r.IDToken, r.RefreshToken, r.LocalID, expiry(r.ExpiresIn)}
	}
	f.auth = next
	writeJSON(f.file, next)
	return next, nil
}

func expiry(sec string) time.Time {
	n, _ := strconv.Atoi(sec)
	return time.Now().Add(time.Duration(n) * time.Second)
}

func (f *Firebase) do(method, path string, body any, out any) (int, error) {
	a, err := f.token()
	if err != nil {
		return 0, err
	}
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, fmt.Sprintf("%s/%s.json?auth=%s", f.dbURL, path, a.IDToken), rd)
	res, err := httpClient.Do(req)
	if err != nil {
		return 0, redact(err)
	}
	defer res.Body.Close()
	if out != nil {
		json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode, nil
}

// heartbeat keeps us in the room's member list and measures the clock offset from the server's
// timestamp echo (room positions are stamped in server time).
func (f *Firebase) heartbeat(code, name string) error {
	a, err := f.token()
	if err != nil {
		return err
	}
	sent := time.Now()
	var echo struct{ At int64 }
	status, err := f.do("PUT", "listeners/"+code+"/"+a.UID, map[string]any{"name": name, "via": "app", "at": map[string]string{".sv": "timestamp"}}, &echo)
	if err != nil {
		return err
	}
	if status == 401 {
		return errKicked
	}
	if status == 200 && echo.At > 0 {
		mid := sent.UnixMilli() + time.Since(sent).Milliseconds()/2
		f.offset.Store(echo.At - mid)
	}
	return nil
}

func (f *Firebase) leave(code string) {
	if a, err := f.token(); err == nil {
		f.do("DELETE", "listeners/"+code+"/"+a.UID, nil, nil)
	}
}

// stream follows rooms/{code}/track until the context ends or the connection drops. onEvent gets every
// put/patch: path is relative to the track ("/" = the whole track).
func (f *Firebase) stream(ctx context.Context, code string, onEvent func(event, path string, data json.RawMessage)) error {
	a, err := f.token()
	if err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/rooms/%s/track.json?auth=%s", f.dbURL, code, a.IDToken), nil)
	req.Header.Set("Accept", "text/event-stream")
	res, err := http.DefaultClient.Do(req) // no timeout: the stream stays open
	if err != nil {
		return redact(err)
	}
	defer res.Body.Close()
	if res.StatusCode == 401 {
		return errKicked
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("stream HTTP %d", res.StatusCode)
	}
	sc := bufio.NewScanner(res.Body)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	event := ""
	for sc.Scan() {
		line := sc.Text()
		if v, ok := strings.CutPrefix(line, "event: "); ok {
			event = v
			continue
		}
		data, ok := strings.CutPrefix(line, "data: ")
		if !ok {
			continue
		}
		switch event {
		case "put", "patch":
			var m struct {
				Path string
				Data json.RawMessage
			}
			if json.Unmarshal([]byte(data), &m) == nil {
				onEvent(event, m.Path, m.Data)
			}
		case "cancel":
			return errKicked
		case "auth_revoked":
			return errAuthRevoked
		}
	}
	if sc.Err() != nil {
		return redact(sc.Err())
	}
	return io.ErrUnexpectedEOF
}

// redact drops the URL (it carries ?auth=<token>) from net/http errors before they reach the log.
func redact(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s %s: %w", ue.Op, strings.SplitN(ue.URL, "?", 2)[0], ue.Err)
	}
	return err
}

// Track is the part of rooms/{code}/track the follower needs.
type Track struct {
	ID          string
	Title       string
	Artist      string
	DurationSec float64
	IsPlaying   bool
	ProgressMs  float64
	At          float64 // server time of ProgressMs
}

// predict is where the host is at server time now (same extrapolation as every other listener).
func (t *Track) predict(now float64) float64 {
	p := t.ProgressMs
	if t.IsPlaying {
		p += now - t.At
	}
	return min(max(p, 0), t.DurationSec*1000)
}

// trackState merges stream events into the latest track. Only top-level fields matter here; deeper
// paths are next/upcoming, which the follower ignores.
type trackState map[string]json.RawMessage

func (s trackState) apply(event, path string, data json.RawMessage) {
	if path == "/" {
		if event == "put" {
			clear(s)
		}
		var m map[string]json.RawMessage
		json.Unmarshal(data, &m) // null -> nil map: no track
		for k, v := range m {
			s[k] = v
		}
		return
	}
	if parts := strings.Split(strings.Trim(path, "/"), "/"); len(parts) == 1 {
		s[parts[0]] = data
	}
}

func (s trackState) track() *Track {
	if len(s["id"]) == 0 || string(s["id"]) == "null" {
		return nil
	}
	b, _ := json.Marshal(s)
	var t Track
	json.Unmarshal(b, &t)
	return &t
}
