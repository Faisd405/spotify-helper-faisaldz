// Listen Along follower: a tray app that makes your own Spotify (PC or phone) follow a Listen Along room.
// It only follows: no queue, no requests, no room controls. Untick "Ikuti" (or just play something else)
// and Spotify is yours again.
//
// Build: ./build.sh (bakes in the same public config the web app ships, from ../.env).
// Test without Spotify: ListenAlong.exe -dry CODE (commands are logged to the log file, not sent).
package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"github.com/atotto/clipboard"
)

// Set at build time with -ldflags -X (see build.sh).
var clientID, dbURL, apiKey string

var httpClient = &http.Client{Timeout: 15 * time.Second}

type App struct {
	dir       string
	fb        *Firebase
	sp        *Spotify
	mu        sync.Mutex
	room      string
	following bool
	track     *Track
	status    string
	stop      context.CancelFunc
	wake      chan struct{}
	mStatus   *systray.MenuItem
	mFollow   *systray.MenuItem
}

func main() {
	dry := flag.Bool("dry", false, "tes tanpa Spotify: perintah hanya dicatat di log")
	flag.Parse()
	dir, _ := os.UserConfigDir()
	dir = filepath.Join(dir, "ListenAlongApp")
	os.MkdirAll(dir, 0o700)
	if f, err := os.Create(filepath.Join(dir, "log.txt")); err == nil {
		log.SetOutput(f)
		log.SetFlags(log.Ltime | log.Lmicroseconds)
	}
	a := &App{
		dir:       dir,
		fb:        &Firebase{dbURL: strings.TrimSuffix(dbURL, "/"), apiKey: apiKey, file: filepath.Join(dir, "firebase.json")},
		sp:        &Spotify{clientID: clientID, file: filepath.Join(dir, "spotify.json"), dry: *dry},
		following: true,
		wake:      make(chan struct{}, 1),
	}
	var cfg struct{ Room string }
	readJSON(filepath.Join(dir, "config.json"), &cfg)
	if flag.NArg() > 0 {
		cfg.Room = parseCode(flag.Arg(0))
	}
	systray.Run(func() { a.onReady(cfg.Room) }, nil)
}

func (a *App) onReady(room string) {
	systray.SetIcon(icon())
	systray.SetTooltip("Listen Along")
	a.mStatus = systray.AddMenuItem("Belum gabung room", "")
	a.mStatus.Disable()
	systray.AddSeparator()
	mJoin := systray.AddMenuItem("Gabung room dari clipboard", "Salin kode atau link room dulu, lalu klik ini")
	a.mFollow = systray.AddMenuItemCheckbox("Ikuti", "Hilangkan centang untuk memakai Spotify sendiri", true)
	mLeave := systray.AddMenuItem("Keluar room", "")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Tutup aplikasi", "")
	if clientID == "" || dbURL == "" || apiKey == "" {
		a.setStatus("Config kosong: build ulang dengan build.sh")
	} else if room != "" {
		go a.join(room)
	}
	go func() {
		for {
			select {
			case <-mJoin.ClickedCh:
				text, _ := clipboard.ReadAll()
				if code := parseCode(text); code != "" {
					go a.join(code)
				} else {
					a.setStatus("Clipboard tidak berisi kode room")
				}
			case <-a.mFollow.ClickedCh:
				a.setFollowing(!a.mFollow.Checked(), "")
			case <-mLeave.ClickedCh:
				a.leave("Keluar dari room")
			case <-mQuit.ClickedCh:
				a.leave("")
				systray.Quit()
				return
			}
		}
	}()
}

var (
	roomParam = regexp.MustCompile(`room=([A-Za-z0-9]{6})`)
	bareCode  = regexp.MustCompile(`^[A-Za-z0-9]{6}$`)
)

// parseCode accepts a bare code or any link containing ?room=CODE.
func parseCode(s string) string {
	if m := roomParam.FindStringSubmatch(s); m != nil {
		return strings.ToUpper(m[1])
	}
	if s = strings.TrimSpace(s); bareCode.MatchString(s) {
		return strings.ToUpper(s)
	}
	return ""
}

func (a *App) setStatus(s string) {
	a.mu.Lock()
	same := s == a.status
	a.status = s
	a.mu.Unlock()
	if same {
		return
	}
	log.Print(s)
	if a.mStatus != nil {
		a.mStatus.SetTitle(s)
		systray.SetTooltip("Listen Along: " + s)
	}
}

