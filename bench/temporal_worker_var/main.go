package main

// A worker that registers workflows with 1, 3, 5, and 10 activities so we can
// study how query-count-per-workflow scales with the number of activities.

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

type VarParams struct {
	ID       string
	Activities int
}

func NoOp(ctx context.Context, id string, idx int) (string, error) {
	return fmt.Sprintf("%s-%d", id, idx), nil
}

// makeFixedCountWorkflow returns a workflow that always runs exactly n activities.
func makeFixedCountWorkflow(n int) func(workflow.Context, VarParams) (string, error) {
	return func(ctx workflow.Context, params VarParams) (string, error) {
		ao := workflow.ActivityOptions{StartToCloseTimeout: 30 * time.Second}
		ctx = workflow.WithActivityOptions(ctx, ao)
		var last string
		for i := 0; i < n; i++ {
			if err := workflow.ExecuteActivity(ctx, NoOp, params.ID, i).Get(ctx, &last); err != nil {
				return "", err
			}
		}
		return last, nil
	}
}

var (
	Var1  = makeFixedCountWorkflow(1)
	Var3  = makeFixedCountWorkflow(3)
	Var5  = makeFixedCountWorkflow(5)
	Var10 = makeFixedCountWorkflow(10)
)

func main() {
	c, err := client.Dial(client.Options{HostPort: "localhost:7233"})
	if err != nil {
		log.Fatalln("dial:", err)
	}
	defer c.Close()
	queueName := os.Getenv("QUEUE")
	if queueName == "" {
		queueName = "var-activities-q"
	}

	w := worker.New(c, queueName, worker.Options{
		MaxConcurrentActivityExecutionSize:     500,
		MaxConcurrentWorkflowTaskExecutionSize: 500,
	})

	w.RegisterWorkflowWithOptions(Var1, workflow.RegisterOptions{Name: "Var1"})
	w.RegisterWorkflowWithOptions(Var3, workflow.RegisterOptions{Name: "Var3"})
	w.RegisterWorkflowWithOptions(Var5, workflow.RegisterOptions{Name: "Var5"})
	w.RegisterWorkflowWithOptions(Var10, workflow.RegisterOptions{Name: "Var10"})
	w.RegisterActivity(NoOp)

	log.Printf("Var-activities worker on queue: %s", queueName)
	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalln("worker:", err)
	}
}
