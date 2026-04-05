package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This Absurd worker talks directly to Postgres stored procedures.
// It's a minimal, transparent implementation — you can read it in one sitting
// and understand every SQL call.

type OrderParams struct {
	OrderID string   `json:"order_id"`
	Amount  int64    `json:"amount"`
	Items   []string `json:"items"`
	Email   string   `json:"email"`
}

type claimedTask struct {
	RunID          string          `json:"run_id"`
	TaskID         string          `json:"task_id"`
	Attempt        int             `json:"attempt"`
	TaskName       string          `json:"task_name"`
	Params         json.RawMessage `json:"params"`
	RetryStrategy  json.RawMessage `json:"retry_strategy"`
	MaxAttempts    *int            `json:"max_attempts"`
	Headers        json.RawMessage `json:"headers"`
	WakeEvent      *string         `json:"wake_event"`
	EventPayload   json.RawMessage `json:"event_payload"`
}

// Step wraps a checkpoint call. If the checkpoint exists, it returns the
// cached value. Otherwise it runs fn, stores the result, and returns it.
func step[T any](ctx context.Context, db *pgxpool.Pool, queue, taskID, runID, stepName string, fn func() (T, error)) (T, error) {
	var zero T

	// Read checkpoint — this is the replay path.
	var stateBytes []byte
	row := db.QueryRow(ctx, `SELECT state FROM absurd.get_task_checkpoint_state($1, $2, $3)`, queue, taskID, stepName)
	if err := row.Scan(&stateBytes); err == nil && len(stateBytes) > 0 {
		// Checkpoint hit — return cached value.
		var v T
		if err := json.Unmarshal(stateBytes, &v); err != nil {
			return zero, err
		}
		return v, nil
	} else if err != nil && err != pgx.ErrNoRows {
		// Ignore no-rows; any other error is fatal.
	}

	// Execute step fresh.
	result, err := fn()
	if err != nil {
		return zero, err
	}

	// Write checkpoint.
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return zero, err
	}
	_, err = db.Exec(ctx, `SELECT absurd.set_task_checkpoint_state($1, $2, $3, $4, $5, $6)`,
		queue, taskID, stepName, resultJSON, runID, 30)
	if err != nil {
		return zero, err
	}
	return result, nil
}

type PaymentResult struct {
	PaymentID string `json:"payment_id"`
	Amount    int64  `json:"amount"`
}

type InventoryResult struct {
	ReservedItems []string `json:"reserved_items"`
}

type NotificationResult struct {
	SentTo string `json:"sent_to"`
}

func runOrderFulfillment(ctx context.Context, db *pgxpool.Pool, queue string, t claimedTask) error {
	var params OrderParams
	if err := json.Unmarshal(t.Params, &params); err != nil {
		return err
	}

	_, err := step(ctx, db, queue, t.TaskID, t.RunID, "process-payment",
		func() (PaymentResult, error) {
			return PaymentResult{PaymentID: "pay-" + params.OrderID, Amount: params.Amount}, nil
		})
	if err != nil {
		return err
	}

	_, err = step(ctx, db, queue, t.TaskID, t.RunID, "reserve-inventory",
		func() (InventoryResult, error) {
			return InventoryResult{ReservedItems: params.Items}, nil
		})
	if err != nil {
		return err
	}

	_, err = step(ctx, db, queue, t.TaskID, t.RunID, "send-notification",
		func() (NotificationResult, error) {
			return NotificationResult{SentTo: params.Email}, nil
		})
	if err != nil {
		return err
	}

	// Mark the run complete.
	resultJSON := []byte(fmt.Sprintf(`{"order_id":%q}`, params.OrderID))
	_, err = db.Exec(ctx, `SELECT absurd.complete_run($1, $2, $3)`, queue, t.RunID, resultJSON)
	return err
}

func worker(ctx context.Context, db *pgxpool.Pool, queue, workerID string, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		if ctx.Err() != nil {
			return
		}

		// Claim a task — SKIP LOCKED inside the stored procedure.
		rows, err := db.Query(ctx, `SELECT run_id::text, task_id::text, attempt, task_name, params::text,
			coalesce(retry_strategy::text, 'null'), max_attempts, coalesce(headers::text, 'null'),
			wake_event, coalesce(event_payload::text, 'null')
			FROM absurd.claim_task($1, $2, $3, $4)`,
			queue, workerID, 30, 4)
		if err != nil {
			log.Printf("claim error: %v", err)
			time.Sleep(50 * time.Millisecond)
			continue
		}

		var tasks []claimedTask
		for rows.Next() {
			var t claimedTask
			var paramsStr, retryStr, headersStr, eventPayloadStr string
			if err := rows.Scan(&t.RunID, &t.TaskID, &t.Attempt, &t.TaskName, &paramsStr,
				&retryStr, &t.MaxAttempts, &headersStr, &t.WakeEvent, &eventPayloadStr); err != nil {
				continue
			}
			t.Params = json.RawMessage(paramsStr)
			t.RetryStrategy = json.RawMessage(retryStr)
			t.Headers = json.RawMessage(headersStr)
			t.EventPayload = json.RawMessage(eventPayloadStr)
			tasks = append(tasks, t)
		}
		rows.Close()

		if len(tasks) == 0 {
			// No work — short sleep before re-polling.
			time.Sleep(5 * time.Millisecond)
			continue
		}

		for _, t := range tasks {
			if err := runOrderFulfillment(ctx, db, queue, t); err != nil {
				log.Printf("run failed: %v", err)
				failJSON := []byte(fmt.Sprintf(`{"message":%q}`, err.Error()))
				db.Exec(ctx, `SELECT absurd.fail_run($1, $2, $3, null)`, queue, t.RunID, failJSON)
			}
		}
	}
}

func main() {
	workers := flag.Int("workers", 4, "number of worker goroutines")
	pollInterval := flag.Duration("poll", 5*time.Millisecond, "poll interval")
	_ = pollInterval
	queue := flag.String("queue", "default", "queue name")
	flag.Parse()

	ctx, cancel := context.WithCancel(context.Background())

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

	log.Printf("Absurd worker starting: %d goroutines, queue=%s", *workers, *queue)
	var wg sync.WaitGroup
	for i := 0; i < *workers; i++ {
		wg.Add(1)
		go worker(ctx, pool, *queue, fmt.Sprintf("w-%d", i), &wg)
	}

	// Block forever
	select {}

	_ = cancel
}
