// Command demo records docs/demo.gif: it runs Claude Code with proc-stats loaded in a pseudo-terminal,
// in a made-up project (./project) whose stand-in processes hold memory and CPU, asks Claude to start
// them, plays a fixed sequence of keys over the Processes pane, and draws the screen to an animated GIF.
// Run it from this directory on Linux, logged in to Claude Code (its one prompt uses your account):
//
//	go run . -font /path/to/DejaVuSansMono.ttf -bold /path/to/DejaVuSansMono-Bold.ttf \
//	  -fallback /path/to/DejaVuSans.ttf,/path/to/NotoSansSymbols2-Regular.ttf,/path/to/NotoSansSymbols.ttf \
//	  -emoji /path/to/noto-emoji/2D/png/72
//
// Claude Code draws a few glyphs DejaVu lacks: ⏵ is in Noto Sans Symbols 2, ⎿ in Noto Sans Symbols.
//
// The session runs with a home and a config directory of its own, so none of your settings, plugins or
// history show; your credentials file is copied into it and removed with it. The stand-ins end when
// it is removed, or after five minutes.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/png"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
	"github.com/creack/pty"
	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

const (
	cols, rows = 168, 46
	fontSize   = 14
	padding    = 12
	tick       = 50 * time.Millisecond
	// How long each typed character takes.
	typing = 25 * time.Millisecond
)

var (
	background = color.RGBA{0x1a, 0x1b, 0x26, 0xff}
	foreground = color.RGBA{0xc8, 0xcc, 0xd8, 0xff}
	// ansiColors replaces the 16 basic colors.
	ansiColors = [16]color.RGBA{
		{0x15, 0x16, 0x1e, 0xff}, {0xf7, 0x76, 0x8e, 0xff}, {0x9e, 0xce, 0x6a, 0xff}, {0xe0, 0xaf, 0x68, 0xff},
		{0x7a, 0xa2, 0xf7, 0xff}, {0xbb, 0x9a, 0xf7, 0xff}, {0x7d, 0xcf, 0xff, 0xff}, {0xa9, 0xb1, 0xd6, 0xff},
		{0x41, 0x48, 0x68, 0xff}, {0xff, 0x7a, 0x93, 0xff}, {0xb9, 0xf2, 0x7c, 0xff}, {0xff, 0x9e, 0x64, 0xff},
		{0x7d, 0xa6, 0xff, 0xff}, {0xbb, 0x9a, 0xf7, 0xff}, {0x0d, 0xb9, 0xd7, 0xff}, {0xc0, 0xca, 0xf5, 0xff},
	}
)

const (
	enter = "\r"
	esc   = "\x1b"
)

// step waits, then types `text` a key at a time, sends `keys` at once, or clicks the pane's row
// that reads `click`. Rows are clicked, not walked with the arrow keys, which in this emulator stop
// moving the focus partway down the pane (they do not in a real terminal). While `offCamera`, no frames are kept: the wait is cut from the GIF.
type step struct {
	wait      time.Duration
	text      string
	keys      string
	click     string
	offCamera bool
}

// The pane starts this far right; the transcript to its left wraps before it.
const paneColumn = 74

// rowAt is the screen line of the pane's table row that holds label (a line with a memory figure),
// or -1.
func rowAt(emu *vt.SafeEmulator, label string) int {
	for y := 0; y < rows; y++ {
		var line strings.Builder
		for x := paneColumn; x < cols; x++ {
			if cell := emu.CellAt(x, y); cell != nil {
				line.WriteString(cell.Content)
			}
		}
		if text := line.String(); strings.Contains(text, " "+label+" ") && strings.Contains(text, "MB") {
			return y
		}
	}
	return -1
}

// click presses and releases the left button on the row that holds label.
func click(emu *vt.SafeEmulator, label string) error {
	y := rowAt(emu, label)
	if y < 0 {
		return fmt.Errorf("no row %q:\n%s", label, screenText(emu))
	}
	at := uv.Mouse{X: paneColumn + 24, Y: y, Button: uv.MouseLeft}
	emu.SendMouse(uv.MouseClickEvent(at))
	emu.SendMouse(uv.MouseReleaseEvent(at))

	return nil
}

const prompt = "Start the dev server and the test watcher in the background (`npm run dev`, `npm test -- --watch`), " +
	"then the tunnel detached: `setsid nohup npm run tunnel >/dev/null 2>&1 &`. Nothing else."