func (a *App) setFollowing(on bool, why string) {
	a.mu.Lock()
	a.following = on
	a.mu.Unlock()
	if on {
		a.mFollow.Check()
	} else {
		a.mFollow.Uncheck()
		if why == "" {
			why = "Tidak mengikuti: Spotify bebas dipakai sendiri"
		}
		a.setStatus(why)
	}
	a.poke()
}

func (a *App) poke() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}

func (a *App) join(code string) {
	a.leave("")
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	a.room, a.stop, a.track = code, cancel, nil
	a.mu.Unlock()
	writeJSON(filepath.Join(a.dir, "config.json"), map[string]string{"Room": code})
	a.setStatus("Gabung ke room " + code + "…")
	go a.streamLoop(ctx, code)
	go a.presenceLoop(ctx, code)
	go a.syncLoop(ctx)
}

// leave stops following; why != "" also forgets the room (so it isn't rejoined on the next start).
func (a *App) leave(why string) {
	a.mu.Lock()
	code, stop := a.room, a.stop
	a.room, a.stop, a.track = "", nil, nil
	a.mu.Unlock()
	if stop == nil {
		return
	}
	stop()
	go a.fb.leave(code)
	if why != "" {
		writeJSON(filepath.Join(a.dir, "config.json"), map[string]string{})
		a.setStatus(why)
	}
}

func (a *App) streamLoop(ctx context.Context, code string) {
	state := trackState{}
	backoff := time.Second
	for ctx.Err() == nil {
		err := a.fb.stream(ctx, code, func(event, path string, data json.RawMessage) {
			state.apply(event, path, data)
			a.mu.Lock()
			a.track = state.track()
			a.mu.Unlock()
			a.poke()
			backoff = time.Second
		})
		if ctx.Err() != nil {
			return
		}
		if err == errKicked {
			a.leave("Tidak bisa membaca room " + code + " (di-kick?)")
			return
		}
		log.Printf("stream: %v, sambung ulang dalam %s", err, backoff)
		time.Sleep(backoff)
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (a *App) presenceLoop(ctx context.Context, code string) {
	name := []rune(a.sp.displayName()) // also triggers the Spotify login on first use
	name = name[:min(len(name), 40)]
	for {
		if err := a.fb.heartbeat(code, string(name)); err == errKicked {
			a.leave("Anda di-kick dari room " + code)
			return
		} else if err != nil {
			log.Print("heartbeat: ", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(15 * time.Second):
		}
	}
}

// syncLoop makes the user's Spotify follow the room: play/pause/song changes right away, and a seek when
// Spotify drifts more than 1.2 s from the host (checked every 4 s; each check is one Web API call).
func (a *App) syncLoop(ctx context.Context) {
	var appliedID string
	var appliedPlaying bool
	var lastCmd, lastSeek, lastCheck, holdUntil time.Time
	var aligned *Track // the room state Spotify was last lined up with
	// ms between sending a command and Spotify actually playing there. Learned from the first drift check
	// after each of our play/seek commands (calibrate).
	lead, calibrate := 400.0, false
	tick := time.NewTicker(300 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		case <-a.wake:
		}
		a.mu.Lock()
		t, following := a.track, a.following
		a.mu.Unlock()
		if !following {
			appliedID = "" // re-apply everything when following resumes
			continue
		}
		if time.Now().Before(holdUntil) {
			continue
		}
		fail := func(err error) {
			switch e := err.(type) {
			case rateLimited:
				holdUntil = time.Now().Add(e.wait)
			default:
				holdUntil = time.Now().Add(5 * time.Second)
			}
			switch err {
			case errNoDevice:
				a.setStatus("Buka Spotify (PC atau HP) dulu")
			case errPremium:
				a.setFollowing(false, "Mengikuti butuh Spotify Premium")
			default:
				a.setStatus("Error: " + err.Error())
			}
		}
		if t == nil {
			if appliedPlaying {
				a.sp.pause()
				appliedPlaying = false
			}
			appliedID = ""
			a.setStatus("Menunggu host memutar lagu")
			continue
		}
		if t.ID != appliedID || t.IsPlaying != appliedPlaying {
			var err error
			if t.ID != appliedID || t.IsPlaying {
				err = a.sp.play(t.ID, int(t.predict(a.fb.serverNow())+lead))
			}
			if err == nil && !t.IsPlaying {
				err = a.sp.pause()
			}
			if err != nil {
				fail(err)
				continue
			}
			appliedID, appliedPlaying, lastCmd, lastSeek, aligned, calibrate = t.ID, t.IsPlaying, time.Now(), time.Now(), t, t.IsPlaying
			a.setStatus(nowPlaying(t, ""))
			continue
		}
		// The host seeked (the room's position jumped): follow now instead of at the next drift check.
		if now := a.fb.serverNow(); t.IsPlaying && aligned != nil && math.Abs(t.predict(now)-aligned.predict(now)) > 1000 {
			if err := a.sp.seek(int(t.predict(now) + lead)); err != nil {
				fail(err)
				continue
			}
			lastSeek, lastCmd, calibrate = time.Now(), time.Now(), true
		}
		aligned = t
		if time.Since(lastCheck) < 4*time.Second || time.Since(lastCmd) < 2*time.Second {
			continue
		}
		lastCheck = time.Now()
		sent := time.Now()
		p, err := a.sp.player()
		if err != nil {
			fail(err)
			continue
		}
		if p == nil || p.Item == nil {
			appliedID = "" // Spotify was closed: start again on whatever is open
			continue
		}
		// Playing something else (or paused/resumed by hand) well after our last command: the user took over.
		if time.Since(lastCmd) > 8*time.Second && (p.Item.ID != t.ID || p.IsPlaying != t.IsPlaying) {
			a.setFollowing(false, "Berhenti mengikuti: Spotify Anda memutar lagu lain")
			continue
		}
		if p.Item.ID != t.ID || !t.IsPlaying {
			continue
		}
		mid := a.fb.serverNow() - float64(time.Since(sent).Milliseconds())/2
		drift := p.ProgressMs - t.predict(mid)
		if calibrate && math.Abs(drift) < 3000 {
			lead = min(max(lead-drift, 0), 2000) // drift = lead - real latency
		}
		calibrate = false
		if math.Abs(drift) > 1200 && time.Since(lastSeek) > 6*time.Second {
			if err := a.sp.seek(int(t.predict(a.fb.serverNow()) + lead)); err != nil {
				fail(err)
				continue
			}
			lastSeek, lastCmd, calibrate = time.Now(), time.Now(), true
			log.Printf("seek: selisih %.0f ms, lead sekarang %.0f ms", drift, lead)
		}
		a.setStatus(nowPlaying(t, fmt.Sprintf(" (selisih %.1f dtk)", drift/1000)))
	}
}

func nowPlaying(t *Track, extra string) string {
	state := "Mengikuti"
	if !t.IsPlaying {
		state = "Dijeda host"
	}
	s := fmt.Sprintf("%s: %s — %s", state, t.Title, t.Artist)
	if r := []rune(s); len(r) > 70 {
		s = string(r[:69]) + "…"
	}
	return s + extra
}

// ---------- small helpers ----------

func readJSON(path string, v any) {
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, v)
	}
}

