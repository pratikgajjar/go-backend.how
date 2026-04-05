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

type OrderParams struct {
	OrderID string   `json:"order_id"`
	Amount  int64    `json:"amount"`
	Items   []string `json:"items"`
	Email   string   `json:"email"`
}

func main() {
	total := flag.Int("n", 1000, "number of tasks to spawn")
	concurrency := flag.Int("c", 32, "concurrent spawns")
	waitFinish := flag.Bool("wait", true, "wait for tasks to finish")
	queue := flag.String("queue", "default", "queue name")
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

	// Make sure the queue exists.
	_, err = pool.Exec(ctx, `SELECT absurd.create_queue($1)`, *queue)
	if err != nil {
		log.Fatalln("create_queue:", err)
	}

	log.Printf("Spawning %d Absurd tasks with concurrency=%d wait=%v", *total, *concurrency, *waitFinish)

	start := time.Now()
	var spawnedCount int64
	var failedCount int64
	taskIDs := make([]string, *total)
	var wg sync.WaitGroup
	sem := make(chan struct{}, *concurrency)

	for i := 0; i < *total; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()

			params := OrderParams{
				OrderID: fmt.Sprintf("order-%d-%d", time.Now().UnixNano(), i),
				Amount:  int64(1000 + i),
				Items:   []string{"widget-1", "gadget-2"},
				Email:   "c@example.com",
			}
			paramsJSON, _ := json.Marshal(params)

			var taskID, runID string
			var attempt int
			var created bool
			err := pool.QueryRow(ctx,
				`SELECT task_id::text, run_id::text, attempt, created FROM absurd.spawn_task($1, $2, $3, $4)`,
				*queue, "order-fulfillment", paramsJSON, []byte(`{}`)).Scan(&taskID, &runID, &attempt, &created)
			if err != nil {
				atomic.AddInt64(&failedCount, 1)
				return
			}
			taskIDs[i] = taskID
			atomic.AddInt64(&spawnedCount, 1)
		}(i)
	}
	wg.Wait()
	spawnElapsed := time.Since(start)

	fmt.Printf("\nSpawned %d tasks in %s (%.1f/sec)\n", atomic.LoadInt64(&spawnedCount),
		spawnElapsed, float64(atomic.LoadInt64(&spawnedCount))/spawnElapsed.Seconds())

	if !*waitFinish {
		return
	}

	// Poll for completion
	fmt.Println("Waiting for completion...")
	var completedCount int64
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		var c int64
		err := pool.QueryRow(ctx, fmt.Sprintf(`
			SELECT count(*) FROM absurd.%q WHERE task_id = ANY($1::uuid[]) AND state = 'completed'`,
			"t_"+*queue), taskIDs).Scan(&c)
		if err != nil {
			log.Printf("poll error: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		completedCount = c
		if int(completedCount) >= *total {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	elapsed := time.Since(start)
	fmt.Printf("\n===== Absurd benchmark =====\n")
	fmt.Printf("Spawned:     %d in %s\n", atomic.LoadInt64(&spawnedCount), spawnElapsed)
	fmt.Printf("Completed:   %d\n", completedCount)
	fmt.Printf("Total time:  %s\n", elapsed)
	fmt.Printf("Throughput:  %.1f tasks/sec\n", float64(completedCount)/elapsed.Seconds())
}