var script = []step{
	{wait: 5 * time.Second, text: prompt},
	{wait: 500 * time.Millisecond, keys: enter},
	// Claude starts the three commands.
	{wait: 14 * time.Second},
	// The history fills.
	{wait: 45 * time.Second, offCamera: true},
	{wait: 300 * time.Millisecond, text: "/proc-stats"},
	{wait: 500 * time.Millisecond, keys: enter},
	// A busy worker's details.
	{wait: 3 * time.Second, click: "vitest worker 1"},
	// The watcher collapsed into its subtree's totals, and open again.
	{wait: 3500 * time.Millisecond, click: "vitest --watch"},
	{wait: 2500 * time.Millisecond, click: "vitest --watch"},
	// Sorted by CPU, then memory, then back to the tree.
	{wait: 2000 * time.Millisecond, keys: "s"},
	{wait: 2500 * time.Millisecond, keys: "s"},
	{wait: 2500 * time.Millisecond, keys: "s"},
	{wait: 300 * time.Millisecond, keys: "s"},
	// Back to the prompt, and the report.
	{wait: 1500 * time.Millisecond, keys: esc},
	{wait: 600 * time.Millisecond, text: "/proc-stats report"},
	{wait: 500 * time.Millisecond, keys: enter},
	{wait: 6 * time.Second},
}

func main() {
	regular := flag.String("font", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "monospace TrueType font")
	bold := flag.String("bold", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", "bold variant of -font")
	fallback := flag.String("fallback", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "fonts for glyphs -font lacks, comma-separated, tried in order")
	emoji := flag.String("emoji", "", "directory of Noto Emoji images named emoji_u<codepoint>.png, for 🟡 and 🔴")
	shots := flag.String("shots", "", "a directory to also save the screen each step acts on as PNG, for checking")
	out := flag.String("o", "../demo.gif", "output GIF")
	flag.Parse()
	if err := record(*regular, *bold, *fallback, *emoji, *shots, *out); err != nil {
		log.Fatal(err)
	}
}

// session makes the home Claude Code runs in: the project, and a config directory holding only the
// credentials and the first-run answers.
func session() (home, project, config string, err error) {
	home, err = os.MkdirTemp("", "proc-stats-demo-")
	if err != nil {
		return "", "", "", err
	}
	project = filepath.Join(home, "acme-web")
	config = filepath.Join(home, ".claude")
	if err := os.CopyFS(project, os.DirFS("project")); err != nil {
		return home, "", "", err
	}
	if err := os.MkdirAll(config, 0o700); err != nil {
		return home, "", "", err
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return home, "", "", err
	}
	credentials, err := os.ReadFile(filepath.Join(userHome, ".claude", ".credentials.json"))
	if err != nil {
		return home, "", "", fmt.Errorf("log in to Claude Code first: %w", err)
	}
	if err := os.WriteFile(filepath.Join(config, ".credentials.json"), credentials, 0o600); err != nil {
		return home, "", "", err
	}
	// No suggested prompts: they would be drawn in the input box.
	if err := os.WriteFile(filepath.Join(config, "settings.json"), []byte(`{"promptSuggestionEnabled": false}`), 0o600); err != nil {
		return home, "", "", err
	}
	answers := fmt.Sprintf(`{"hasCompletedOnboarding": true, "theme": "dark", "projects": {%q: {"hasTrustDialogAccepted": true}}}`, project)
	return home, project, config, os.WriteFile(filepath.Join(config, ".claude.json"), []byte(answers), 0o600)
}

func record(regularPath, boldPath, fallbackPath, emojiPath, shots, out string) error {
	faces, err := loadFaces(regularPath, boldPath, fallbackPath, emojiPath)
	if err != nil {
		return err
	}
	home, project, config, err := session()
	defer os.RemoveAll(home)
	if err != nil {
		return err
	}
	plugin, err := filepath.Abs("../..")
	if err != nil {
		return err
	}

	cmd := exec.Command("claude", "--plugin-dir", plugin)
	cmd.Dir = project
	// Only what the session needs: none of this shell's Claude Code variables.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "LANG=C.UTF-8", "CLAUDE_CONFIG_DIR=" + config,
		"TERM=xterm-256color", "COLORTERM=truecolor", "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false"}
	tty, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return err
	}
	emu := vt.NewSafeEmulator(cols, rows)
	go func() { _, _ = io.Copy(emu, tty) }()
	go func() { _, _ = io.Copy(tty, emu) }()

	var (
		mu        sync.Mutex
		frames    []*image.RGBA
		delays    []int
		offCamera bool
	)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(tick)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
			}
			// render shares its caches, so it runs under the lock.
			mu.Lock()
			if offCamera {
				mu.Unlock()
				continue
			}
			frame := render(emu, faces)
			if n := len(frames); n > 0 && bytes.Equal(frames[n-1].Pix, frame.Pix) {
				delays[n-1] += int(tick / (10 * time.Millisecond))
			} else {
				frames = append(frames, frame)
				delays = append(delays, int(tick/(10*time.Millisecond)))
			}
			mu.Unlock()
		}
	}()
	for i, s := range script {
		mu.Lock()
		offCamera = s.offCamera
		mu.Unlock()
		time.Sleep(s.wait)
		mu.Lock()
		offCamera = false
		mu.Unlock()
		// The screen each step acts on, after its wait.
		if shots != "" {
			mu.Lock()
			shot := render(emu, faces)
			mu.Unlock()
			if err := savePNG(filepath.Join(shots, fmt.Sprintf("step-%02d.png", i)), shot); err != nil {
				return err
			}
		}
		for _, r := range s.text {
			if _, err := tty.WriteString(string(r)); err != nil {
				return err
			}
			time.Sleep(typing)
		}
		if s.keys != "" {
			if _, err := tty.WriteString(s.keys); err != nil {
				return err
			}
		}
		if s.click != "" {
			if err := click(emu, s.click); err != nil {
				return err
			}
		}
	}
	close(stop)
	<-done
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return writeGIF(out, frames, delays)
}

