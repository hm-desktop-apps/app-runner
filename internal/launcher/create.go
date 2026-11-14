package launcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/google/uuid"
	"github.com/pelletier/go-toml/v2"
)

type NewAppInfo struct {
	Token   string   `json:"token"`
	Name    string   `json:"name"`
	Source  string   `json:"source"`
	Target  string   `json:"target"`
	Entries []string `json:"entries"`
}
type appImport struct {
	info    NewAppInfo
	stage   string
	library string
}

func validateAppName(name string) error {
	if name == "" || name == "." || name == ".." || strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") || strings.HasPrefix(strings.ToLower(name), ".app-runner-") {
		return errors.New("请输入有效的应用目录名")
	}
	if strings.ContainsAny(name, `<>:"/\|?*`) || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return errors.New("应用目录名不能包含路径、控制字符或 Windows 保留字符")
	}
	base := strings.ToUpper(strings.Split(name, ".")[0])
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9') {
		return errors.New("不能使用 Windows 保留的设备名称")
	}
	if len([]rune(name)) > 200 {
		return errors.New("应用目录名过长")
	}
	return nil
}
func inside(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
func sourcePath(path string) (string, os.FileInfo, error) {
	if strings.TrimSpace(path) == "" {
		return "", nil, errors.New("请选择来源目录或压缩包")
	}
	absolute, err := filepath.Abs(strings.TrimSpace(path))
	if err != nil {
		return "", nil, err
	}
	absolute, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", nil, errors.New("选择的目录或压缩包不存在")
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return "", nil, err
	}
	if info.IsDir() {
		return absolute, info, nil
	}
	if !info.Mode().IsRegular() {
		return "", nil, errors.New("请选择目录或 ZIP / 7z 压缩包")
	}
	extension := strings.ToLower(filepath.Ext(absolute))
	if extension != ".zip" && extension != ".7z" {
		return "", nil, errors.New("压缩包仅支持 ZIP 和 7z")
	}
	return absolute, info, nil
}
var entryExtensions = map[string]bool{
	".exe": true, ".bat": true, ".cmd": true, ".ps1": true, ".py": true, ".jar": true,
}

// entryCandidates lists launchable files directly inside content and content/bin.
// Anything deeper is treated as a helper binary and never becomes the default entry.
func entryCandidates(content string) []string {
	result := []string{}
	for _, directory := range []struct{ path, prefix string }{
		{content, ""},
		{filepath.Join(content, "bin"), "bin/"},
	} {
		items, err := os.ReadDir(directory.path)
		if err != nil {
			continue
		}
		names := []string{}
		for _, item := range items {
			if !item.Type().IsRegular() || !entryExtensions[strings.ToLower(filepath.Ext(item.Name()))] {
				continue
			}
			names = append(names, directory.prefix+item.Name())
		}
		sort.Slice(names, func(i, j int) bool { return strings.ToLower(names[i]) < strings.ToLower(names[j]) })
		result = append(result, names...)
	}
	if len(result) > 500 {
		result = result[:500]
	}
	return result
}

