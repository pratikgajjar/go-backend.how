package main

// Absurd worker that runs N checkpointed steps, parametrized by the task's params.

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

type VarParams struct {
	ID       string `json:"id"`
	Steps    int    `json:"steps"`
}

type claimedTask struct {
	RunID    string
	TaskID   string
	TaskName string
	Params   json.RawMessage
}

func runTask(ctx context.Context, db *pgxpool.Pool, queue string, t claimedTask) error {
	var params VarParams
	if err := json.Unmarshal(t.Params, &params); err != nil {
		return err
	}
	for i := 0; i < params.Steps; i++ {
		stepName := fmt.Sprintf("step-%d", i)

		// checkpoint read
		var stateBytes []byte
		row := db.QueryRow(ctx, `SELECT state FROM absurd.get_task_checkpoint_state($1, $2, $3)`,
			queue, t.TaskID, stepName)
		if err := row.Scan(&stateBytes); err == nil && len(stateBytes) > 0 {
			continue
		}

		// write checkpoint
		result := fmt.Sprintf(`{"idx":%d,"id":%q}`, i, params.ID)
		_, err := db.Exec(ctx, `SELECT absurd.set_task_checkpoint_state($1, $2, $3, $4, $5, $6)`,
			queue, t.TaskID, stepName, []byte(result), t.RunID, 30)
		if err != nil {
			return err
		}
	}

	// mark complete
	resultJSON := []byte(fmt.Sprintf(`{"id":%q,"steps":%d}`, params.ID, params.Steps))
	_, err := db.Exec(ctx, `SELECT absurd.complete_run($1, $2, $3)`, queue, t.RunID, resultJSON)
	return err
}

func worker(ctx context.Context, db *pgxpool.Pool, queue, workerID string, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		if ctx.Err() != nil {
			return
		}
		rows, err := db.Query(ctx, `SELECT run_id::text, task_id::text, task_name, params::text
			FROM absurd.claim_task($1, $2, $3, $4)`, queue, workerID, 30, 4)
		if err != nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		var tasks []claimedTask
		for rows.Next() {
			var t claimedTask
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
			if err := runTask(ctx, db, queue, t); err != nil {
				log.Printf("run failed: %v", err)
				failJSON := []byte(fmt.Sprintf(`{"message":%q}`, err.Error()))
				db.Exec(ctx, `SELECT absurd.fail_run($1, $2, $3, null)`, queue, t.RunID, failJSON)
			}
		}
	}
}

func main() {
	workers := flag.Int("workers", 8, "number of worker goroutines")
	queue := flag.String("queue", "var", "queue name")
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
	log.Printf("Absurd var-worker: %d goroutines, queue=%s", *workers, *queue)
	var wg sync.WaitGroup
	for i := 0; i < *workers; i++ {
		wg.Add(1)
		go worker(ctx, pool, *queue, fmt.Sprintf("w-%d", i), &wg)
	}
	select {}
}