func savePNG(path string, img image.Image) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := png.Encode(file, img); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

// faces are the fonts cells are drawn in, and the emoji images.
type faces struct {
	regular, bold font.Face
	fallbacks     []font.Face
	emoji         emojiImages
}

// emojiImages are color emoji images in a directory, named as Noto Emoji
// names them: emoji_u, then each code point in hex, without variation
// selectors, joined by underscores.
type emojiImages struct {
	dir    string
	images map[string]image.Image
}

// image returns the image for a cell's content, or nil for none.
func (e emojiImages) image(content string) image.Image {
	if e.dir == "" {
		return nil
	}
	if img, ok := e.images[content]; ok {
		return img
	}
	var points []string
	for _, r := range content {
		if r != 0xfe0f {
			points = append(points, fmt.Sprintf("%x", r))
		}
	}
	var img image.Image
	if file, err := os.Open(filepath.Join(e.dir, "emoji_u"+strings.Join(points, "_")+".png")); err == nil {
		img, _ = png.Decode(file)
		file.Close()
	}
	e.images[content] = img
	return img
}

func loadFaces(regularPath, boldPath, fallbackPath, emojiPath string) (faces, error) {
	load := func(path string) (font.Face, error) {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		f, err := opentype.Parse(data)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		return opentype.NewFace(f, &opentype.FaceOptions{Size: fontSize, DPI: 72, Hinting: font.HintingFull})
	}
	regular, err := load(regularPath)
	if err != nil {
		return faces{}, err
	}
	bold, err := load(boldPath)
	if err != nil {
		return faces{}, err
	}
	var fallbacks []font.Face
	for _, path := range strings.Split(fallbackPath, ",") {
		face, err := load(path)
		if err != nil {
			return faces{}, err
		}
		fallbacks = append(fallbacks, face)
	}
	return faces{regular, bold, fallbacks, emojiImages{dir: emojiPath, images: map[string]image.Image{}}}, nil
}

// faceFor is the first of face and the fallbacks that holds every rune of content, else face.
func faceFor(face font.Face, fallbacks []font.Face, content string) font.Face {
	for _, candidate := range append([]font.Face{face}, fallbacks...) {
		if holdsAll(candidate, content) {
			return candidate
		}
	}
	return face
}

func holdsAll(face font.Face, content string) bool {
	for _, r := range content {
		if _, ok := face.GlyphAdvance(r); !ok {
			return false
		}
	}
	return true
}

func cellSize(f font.Face) (int, int, int) {
	advance, _ := f.GlyphAdvance('M')
	m := f.Metrics()
	return advance.Ceil(), (m.Ascent + m.Descent).Ceil() + 2, m.Ascent.Ceil() + 1
}

