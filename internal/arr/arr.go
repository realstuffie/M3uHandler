// SPDX-License-Identifier: GPL-3.0-or-later

// Package arr provides shared utilities for *arr-family API clients
// (Radarr, Sonarr, etc.): an HTTP client, exponential-backoff retry,
// bounded-concurrency map, and atomic JSON file helpers.
package arr

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"m3uhandler/internal/logger"
)

// ---- HTTP client -----------------------------------------------------------

// Client is a minimal JSON API client for *arr applications.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// NewClient returns a Client with a 120-second timeout.
func NewClient(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL:    baseURL,
		APIKey:     apiKey,
		HTTPClient: &http.Client{Timeout: 120 * time.Second},
	}
}

// APIError is returned when the server responds with a non-2xx status.
type APIError struct {
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("API error %d: %s", e.Status, e.Body)
}

func (c *Client) do(method, path string, query map[string]string, body any) ([]byte, int, error) {
	var bodyR io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		bodyR = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, bodyR)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("X-Api-Key", c.APIKey)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	q := req.URL.Query()
	for k, v := range query {
		q.Set(k, v)
	}
	req.URL.RawQuery = q.Encode()

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	return data, resp.StatusCode, err
}

// GetJSON performs a GET and JSON-decodes the response body into out.
func (c *Client) GetJSON(path string, query map[string]string, out any) error {
	data, status, err := c.do("GET", path, query, nil)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return &APIError{Status: status, Body: string(data)}
	}
	return json.Unmarshal(data, out)
}

// PostJSON performs a POST with body serialised as JSON and decodes the response into out (may be nil).
func (c *Client) PostJSON(path string, body, out any) error {
	data, status, err := c.do("POST", path, nil, body)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return &APIError{Status: status, Body: string(data)}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// ---- Retry -----------------------------------------------------------------

// WithRetries calls fn, retrying on 429 / 5xx responses with exponential
// back-off. It gives up after maxRetries attempts or on any non-retryable error.
func WithRetries(fn func() error, log *logger.Logger) error {
	const (
		maxRetries = 5
		baseDelay  = 500 * time.Millisecond
		maxDelay   = 10 * time.Second
	)
	for attempt := 0; ; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		var ae *APIError
		retryable := errors.As(err, &ae) && (ae.Status == 429 || (ae.Status >= 500 && ae.Status <= 599))
		if !retryable || attempt >= maxRetries {
			return err
		}
		delay := time.Duration(math.Min(float64(maxDelay),
			float64(baseDelay)*math.Pow(2, float64(attempt))))
		log.Warnf("Retrying after error (attempt %d/%d, delay %s): %v",
			attempt+1, maxRetries, delay, err)
		time.Sleep(delay)
	}
}

// ---- Concurrency -----------------------------------------------------------

// MapConcurrent runs fn(i) for i in [0, n) using at most concurrency
// goroutines, using a work-stealing loop so no goroutine sits idle while
// work remains.
func MapConcurrent(n, concurrency int, fn func(i int)) {
	if n == 0 {
		return
	}
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > n {
		concurrency = n
	}
	var idx int64 = -1
	var wg sync.WaitGroup
	for w := 0; w < concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(atomic.AddInt64(&idx, 1))
				if i >= n {
					return
				}
				fn(i)
			}
		}()
	}
	wg.Wait()
}

// ---- JSON file helpers -----------------------------------------------------

// ReadJSONFile reads p and JSON-decodes its contents into out.
// Silently returns if the file is missing or malformed.
func ReadJSONFile(p string, out any) {
	data, err := os.ReadFile(p)
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, out)
}

// WriteJSONAtomic writes v as indented JSON to p using a write-then-rename
// strategy so the file is never seen in a partial state.
func WriteJSONAtomic(p string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}
