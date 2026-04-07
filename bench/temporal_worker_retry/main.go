package main

// Worker that runs a 3-activity workflow where the first activity fails
// a configurable number of times before succeeding. Lets us measure the
// SQL cost of retries vs happy path.

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

type RetryParams struct {
	ID           string
	FailCount    int
	Activities   int
}

var (
	failureMu    sync.Mutex
	failureCount = make(map[string]int)
)

// FlakyActivity fails FailCount times, then succeeds.
func FlakyActivity(ctx context.Context, id string, idx int, failTarget int) (string, error) {
	failureMu.Lock()
	key := fmt.Sprintf("%s-%d", id, idx)
	seen := failureCount[key]
	failureCount[key]++
	failureMu.Unlock()
	if seen < failTarget {
		return "", fmt.Errorf("transient failure %d/%d for %s", seen+1, failTarget, key)
	}
	return fmt.Sprintf("%s-ok", key), nil
}

func RetryWorkflow(ctx workflow.Context, params RetryParams) (string, error) {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    100 * time.Millisecond,
			BackoffCoefficient: 1.0, // fixed backoff
			MaximumInterval:    100 * time.Millisecond,
			MaximumAttempts:    int32(params.FailCount + 2),
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)
	var last string
	for i := 0; i < params.Activities; i++ {
		// Only the first activity flakes; rest succeed first try.
		failFor := 0
		if i == 0 {
			failFor = params.FailCount
		}
		if err := workflow.ExecuteActivity(ctx, FlakyActivity, params.ID, i, failFor).Get(ctx, &last); err != nil {
			return "", err
		}
	}
	return last, nil
}

func main() {
	c, err := client.Dial(client.Options{HostPort: "localhost:7233"})
	if err != nil {
		log.Fatal(err)
	}
	defer c.Close()
	w := worker.New(c, "retry-bench", worker.Options{})
	w.RegisterWorkflow(RetryWorkflow)
	w.RegisterActivity(FlakyActivity)
	log.Println("Temporal retry-worker ready")
	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatal(err)
	}
}