func rgba(c color.Color, fallback color.RGBA) color.RGBA {
	switch c := c.(type) {
	case nil:
		return fallback
	case ansi.BasicColor:
		return ansiColors[c&15]
	case ansi.IndexedColor:
		if c < 16 {
			return ansiColors[c]
		}
	}
	r, g, b, _ := c.RGBA()
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), 0xff}
}

func blend(a, b color.RGBA, t float64) color.RGBA {
	mix := func(x, y uint8) uint8 { return uint8(float64(x)*(1-t) + float64(y)*t + 0.5) }
	return color.RGBA{mix(a.R, b.R), mix(a.G, b.G), mix(a.B, b.B), 0xff}
}

// cellColors collects every cell's foreground and background, so the palette
// keeps them exactly.
var cellColors = map[color.RGBA]bool{}

// logo holds the glyphs of Claude Code's logo, which leads each line of its header.
const logo = "▐▛▜▌▝▘█▀▄"

// isLogo reports whether a cell draws part of the logo.
func isLogo(cell *uv.Cell) bool {
	return cell != nil && cell.Content != "" && strings.ContainsAny(cell.Content, logo)
}

// The header's lines beside the logo, after the version, as the GIF shows them: the model and plan
// line, then the folder line. Nothing of the account shows.
const (
	modelLine  = "proc-stats demo"
	folderLine = "~/acme-web"
)

// standIn is the text drawn in place of a header line's own, where it starts, and its color.
type standIn struct {
	text string
	x    int
	fg   color.RGBA
}

// headerStandIn is the stand-in for line y when it is one of the header's lines beside the logo that
// do not hold the version (the model and plan, or the folder), else nil.
func headerStandIn(emu *vt.SafeEmulator, y int) *standIn {
	var line strings.Builder
	isHeader := false
	start := -1
	for x := 0; x < paneColumn; x++ {
		cell := emu.CellAt(x, y)
		if cell == nil {
			continue
		}
		line.WriteString(cell.Content)
		isHeader = isHeader || (x < 12 && isLogo(cell))
		if start < 0 && cell.Content != "" && cell.Content != " " && !isLogo(cell) {
			start = x
		}
	}
	if !isHeader || start < 0 || strings.Contains(line.String(), "Claude Code v") {
		return nil
	}
	cell := emu.CellAt(start, y)
	fg, bg := rgba(cell.Style.Fg, foreground), rgba(cell.Style.Bg, background)
	if cell.Style.Attrs&uv.AttrFaint != 0 {
		fg = blend(fg, bg, 0.45)
	}
	text := folderLine
	if strings.Contains(line.String(), " · ") {
		text = modelLine
	}

	return &standIn{text, start, fg}
}

// render draws the emulator screen with each cell's colors and attributes, less the hidden cells.
func render(emu *vt.SafeEmulator, f faces) *image.RGBA {
	w, h, ascent := cellSize(f.regular)
	img := image.NewRGBA(image.Rect(0, 0, cols*w+2*padding, rows*h+2*padding))
	draw.Draw(img, img.Bounds(), image.NewUniform(background), image.Point{}, draw.Src)
	for y := 0; y < rows; y++ {
		stand := headerStandIn(emu, y)
		if stand != nil {
			cellColors[stand.fg] = true
			d := font.Drawer{Dst: img, Src: image.NewUniform(stand.fg), Face: f.regular,
				Dot: fixed.P(padding+stand.x*w, padding+y*h+ascent)}
			d.DrawString(stand.text)
		}
		for x := 0; x < cols; x++ {
			cell := emu.CellAt(x, y)
			if cell == nil || cell.Width == 0 || (stand != nil && x < paneColumn && !isLogo(cell)) {
				continue
			}
			fg, bg := rgba(cell.Style.Fg, foreground), rgba(cell.Style.Bg, background)
			attrs := cell.Style.Attrs
			if attrs&uv.AttrReverse != 0 {
				fg, bg = bg, fg
			}
			if attrs&uv.AttrFaint != 0 {
				fg = blend(fg, bg, 0.45)
			}
			cellColors[fg], cellColors[bg] = true, true
			width := max(cell.Width, 1)
			box := image.Rect(padding+x*w, padding+y*h, padding+(x+width)*w, padding+(y+1)*h)
			draw.Draw(img, box, image.NewUniform(bg), image.Point{}, draw.Src)
			if emoji := f.emoji.image(cell.Content); emoji != nil {
				// The emoji fills the height of its cells, centered across them.
				side := min(box.Dx(), box.Dy())
				at := image.Pt(box.Min.X+(box.Dx()-side)/2, box.Min.Y+(box.Dy()-side)/2)
				xdraw.CatmullRom.Scale(img, image.Rectangle{at, at.Add(image.Pt(side, side))}, emoji, emoji.Bounds(), xdraw.Over, nil)
			} else if cell.Content != "" && cell.Content != " " {
				face := f.regular
				if attrs&uv.AttrBold != 0 {
					face = f.bold
				}
				face = faceFor(face, f.fallbacks, cell.Content)
				d := font.Drawer{Dst: img, Src: image.NewUniform(fg), Face: face,
					Dot: fixed.P(box.Min.X, box.Min.Y+ascent)}
				d.DrawString(cell.Content)
			}
			if attrs&uv.AttrStrikethrough != 0 {
				mid := box.Min.Y + h/2
				draw.Draw(img, image.Rect(box.Min.X, mid, box.Max.X, mid+1), image.NewUniform(fg), image.Point{}, draw.Src)
			}
		}
	}
	return img
}

