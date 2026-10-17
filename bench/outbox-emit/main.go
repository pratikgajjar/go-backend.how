// Benchmark: pg_logical_emit_message latency on localhost (unix socket).
// Workload mirrors factlib's per-fact pattern:
//   BEGIN; INSERT (business write); SELECT pg_logical_emit_message; COMMIT
// We time JUST the SELECT (matches factlib_event_processing_seconds histogram).
//
// Run with `go run main.go` after `go mod init bench && go get github.com/jackc/pgx/v5`.
package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	connStr   = "postgres://postgres@/bench?host=127.0.0.1&port=5599&sslmode=disable"
	prefix    = "demo-bench"
	payloadKB = 1
	warmup    = 500
	N         = 10000
)

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(float64(len(sorted)-1) * p)
	return sorted[idx]
}

func main() {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, connStr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "connect:", err)
		os.Exit(1)
	}
	defer conn.Close(ctx)

	payload := make([]byte, payloadKB*1024)
	if _, err := rand.Read(payload); err != nil {
		panic(err)
	}

	emitSQL := "SELECT pg_logical_emit_message(true, $1, $2::bytea)"
	insertSQL := "INSERT INTO dummy(v) VALUES ($1)"
	smallVal := []byte("biz") // simulate small business-row payload

	// Warmup
	for i := 0; i < warmup; i++ {
		tx, err := conn.Begin(ctx)
		if err != nil {
			panic(err)
		}
		if _, err := tx.Exec(ctx, insertSQL, smallVal); err != nil {
			panic(err)
		}
		if _, err := tx.Exec(ctx, emitSQL, prefix, payload); err != nil {
			panic(err)
		}
		if err := tx.Commit(ctx); err != nil {
			panic(err)
		}
	}

	// Measured run
	durs := make([]time.Duration, 0, N)
	totalStart := time.Now()
	for i := 0; i < N; i++ {
		tx, err := conn.Begin(ctx)
		if err != nil {
			panic(err)
		}
		if _, err := tx.Exec(ctx, insertSQL, smallVal); err != nil {
			panic(err)
		}
		t0 := time.Now()
		if _, err := tx.Exec(ctx, emitSQL, prefix, payload); err != nil {
			panic(err)
		}
		durs = append(durs, time.Since(t0))
		if err := tx.Commit(ctx); err != nil {
			panic(err)
		}
	}
	wall := time.Since(totalStart)

	sort.Slice(durs, func(i, j int) bool { return durs[i] < durs[j] })
	fmt.Printf("payload      : %d KB\n", payloadKB)
	fmt.Printf("iterations   : %d (after %d warmup)\n", N, warmup)
	fmt.Printf("wall time    : %v\n", wall)
	fmt.Printf("throughput   : %.0f emits/sec\n", float64(N)/wall.Seconds())
	fmt.Printf("emit (SELECT-only) latencies — txn = BEGIN; INSERT; EMIT; COMMIT\n")
	fmt.Printf("  min        : %v\n", durs[0])
	fmt.Printf("  p50        : %v\n", percentile(durs, 0.50))
	fmt.Printf("  p90        : %v\n", percentile(durs, 0.90))
	fmt.Printf("  p99        : %v\n", percentile(durs, 0.99))
	fmt.Printf("  p999       : %v\n", percentile(durs, 0.999))
	fmt.Printf("  max        : %v\n", durs[len(durs)-1])
}