func writeJSON(path string, v any) {
	b, _ := json.Marshal(v)
	os.WriteFile(path, b, 0o600)
}

func postForm(u string, form url.Values, out any) error {
	res, err := httpClient.PostForm(u, form)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func openBrowser(u string) {
	exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
}

// icon draws the tray icon (a green disc with sound bars) as a 32x32 32-bit .ico, so there's no asset file.
func icon() []byte {
	const n = 32
	var buf bytes.Buffer
	w := func(v any) { binary.Write(&buf, binary.LittleEndian, v) }
	w([3]uint16{0, 1, 1})                  // ICONDIR: reserved, type icon, 1 image
	w([4]uint8{n, n, 0, 0})                // ICONDIRENTRY: size, no palette
	w([2]uint16{1, 32})                    // planes, bits per pixel
	w([2]uint32{40 + n*n*4 + n*4, 6 + 16}) // image bytes, offset
	w(struct {                             // BITMAPINFOHEADER (height counts the AND mask too)
		Size, W, H              int32
		Planes, Bits            uint16
		Comp, ImgSize, XPM, YPM int32
		Used, Important         uint32
	}{40, n, n * 2, 1, 32, 0, n * n * 4, 0, 0, 0, 0})
	bar := func(x, y int) bool {
		for _, b := range [][4]int{{9, 12, 11, 20}, {14, 8, 17, 24}, {20, 11, 22, 21}} { // x0, y0, x1, y1
			if x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] {
				return true
			}
		}
		return false
	}
	for y := n - 1; y >= 0; y-- { // bottom-up rows, BGRA
		for x := 0; x < n; x++ {
			dx, dy := float64(x)-15.5, float64(y)-15.5
			switch {
			case dx*dx+dy*dy > 15.5*15.5:
				w([4]uint8{0, 0, 0, 0})
			case bar(x, y):
				w([4]uint8{255, 255, 255, 255})
			default:
				w([4]uint8{0x54, 0xb9, 0x1d, 255}) // #1db954
			}
		}
	}
	buf.Write(make([]byte, n*4)) // AND mask: unused with an alpha channel
	return buf.Bytes()
}
