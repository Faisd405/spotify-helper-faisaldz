package main

// Local player mode: the tray runs go-librespot (an open-source Spotify Connect client, GPL-3.0) in the
// background and drives it through its localhost API, so the music comes out of this app instead of a
// Spotify app. Needs Premium. It is downloaded once from its official GitHub release, checked against the
// release's SHA-256, and not bundled into ListenAlong.exe. Its login uses Spotify's own desktop client
// id, so this mode needs no Developer Dashboard registration either.

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
)

// Backend is whatever plays the room's music: the user's own Spotify via the Web API, or go-librespot.
type Backend interface {
	play(id string, posMs int) error
	pause() error
	seek(posMs int) error
	player() (*Player, error) // nil when nothing is loaded
}

const (
	librespotVersion = "v0.10.5"
	librespotURL     = "https://github.com/devgianlu/go-librespot/releases/download/" + librespotVersion + "/go-librespot_windows_amd64.tar.gz"
	librespotSHA256  = "5f5a28df9fca9cd6545ec4344d750d55167f15537370ce8cc3bc7c087f571d07" // from the GitHub release
)

var librespotAPI = "http://localhost:3678" // var so tests can point it at a fake

var errPlayerNotReady = errors.New("pemutar belum siap")

type Local struct {
	dir     string           // %APPDATA%\ListenAlongApp\librespot
	onLogin func(url string) // go-librespot printed its Spotify login link
	onExit  func(err error)  // the process ended on its own
	mu      sync.Mutex
	cmd     *exec.Cmd
}

func (l *Local) exe() string { return filepath.Join(l.dir, "go-librespot.exe") }

// start downloads go-librespot if needed and runs it. Safe to call when it is already running.
func (l *Local) start() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.cmd != nil {
		return nil
	}
	if _, err := os.Stat(l.exe()); err != nil {
		if err := l.download(); err != nil {
			return fmt.Errorf("unduh pemutar gagal: %w", err)
		}
	}
	os.WriteFile(filepath.Join(l.dir, "config.yml"), []byte(`device_name: Listen Along
device_type: computer
log_level: info
bitrate: 160
zeroconf_enabled: false
credentials:
  type: interactive
  interactive:
    callback_port: 47824
server:
  enabled: true
  address: localhost
  port: 3678
`), 0o600)
	cmd := exec.Command(l.exe(), "-config_dir", l.dir)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	out, _ := cmd.StdoutPipe()
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return err
	}
	l.cmd = cmd
	go l.watch(cmd, out)
	return nil
}

var loginLink = regexp.MustCompile(`https://accounts\.spotify\.com/[^\s"]+`)

// watch copies go-librespot's output to its own log file and spots the login link.
func (l *Local) watch(cmd *exec.Cmd, out io.Reader) {
	f, _ := os.Create(filepath.Join(l.dir, "librespot.log"))
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		line := sc.Text()
		if f != nil {
			fmt.Fprintln(f, line)
		}
		if u := loginLink.FindString(line); u != "" && l.onLogin != nil {
			l.onLogin(u)
		}
	}
	err := cmd.Wait()
	if f != nil {
		f.Close()
	}
	l.mu.Lock()
	stopped := l.cmd != cmd // stop() was called
	if !stopped {
		l.cmd = nil
	}
	l.mu.Unlock()
	if !stopped && l.onExit != nil {
		l.onExit(err)
	}
}

func (l *Local) stop() {
	l.mu.Lock()
	cmd := l.cmd
	l.cmd = nil
	l.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
	}
}

// download fetches the release archive, checks its SHA-256 and extracts go-librespot.exe.
func (l *Local) download() error {
	log.Printf("mengunduh go-librespot %s", librespotVersion)
	res, err := http.Get(librespotURL)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 50<<20))
	if err != nil {
		return err
	}
	return extractExe(data, librespotSHA256, l.exe())
}

// extractExe checks the archive's SHA-256, then writes the go-librespot.exe inside it to dst.
func extractExe(data []byte, wantSHA256, dst string) error {
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != wantSHA256 {
		return errors.New("checksum tidak cocok, file tidak dipakai")
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return err
	}
	tr := tar.NewReader(zr)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return errors.New("go-librespot.exe tidak ada di arsip")
		}
		if err != nil {
			return err
		}
		if strings.EqualFold(filepath.Base(h.Name), "go-librespot.exe") {
			os.MkdirAll(filepath.Dir(dst), 0o700)
			tmp := dst + ".tmp"
			f, err := os.Create(tmp)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			f.Close()
			if err != nil {
				return err
			}
			return os.Rename(tmp, dst)
		}
	}
}

func (l *Local) call(method, path string, body any) (int, []byte, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, librespotAPI+path, rd)
	res, err := httpClient.Do(req)
	if err != nil {
		return 0, nil, errPlayerNotReady // not started, or still waiting for its login
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return res.StatusCode, data, fmt.Errorf("pemutar HTTP %d %s", res.StatusCode, strings.TrimSpace(string(data[:min(len(data), 150)])))
	}
	return res.StatusCode, data, nil
}

func (l *Local) play(id string, posMs int) error {
	_, _, err := l.call("POST", "/player/play", map[string]any{"uri": "spotify:track:" + id, "position": max(posMs, 0)})
	return err
}

func (l *Local) pause() error {
	_, _, err := l.call("POST", "/player/pause", nil)
	return err
}

func (l *Local) seek(posMs int) error {
	_, _, err := l.call("POST", "/player/seek", map[string]any{"position": max(posMs, 0)})
	return err
}

func (l *Local) player() (*Player, error) {
	status, data, err := l.call("GET", "/status", nil)
	if err != nil || status == 204 {
		return nil, err
	}
	var s struct {
		Stopped, Paused bool
		Track           *struct {
			URI      string
			Position float64
		}
	}
	if err := json.Unmarshal(data, &s); err != nil || s.Track == nil {
		return nil, err
	}
	p := &Player{IsPlaying: !s.Stopped && !s.Paused, ProgressMs: s.Track.Position, Item: &struct{ ID string }{strings.TrimPrefix(s.Track.URI, "spotify:track:")}}
	return p, nil
}
