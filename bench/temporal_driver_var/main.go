package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"go.temporal.io/sdk/client"
)

type VarParams struct {
	ID       string
	Activities int
}

func main() {
	n := flag.Int("n", 200, "number of workflows to start")
	concurrency := flag.Int("c", 32, "concurrent starts")
	wftype := flag.String("wf", "Var3", "workflow type: Var1, Var3, Var5, Var10")
	flag.Parse()

	c, err := client.Dial(client.Options{HostPort: "localhost:7233"})
	if err != nil {
		log.Fatalln("dial:", err)
	}
	defer c.Close()

	queueName := os.Getenv("QUEUE")
	if queueName == "" {
		queueName = "var-activities-q"
	}

	log.Printf("Starting %d %s workflows (concurrency=%d)", *n, *wftype, *concurrency)
	start := time.Now()
	var completed int64
	var failed int64
	var wg sync.WaitGroup
	sem := make(chan struct{}, *concurrency)
	ctx := context.Background()

	for i := 0; i < *n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			id := fmt.Sprintf("%s-%d-%d", *wftype, time.Now().UnixNano(), i)
			we, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
				ID: id, TaskQueue: queueName,
			}, *wftype, VarParams{ID: id})
			if err != nil {
				atomic.AddInt64(&failed, 1)
				return
			}
			var result string
			if err := we.Get(ctx, &result); err != nil {
				atomic.AddInt64(&failed, 1)
				return
			}
			atomic.AddInt64(&completed, 1)
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)
	fmt.Printf("wf=%s n=%d c=%d completed=%d failed=%d elapsed=%s tput=%.1f/s\n",
		*wftype, *n, *concurrency, completed, failed, elapsed, float64(completed)/elapsed.Seconds())
}
