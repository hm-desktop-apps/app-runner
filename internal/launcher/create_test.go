package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateDirectoryOnlyDeploysOnValidSave(t *testing.T) {
	library := t.TempDir()
	source := t.TempDir()
	write(t, filepath.Join(source, "bin", "app.exe"), "application")
	write(t, filepath.Join(source, "data", "notes.txt"), "source data")
	store := NewStore(library)
	info, err := store.PrepareNewApp(source, "manual-name")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(library, "manual-name")); !os.IsNotExist(err) {
		t.Fatal("deployed before save")
	}
	if len(scan(t, store).Apps) != 0 {
		t.Fatal("staged draft appeared in library")
	}
	if !store.CheckNewEntry(info.Token, "bin/app.exe") || store.CheckNewEntry(info.Token, "../escape.exe") {
		t.Fatal("entry preview mismatch")
	}
	profile := Profile{Type: "GUI", Entry: "bin/app.exe"}
	if _, err := store.CommitNewApp(info.Token, profile); err == nil {
		t.Fatal("missing title accepted")
	}
	profile.Title = "New application"
	profile.Entry = "missing.exe"
	if _, err := store.CommitNewApp(info.Token, profile); err == nil {
		t.Fatal("missing entry accepted")
	}
	profile.Entry = "bin/app.exe"
	profile.Description = "free notes\nline 2"
	profile.Category = "开发工具"
	saved, err := store.CommitNewApp(info.Token, profile)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.EntryValid || saved.Description != profile.Description || saved.UUID != info.Token {
		t.Fatal("deployed metadata mismatch")
	}
	if read(t, filepath.Join(saved.Directory, "content", "data", "notes.txt")) != "source data" {
		t.Fatal("source tree was not copied")
	}
	if read(t, filepath.Join(source, "bin", "app.exe")) != "application" {
		t.Fatal("source modified")
	}
	if len(scan(t, store).Apps) != 1 {
		t.Fatal("deployed app missing from scan")
	}
	store.CleanupImports()
	if _, err := os.Stat(saved.Directory); err != nil {
		t.Fatal("cleanup removed deployed application")
	}
}
func TestCreateEntryCandidatesStayInContentRootAndBin(t *testing.T) {
	library := t.TempDir()
	source := t.TempDir()
	write(t, filepath.Join(source, "Tool.EXE"), "root executable")
	write(t, filepath.Join(source, "bin", "tool.exe"), "bin executable")
	write(t, filepath.Join(source, "bin", "helper", "nested.exe"), "nested executable")
	write(t, filepath.Join(source, "resources", "app", "deep.exe"), "deep executable")
	store := NewStore(library)
	info, err := store.PrepareNewApp(source, "scoped-entries")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.CleanupImports)
	if got := strings.Join(info.Entries, ","); got != "Tool.EXE,bin/tool.exe" {
		t.Fatalf("entry candidates = %q, want content root before content/bin and nothing deeper", got)
	}
}
func TestScanReclaimsCrashedStagingWithoutTouchingPendingImports(t *testing.T) {
	library := t.TempDir()
	stale := filepath.Join(library, ".app-runner-new-crashed")
	write(t, filepath.Join(stale, "content", "app.exe"), "stale copy")
	store := NewStore(library)
	if len(scan(t, store).Apps) != 0 {
		t.Fatal("staging directory appeared as an application")
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("crashed staging directory was not reclaimed")
	}
	source := t.TempDir()
	write(t, filepath.Join(source, "app.exe"), "fresh copy")
	info, err := store.PrepareNewApp(source, "pending-app")
	if err != nil {
		t.Fatal(err)
	}
	scan(t, store)
	if !store.CheckNewEntry(info.Token, "app.exe") {
		t.Fatal("scan removed the pending import")
	}
}
func TestCreateArchivesCancelCollisionAndUnsafeNames(t *testing.T) {
	library := t.TempDir()
	source := filepath.Join(t.TempDir(), "My App ZIP.zip")
	zipPackage(t, source, map[string]string{"Release/app.exe": "archive app", "Release/settings/file.txt": "setting"})
	store := NewStore(library)
	info, err := store.PrepareNewApp(source, "archive-app")
	if err != nil {
		t.Fatal(err)
	}
	if !store.CheckNewEntry(info.Token, "app.exe") {
		t.Fatal("archive wrapper not stripped")
	}
	if err := store.DiscardNewApp(info.Token); err != nil {
		t.Fatal(err)
	}
	if store.CheckNewEntry(info.Token, "app.exe") {
		t.Fatal("canceled source retained")
	}
	entries, _ := os.ReadDir(library)
	if len(entries) != 0 {
		t.Fatal("cancel left staged files")
	}
	info, err = store.PrepareNewApp(source, "archive-app")
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(library, "archive-app", "keep.txt"), "do not replace")
	if _, err := store.CommitNewApp(info.Token, Profile{Title: "App", Type: "GUI", Entry: "app.exe"}); err == nil {
		t.Fatal("existing directory overwritten")
	}
	if read(t, filepath.Join(library, "archive-app", "keep.txt")) != "do not replace" {
		t.Fatal("collision changed existing files")
	}
	store.CleanupImports()
	if _, err := store.PrepareNewApp("", "missing-source"); err == nil {
		t.Fatal("empty source accepted")
	}
	for _, name := range []string{"", "..", "../escape", `C:\escape`, "CON", "aux.txt", "app.", "bad:name", ".app-runner-new-fake"} {
		if _, err := store.PrepareNewApp(source, name); err == nil {
			t.Fatalf("unsafe name accepted: %q", name)
		}
	}
	if _, err := store.PrepareNewApp(library, "recursive"); err == nil {
		t.Fatal("recursive library import accepted")
	}
	unsafe := filepath.Join(t.TempDir(), "unsafe.zip")
	zipPackage(t, unsafe, map[string]string{"../escape.exe": "bad"})
	if _, err := store.PrepareNewApp(unsafe, "unsafe-app"); err == nil {
		t.Fatal("unsafe archive accepted")
	}
	if _, err := os.Stat(filepath.Join(library, "unsafe-app")); !os.IsNotExist(err) {
		t.Fatal("failed prepare deployed app")
	}
}
func TestCreateSevenZipWithoutExternalTool(t *testing.T) {
	library := t.TempDir()
	store := NewStore(library)
	info, err := store.PrepareNewApp(filepath.Join("testdata", "update.7z"), "sevenzip-app")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.CommitNewApp(info.Token, Profile{Title: "Sevenzip", Type: "GUI", Entry: "app.exe"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimPrefix(read(t, filepath.Join(saved.Directory, "content", "app.exe")), "\ufeff") != "sevenzip version" {
		t.Fatal("7z create failed")
	}
}

func TestCreateArchivesIgnoresExternalTools(t *testing.T) {
	for _, format := range []string{"zip", "7z"} {
		t.Run(format, func(t *testing.T) {
			library := t.TempDir()
			// A bogus executable in the old preferred location must never be invoked.
			write(t, filepath.Join(library, "7za", "content", "7za.exe"), "not an executable")
			store := NewStore(library)
			source := filepath.Join("testdata", "update.7z")
			expected := "sevenzip version"
			if format == "zip" {
				source = filepath.Join(t.TempDir(), "application.zip")
				expected = "zip version"
				zipPackage(t, source, map[string]string{"Release/app.exe": expected})
			}
			info, err := store.PrepareNewApp(source, "builtin-app")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(store.CleanupImports)
			saved, err := store.CommitNewApp(info.Token, Profile{Title: "Built-in extraction", Type: "GUI", Entry: "app.exe"})
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.TrimPrefix(read(t, filepath.Join(saved.Directory, "content", "app.exe")), "\ufeff"); got != expected {
				t.Fatalf("extracted content = %q, want %q", got, expected)
			}
		})
	}
}
