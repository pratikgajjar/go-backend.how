package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

type health struct {
	Ok         bool   `json:"ok"`
	Hostname   string `json:"hostname"`
	UptimeMs   int64  `json:"uptime_ms"`
	Goroutines int    `json:"goroutines"`
	GoVersion  string `json:"go_version"`
}

var (
	bootedAt = time.Now()
	reqs     = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "app_reqs_total"}, []string{"path"})
)

func main() {
	prometheus.MustRegister(reqs)
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, req *http.Request) {
		hn, _ := os.Hostname()
		reqs.WithLabelValues("/healthz").Inc()
		_ = json.NewEncoder(w).Encode(health{
			Ok: true, Hostname: hn,
			UptimeMs:   time.Since(bootedAt).Milliseconds(),
			Goroutines: runtime.NumGoroutine(),
			GoVersion:  runtime.Version(),
		})
	})
	r.Get("/hash", func(w http.ResponseWriter, req *http.Request) {
		buf := make([]byte, 1024)
		_, _ = rand.Read(buf)
		sum := sha256.Sum256(buf)
		fmt.Fprintln(w, hex.EncodeToString(sum[:]))
	})
	r.Handle("/metrics", promhttp.Handler())

	addr := ":8080"
	if v := os.Getenv("ADDR"); v != "" {
		addr = v
	}
	srv := &http.Server{Addr: addr, Handler: r, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.ListenAndServe() }()
	logger.Info("ready", zap.String("addr", addr), zap.Duration("boot", time.Since(bootedAt)))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	_ = srv.Shutdown(context.Background())
}
