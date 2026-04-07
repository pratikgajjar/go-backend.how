package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type VarParams struct {
	ID    string `json:"id"`
	Steps int    `json:"steps"`
}

func main() {
	n := flag.Int("n", 200, "number of tasks")
	c := flag.Int("c", 32, "concurrency")
	steps := flag.Int("steps", 3, "steps per task")
	queue := flag.String("queue", "var", "queue")
	reset := flag.Bool("reset", true, "reset stats + drop/recreate queue before run")
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

	if *reset {
		_, _ = pool.Exec(ctx, `SELECT absurd.drop_queue($1)`, *queue)
	}
	_, _ = pool.Exec(ctx, `SELECT absurd.create_queue($1)`, *queue)

	// Wait for old worker to notice new tables, reset stats fresh
	time.Sleep(200 * time.Millisecond)
	_, _ = pool.Exec(ctx, `SELECT pg_stat_statements_reset()`)

	start := time.Now()
	var spawned int64
	var wg sync.WaitGroup
	sem := make(chan struct{}, *c)
	for i := 0; i < *n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			params := VarParams{ID: fmt.Sprintf("task-%d-%d", time.Now().UnixNano(), i), Steps: *steps}
			paramsJSON, _ := json.Marshal(params)
			var taskID, runID string
			var attempt int
			var created bool
			err := pool.QueryRow(ctx,
				`SELECT task_id::text, run_id::text, attempt, created FROM absurd.spawn_task($1, $2, $3, $4)`,
				*queue, "var-task", paramsJSON, []byte(`{}`)).Scan(&taskID, &runID, &attempt, &created)
			if err != nil {
				return
			}
			_ = taskID
			_ = runID
			_ = attempt
			_ = created
			atomic.AddInt64(&spawned, 1)
		}(i)
	}
	wg.Wait()

	var completed int64
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		var x int64
		_ = pool.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM absurd.%q WHERE state='completed'`,
			"t_"+*queue)).Scan(&x)
		completed = x
		if int(completed) >= *n {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	elapsed := time.Since(start)

	var totalCalls int64
	_ = pool.QueryRow(ctx, `SELECT coalesce(sum(calls),0)::bigint FROM pg_stat_statements
		WHERE query NOT LIKE '%pg_stat_statements%'
		  AND query NOT LIKE 'BEGIN%' AND query NOT LIKE 'COMMIT%'
		  AND query NOT LIKE 'SET %' AND query NOT LIKE 'DEALLOCATE%'
		  AND query NOT LIKE '%drop_queue%'`).Scan(&totalCalls)

	perTask := float64(totalCalls) / float64(*n)
	fmt.Printf("steps=%d n=%d completed=%d total_sql=%d per_task=%.1f elapsed=%s tput=%.1f/s\n",
		*steps, *n, completed, totalCalls, perTask, elapsed, float64(completed)/elapsed.Seconds())
}
