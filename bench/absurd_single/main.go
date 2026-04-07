package main

// Spawn one Absurd task at a time, wait for it to finish, measure the
// full round-trip. Repeat N times.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type VarParams struct {
	ID    string `json:"id"`
	Steps int    `json:"steps"`
}

func main() {
	n := flag.Int("n", 50, "number of tasks")
	steps := flag.Int("steps", 3, "steps per task")
	queue := flag.String("queue", "solo", "queue")
	flag.Parse()

	ctx := context.Background()
	dsn := os.Getenv("ABSURD_DSN")
	if dsn == "" {
		dsn = "postgres://myuser:mypassword@localhost:5432/absurd?sslmode=disable"
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalln("pool:", err)
	}
	defer pool.Close()
	_, _ = pool.Exec(ctx, `SELECT absurd.create_queue($1)`, *queue)

	latencies := []float64{}
	for i := 0; i < *n; i++ {
		params := VarParams{ID: fmt.Sprintf("solo-%d-%d", time.Now().UnixNano(), i), Steps: *steps}
		paramsJSON, _ := json.Marshal(params)

		t0 := time.Now()
		var taskID, runID string
		var attempt int
		var created bool
		err := pool.QueryRow(ctx,
			`SELECT task_id::text, run_id::text, attempt, created FROM absurd.spawn_task($1, $2, $3, $4)`,
			*queue, "solo-task", paramsJSON, []byte(`{}`)).Scan(&taskID, &runID, &attempt, &created)
		if err != nil {
			log.Printf("spawn error: %v", err)
			continue
		}
		_ = runID
		_ = attempt
		_ = created
		// poll for completion
		for {
			var state string
			err := pool.QueryRow(ctx, fmt.Sprintf(`SELECT state FROM absurd.%q WHERE task_id=$1`, "t_"+*queue), taskID).Scan(&state)
			if err != nil {
				break
			}
			if state == "completed" || state == "failed" {
				break
			}
			time.Sleep(1 * time.Millisecond)
		}
		latencies = append(latencies, float64(time.Since(t0).Microseconds())/1000.0)
	}

	sort.Float64s(latencies)
	p := func(q float64) float64 {
		if len(latencies) == 0 {
			return 0
		}
		i := int(q * float64(len(latencies)-1))
		return latencies[i]
	}
	fmt.Printf("steps=%d n=%d  p50=%.1f p90=%.1f p99=%.1f max=%.1f  mean=%.1f ms\n",
		*steps, *n, p(0.5), p(0.9), p(0.99), p(1.0), average(latencies))
}

func average(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	var s float64
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}