func (s *Store) PrepareNewApp(source, name string) (NewAppInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := NewAppInfo{}
	name = strings.TrimSpace(name)
	if err := validateAppName(name); err != nil {
		return result, err
	}
	root, err := filepath.EvalSymlinks(s.library)
	if err != nil {
		return result, err
	}
	input, info, err := sourcePath(source)
	if err != nil {
		return result, err
	}
	if info.IsDir() && inside(input, root) {
		return result, errors.New("来源目录不能包含整个应用库，以免递归复制")
	}
	target := filepath.Join(root, name)
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		return result, errors.New("应用目录已存在，请换一个目录名")
	}
	stage, err := os.MkdirTemp(root, ".app-runner-new-")
	if err != nil {
		return result, err
	}
	keep := false
	defer func() {
		if !keep {
			_ = removeTree(stage)
		}
	}()
	content := filepath.Join(stage, "content")
	if err = os.Mkdir(content, 0755); err != nil {
		return result, err
	}
	if err = unpack(input, content); err != nil {
		return result, fmt.Errorf("准备应用文件失败：%w", err)
	}
	entries := entryCandidates(content)
	// A provided app.ico is also available at the launcher metadata level.
	if path, iconInfo, iconErr := iconFile(content); iconErr == nil {
		if err = copyFile(path, filepath.Join(stage, "app.ico"), iconInfo.Mode().Perm()); err != nil {
			return result, err
		}
	}
	result = NewAppInfo{Token: uuid.NewString(), Name: name, Source: source, Target: filepath.Join(s.library, name), Entries: entries}
	if s.imports == nil {
		s.imports = map[string]appImport{}
	}
	s.imports[result.Token] = appImport{info: result, stage: stage, library: root}
	keep = true
	return result, nil
}
func (s *Store) CheckNewEntry(token, entry string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending, ok := s.imports[token]
	if !ok {
		return false
	}
	_, err := ResolveEntry(App{Directory: pending.stage}, entry)
	return err == nil
}
func (s *Store) CommitNewApp(token string, profile Profile) (App, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := App{}
	pending, ok := s.imports[token]
	if !ok {
		return result, errors.New("新建应用已取消或失效，请重新选择来源")
	}
	profile.UUID = token
	profile.Title = strings.TrimSpace(profile.Title)
	profile.Entry = strings.TrimSpace(profile.Entry)
	profile.Category = normalizeCategory(profile.Category)
	if err := Validate(profile); err != nil {
		return result, err
	}
	if _, err := ResolveEntry(App{Directory: pending.stage}, profile.Entry); err != nil {
		return result, fmt.Errorf("启动入口无效：%w", err)
	}
	currentRoot, err := filepath.EvalSymlinks(s.library)
	if err != nil || !strings.EqualFold(currentRoot, pending.library) {
		return result, errors.New("应用库路径已更改，请重新新建应用")
	}
	target := filepath.Join(pending.library, pending.info.Name)
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		return result, errors.New("应用目录已存在，未覆盖已有应用")
	}
	data, err := toml.Marshal(profile)
	if err != nil {
		return result, err
	}
	if err = atomicWrite(filepath.Join(pending.stage, "app.toml"), data); err != nil {
		return result, err
	}
	if err = os.Rename(pending.stage, target); err != nil {
		return result, err
	}
	result = App{Directory: filepath.Join(s.library, pending.info.Name), Profile: profile}
	if info, err := os.Stat(filepath.Join(target, "content")); err == nil {
		modified := info.ModTime()
		result.Modified = &modified
	}
	refreshMetadata(&result)
	s.apps[token] = result
	delete(s.imports, token)
	return result, nil
}
func (s *Store) DiscardNewApp(token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	pending, ok := s.imports[token]
	if !ok {
		return nil
	}
	if !inside(pending.library, pending.stage) || !strings.HasPrefix(filepath.Base(pending.stage), ".app-runner-new-") {
		return errors.New("暂存路径无效")
	}
	if err := removeTree(pending.stage); err != nil {
		return err
	}
	delete(s.imports, token)
	return nil
}

// reclaimStaging removes staging directories left behind by a crash or a forced
// exit; directories still owned by a pending import are kept.
func (s *Store) reclaimStaging(entries []os.DirEntry) {
	active := map[string]bool{}
	for _, pending := range s.imports {
		active[filepath.Base(pending.stage)] = true
	}
	for _, item := range entries {
		name := item.Name()
		if !item.IsDir() || item.Type()&os.ModeSymlink != 0 || !strings.HasPrefix(strings.ToLower(name), ".app-runner-new-") || active[name] {
			continue
		}
		if path := filepath.Join(s.library, name); inside(s.library, path) {
			_ = removeTree(path)
		}
	}
}

func (s *Store) CleanupImports() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, pending := range s.imports {
		if inside(pending.library, pending.stage) && strings.HasPrefix(filepath.Base(pending.stage), ".app-runner-new-") {
			if removeTree(pending.stage) == nil {
				delete(s.imports, token)
			}
		}
	}
}
