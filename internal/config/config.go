// SPDX-License-Identifier: GPL-3.0-or-later
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Config mirrors the JSON shape of ~/.config/m3uHandler/config.json
type Config struct {
	URL              string  `json:"url,omitempty"`
	URLTv            string  `json:"urlTv,omitempty"`
	URLMovies        string  `json:"urlMovies,omitempty"`
	URLEvents        string  `json:"urlEvents,omitempty"`
	Out              string  `json:"out,omitempty"`
	IncludeLive      bool    `json:"includeLive,omitempty"`
	MoviesFlat       bool    `json:"moviesFlat,omitempty"`
	MoviesByFolder   bool    `json:"moviesByFolder,omitempty"`
	MoviesByYearFolder bool  `json:"moviesByYearFolder,omitempty"`
	IntervalHours    float64 `json:"intervalHours,omitempty"`
}

func configDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "m3uHandler"), nil
}

func ConfigPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func Load() (*Config, error) {
	p, err := ConfigPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func Save(cfg *Config) (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	p := filepath.Join(dir, "config.json")
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(p, data, 0o600); err != nil {
		return "", err
	}
	return p, nil
}
