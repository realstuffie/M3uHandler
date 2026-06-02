// SPDX-License-Identifier: GPL-3.0-or-later
package logger

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const DefaultLogPath = "output/m3uHandler.log"

// Logger writes structured log lines to a file and mirrors them to stdout/stderr.
// The log file is opened lazily on the first write and kept open for the
// lifetime of the Logger (avoiding open+write+close overhead per line).
type Logger struct {
	LogPath string
	mu      sync.Mutex
	file    *os.File // nil until first write
}

// New creates a Logger. logPath is resolved from (in order):
// the argument, M3UHANDLER_LOG_PATH env var, DefaultLogPath.
func New(logPath string) *Logger {
	if logPath == "" {
		logPath = os.Getenv("M3UHANDLER_LOG_PATH")
	}
	if logPath == "" {
		logPath = DefaultLogPath
	}
	return &Logger{LogPath: logPath}
}

// Close flushes and closes the underlying log file. Safe to call more than once.
func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}
}

// openLocked ensures the log file is open. Must be called with l.mu held.
func (l *Logger) openLocked() {
	if l.file != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(l.LogPath), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(l.LogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	l.file = f
}

func (l *Logger) write(level, msg string) {
	ts := time.Now().UTC().Format(time.RFC3339Nano)
	line := fmt.Sprintf("[%s] %s: %s\n", ts, strings.ToUpper(level), msg)

	// Mirror to console (outside the lock — stdout/stderr are internally synced).
	if level == "error" || level == "warn" {
		fmt.Fprint(os.Stderr, line)
	} else {
		fmt.Fprint(os.Stdout, line)
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	l.openLocked()
	if l.file != nil {
		_, _ = l.file.WriteString(line)
	}
}

func (l *Logger) Debug(msg string)          { l.write("debug", msg) }
func (l *Logger) Info(msg string)           { l.write("info", msg) }
func (l *Logger) Warn(msg string)           { l.write("warn", msg) }
func (l *Logger) Error(msg string)          { l.write("error", msg) }
func (l *Logger) Infof(f string, a ...any)  { l.Info(fmt.Sprintf(f, a...)) }
func (l *Logger) Warnf(f string, a ...any)  { l.Warn(fmt.Sprintf(f, a...)) }
func (l *Logger) Errorf(f string, a ...any) { l.Error(fmt.Sprintf(f, a...)) }
