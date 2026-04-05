package main

// Absurd retry benchmark: run a 3-step task where step 1 fails N times
// before succeeding. Measures the SQL-cost of retries.
//
// Uses retry_strategy = {kind: "fixed", delay: "100ms"} and max_attempts = N+2.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type RetryParams struct {
	ID         string `json:"id"`
	FailCount  int    `json:"fail_count"`
	Activities int    `json:"activities"`
	WorkerKey  string `json:"worker_key"`
}

var (
	failureMu    sync.Mutex
	failureCount = make(map[string]int)
)

func runTask(ctx context.Context, db *pgxpool.Pool, queue string, taskID, runID string, params RetryParams) error {
	// Step 0 is flaky
	for i := 0; i < params.Activities; i++ {
		stepName := fmt.Sprintf("step-%d", i)

		// checkpoint read
		var stateBytes []byte
		row := db.QueryRow(ctx, `SELECT state FROM absurd.get_task_checkpoint_state($1, $2, $3)`,
			queue, taskID, stepName)
		if err := row.Scan(&stateBytes); err == nil && len(stateBytes) > 0 {
			continue
		}

		// Simulate failure for first step, first N attempts
		if i == 0 {
			failureMu.Lock()
			key := fmt.Sprintf("%s:%s", params.WorkerKey, taskID)
			seen := failureCount[key]
			failureCount[key]++
			failureMu.Unlock()
			if seen < params.FailCount {
				return fmt.Errorf("transient failure %d/%d", seen+1, params.FailCount)
			}
		}

		// Write checkpoint
		result := fmt.Sprintf(`{"idx":%d}`, i)
		_, err := db.Exec(ctx, `SELECT absurd.set_task_checkpoint_state($1, $2, $3, $4, $5, $6)`,
			queue, taskID, stepName, []byte(result), runID, 30)
		if err != nil {
			return err
		}
	}

	// mark complete
	resultJSON := []byte(fmt.Sprintf(`{"id":%q,"done":true}`, params.ID))
	_, err := db.Exec(ctx, `SELECT absurd.complete_run($1, $2, $3)`, queue, runID, resultJSON)
	return err
}

type task struct {
	RunID      string
	TaskID     string
	TaskName   string
	Params     json.RawMessage
}

func pollWorker(ctx context.Context, db *pgxpool.Pool, queue, workerID string, wg *sync.WaitGroup, done chan struct{}) {
	defer wg.Done()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		default:
		}
		rows, err := db.Query(ctx, `SELECT run_id::text, task_id::text, task_name, params::text
			FROM absurd.claim_task($1, $2, $3, $4)`, queue, workerID, 30, 4)
		if err != nil {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		var tasks []task
		for rows.Next() {
			var t task
			var paramsStr string
			if err := rows.Scan(&t.RunID, &t.TaskID, &t.TaskName, &paramsStr); err != nil {
				continue
			}
			t.Params = json.RawMessage(paramsStr)
			tasks = append(tasks, t)
		}
		rows.Close()
		if len(tasks) == 0 {
			time.Sleep(5 * time.Millisecond)
			continue
		}
		for _, t := range tasks {
			var params RetryParams
			json.Unmarshal(t.Params, &params)
			params.WorkerKey = workerID
			if err := runTask(ctx, db, queue, t.TaskID, t.RunID, params); err != nil {
				failJSON := []byte(fmt.Sprintf(`{"message":%q}`, err.Error()))
				db.Exec(ctx, `SELECT absurd.fail_run($1, $2, $3, null)`, queue, t.RunID, failJSON)
			}
		}
	}
}

func main() {
	n := flag.Int("n", 100, "number of tasks")
	fails := flag.Int("fails", 0, "times step 0 fails before succeeding")
	activities := flag.Int("activities", 3, "total steps per task")
	workers := flag.Int("workers", 4, "worker goroutines")
	queue := flag.String("queue", "retryb", "queue name")
	flag.Parse()

	ctx := context.Background()
	dsn := os.Getenv("ABSURD_DSN")
	if dsn == "" {
		dsn = "postgres://myuser:mypassword@localhost:5432/absurd?sslmode=disable"
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()

	_, _ = pool.Exec(ctx, `SELECT absurd.create_queue($1)`, *queue)

	// Spawn N tasks
	maxAttempts := *fails + 2
	opts, _ := json.Marshal(map[string]interface{}{
		"max_attempts":   maxAttempts,
		"retry_strategy": map[string]string{"kind": "fixed", "delay": "50ms"},
	})

	for i := 0; i < *n; i++ {
		taskParams, _ := json.Marshal(RetryParams{
			ID:         fmt.Sprintf("t%d", i),
			FailCount:  *fails,
			Activities: *activities,
		})
		_, err := pool.Exec(ctx, `SELECT task_id FROM absurd.spawn_task($1, $2, $3::jsonb, $4::jsonb)`,
			*queue, "retry_task", taskParams, opts)
		if err != nil {
			log.Fatal("spawn:", err)
		}
	}

	// Start workers
	start := time.Now()
	done := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < *workers; i++ {
		wg.Add(1)
		go pollWorker(ctx, pool, *queue, fmt.Sprintf("w-%d", i), &wg, done)
	}

	// Poll for completion
	for {
		var completed int
		pool.QueryRow(ctx, fmt.Sprintf(`SELECT count(*) FROM absurd.t_%s WHERE state='completed'`, *queue)).Scan(&completed)
		if completed >= *n {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	elapsed := time.Since(start)
	close(done)
	wg.Wait()

	fmt.Printf("n=%d fails=%d activities=%d elapsed=%s tput=%.1f/s\n",
		*n, *fails, *activities, elapsed, float64(*n)/elapsed.Seconds())
}
