package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"go.temporal.io/sdk/client"
)

type OrderParams struct {
	OrderID string
	Amount  int64
	Items   []string
	Email   string
}

func main() {
	total := flag.Int("n", 1000, "number of workflows to start")
	concurrency := flag.Int("c", 32, "concurrent starts")
	waitFinish := flag.Bool("wait", true, "wait for workflows to finish")
	flag.Parse()

	c, err := client.Dial(client.Options{HostPort: "localhost:7233"})
	if err != nil {
		log.Fatalln("Unable to create Temporal client:", err)
	}
	defer c.Close()

	ctx := context.Background()

	log.Printf("Starting %d workflows with concurrency=%d wait=%v", *total, *concurrency, *waitFinish)

	start := time.Now()
	var startedCount int64
	var completedCount int64
	var failedCount int64
	var wg sync.WaitGroup
	sem := make(chan struct{}, *concurrency)

	for i := 0; i < *total; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()

			orderID := fmt.Sprintf("order-%d-%d", time.Now().UnixNano(), i)
			params := OrderParams{
				OrderID: orderID,
				Amount:  int64(1000 + i),
				Items:   []string{"widget-1", "gadget-2"},
				Email:   "c@example.com",
			}

			we, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
				ID:        orderID,
				TaskQueue: "order-fulfillment-q",
			}, "OrderFulfillmentWorkflow", params)
			if err != nil {
				atomic.AddInt64(&failedCount, 1)
				return
			}
			atomic.AddInt64(&startedCount, 1)

			if *waitFinish {
				var result string
				if err := we.Get(ctx, &result); err != nil {
					atomic.AddInt64(&failedCount, 1)
					return
				}
				atomic.AddInt64(&completedCount, 1)
			}
		}(i)
	}
	wg.Wait()

	elapsed := time.Since(start)
	started := atomic.LoadInt64(&startedCount)
	completed := atomic.LoadInt64(&completedCount)
	failed := atomic.LoadInt64(&failedCount)

	fmt.Printf("\n===== Temporal benchmark =====\n")
	fmt.Printf("Started:     %d\n", started)
	fmt.Printf("Completed:   %d\n", completed)
	fmt.Printf("Failed:      %d\n", failed)
	fmt.Printf("Elapsed:     %s\n", elapsed)
	if *waitFinish {
		fmt.Printf("Throughput:  %.1f workflows/sec\n", float64(completed)/elapsed.Seconds())
	} else {
		fmt.Printf("Throughput:  %.1f starts/sec\n", float64(started)/elapsed.Seconds())
	}
}