// writeGIF encodes the frames with a shared palette, storing only the part of
// each frame that changed.
func writeGIF(path string, frames []*image.RGBA, delays []int) error {
	if len(frames) == 0 {
		return fmt.Errorf("no frames recorded")
	}
	palette := buildPalette(frames)
	anim := &gif.GIF{Config: image.Config{ColorModel: palette, Width: frames[0].Bounds().Dx(), Height: frames[0].Bounds().Dy()}}
	for i, frame := range frames {
		bounds := frame.Bounds()
		if i > 0 {
			bounds = changed(frames[i-1], frame)
		}
		paletted := image.NewPaletted(bounds, palette)
		draw.Draw(paletted, bounds, frame, bounds.Min, draw.Src)
		anim.Image = append(anim.Image, paletted)
		anim.Delay = append(anim.Delay, delays[i])
		anim.Disposal = append(anim.Disposal, gif.DisposalNone)
	}
	anim.Delay[len(anim.Delay)-1] += 200
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := gif.EncodeAll(file, anim); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

// changed returns the smallest rectangle holding every pixel that differs.
func changed(prev, next *image.RGBA) image.Rectangle {
	b := next.Bounds()
	minX, minY, maxX, maxY := b.Max.X, b.Max.Y, b.Min.X, b.Min.Y
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := next.PixOffset(x, y)
			if !bytes.Equal(prev.Pix[i:i+4], next.Pix[i:i+4]) {
				minX, minY, maxX, maxY = min(minX, x), min(minY, y), max(maxX, x+1), max(maxY, y+1)
			}
		}
	}
	if minX >= maxX {
		return image.Rect(0, 0, 1, 1)
	}
	return image.Rect(minX, minY, maxX, maxY)
}

// buildPalette holds every cell color, then the most used anti-aliased edge
// colors up to 256. Other edges map to the nearest entry.
func buildPalette(frames []*image.RGBA) color.Palette {
	palette := color.Palette{}
	for c := range cellColors {
		palette = append(palette, c)
	}
	counts := map[color.RGBA]int{}
	for _, frame := range frames {
		for i := 0; i < len(frame.Pix); i += 4 {
			if c := (color.RGBA{frame.Pix[i], frame.Pix[i+1], frame.Pix[i+2], 0xff}); !cellColors[c] {
				counts[c]++
			}
		}
	}
	edges := make([]color.RGBA, 0, len(counts))
	for c := range counts {
		edges = append(edges, c)
	}
	slices.SortFunc(edges, func(a, b color.RGBA) int {
		if counts[a] != counts[b] {
			return counts[b] - counts[a]
		}
		return int(a.R)<<16 + int(a.G)<<8 + int(a.B) - (int(b.R)<<16 + int(b.G)<<8 + int(b.B))
	})
	for _, c := range edges {
		if len(palette) >= 256 {
			break
		}
		palette = append(palette, c)
	}
	return palette[:min(len(palette), 256)]
}

// screenText is the screen as text, for an error that says what was on it.
func screenText(emu *vt.SafeEmulator) string {
	var text strings.Builder
	for y := 0; y < rows; y++ {
		for x := 0; x < cols; x++ {
			if cell := emu.CellAt(x, y); cell != nil {
				text.WriteString(cell.Content)
			}
		}
		text.WriteString("\n")
	}
	return text.String()
}
