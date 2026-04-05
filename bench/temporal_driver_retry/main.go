package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"sync"
	"time"

	"go.temporal.io/sdk/client"
)

type RetryParams struct {
	ID         string
	FailCount  int
	Activities int
}

func main() {
	n := flag.Int("n", 100, "number of workflows")
	c := flag.Int("c", 32, "concurrency")
	fails := flag.Int("fails", 0, "times first activity fails before succeeding")
	activities := flag.Int("activities", 3, "total activities per workflow")
	flag.Parse()

	cli, err := client.Dial(client.Options{HostPort: "localhost:7233"})
	if err != nil {
		log.Fatal(err)
	}
	defer cli.Close()

	start := time.Now()
	sem := make(chan struct{}, *c)
	var wg sync.WaitGroup
	for i := 0; i < *n; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			wfID := fmt.Sprintf("retry-%d-%d", time.Now().UnixNano(), i)
			we, err := cli.ExecuteWorkflow(context.Background(),
				client.StartWorkflowOptions{ID: wfID, TaskQueue: "retry-bench"},
				"RetryWorkflow",
				RetryParams{ID: wfID, FailCount: *fails, Activities: *activities},
			)
			if err != nil {
				log.Printf("start err: %v", err)
				return
			}
			var result string
			_ = we.Get(context.Background(), &result)
		}(i)
	}
	wg.Wait()
	elapsed := time.Since(start)
	fmt.Printf("n=%d fails=%d activities=%d completed=%d elapsed=%s tput=%.1f/s\n",
		*n, *fails, *activities, *n, elapsed, float64(*n)/elapsed.Seconds())
}
