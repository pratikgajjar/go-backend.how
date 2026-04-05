package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"sort"
	"time"

	"go.temporal.io/sdk/client"
)

type VarParams struct {
	ID       string
	Activities int
}

func main() {
	n := flag.Int("n", 50, "number of workflows to run sequentially")
	wftype := flag.String("wf", "Var3", "Var1/Var3/Var5/Var10")
	flag.Parse()

	c, err := client.Dial(client.Options{HostPort: "localhost:7233"})
	if err != nil {
		log.Fatalln("dial:", err)
	}
	defer c.Close()
	ctx := context.Background()

	latencies := []float64{}
	for i := 0; i < *n; i++ {
		id := fmt.Sprintf("solo-%s-%d-%d", *wftype, time.Now().UnixNano(), i)
		t0 := time.Now()
		we, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
			ID: id, TaskQueue: "var-activities-q",
		}, *wftype, VarParams{ID: id})
		if err != nil {
			log.Printf("start: %v", err)
			continue
		}
		var result string
		if err := we.Get(ctx, &result); err != nil {
			log.Printf("get: %v", err)
			continue
		}
		latencies = append(latencies, float64(time.Since(t0).Microseconds())/1000.0)
	}
	sort.Float64s(latencies)
	p := func(q float64) float64 {
		if len(latencies) == 0 {
			return 0
		}
		i := int(q * float64(len(latencies)-1))
		return latencies[i]
	}
	var sum float64
	for _, x := range latencies {
		sum += x
	}
	mean := sum / float64(len(latencies))
	fmt.Printf("wf=%s n=%d  p50=%.1f p90=%.1f p99=%.1f max=%.1f  mean=%.1f ms\n",
		*wftype, *n, p(0.5), p(0.9), p(0.99), p(1.0), mean)
}
