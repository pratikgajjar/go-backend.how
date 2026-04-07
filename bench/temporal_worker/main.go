package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// OrderParams is the workflow input — mirrors the Absurd README's example.
type OrderParams struct {
	OrderID string
	Amount  int64
	Items   []string
	Email   string
}

// PaymentResult is the result of the process-payment activity.
type PaymentResult struct {
	PaymentID string
	Amount    int64
}

// InventoryResult is the result of the reserve-inventory activity.
type InventoryResult struct {
	ReservedItems []string
}

// NotificationResult is the result of the send-notification activity.
type NotificationResult struct {
	SentTo string
}

// OrderFulfillmentWorkflow is a 3-step workflow — no event wait, pure activities.
// This is the closest apples-to-apples comparison with Absurd.
func OrderFulfillmentWorkflow(ctx workflow.Context, params OrderParams) (string, error) {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	var payment PaymentResult
	if err := workflow.ExecuteActivity(ctx, ProcessPayment, params).Get(ctx, &payment); err != nil {
		return "", err
	}

	var inventory InventoryResult
	if err := workflow.ExecuteActivity(ctx, ReserveInventory, params).Get(ctx, &inventory); err != nil {
		return "", err
	}

	var notification NotificationResult
	if err := workflow.ExecuteActivity(ctx, SendNotification, params).Get(ctx, &notification); err != nil {
		return "", err
	}

	return params.OrderID, nil
}

// Activities: all no-op, return deterministic values. The benchmark is about
// orchestration throughput, not activity work.
func ProcessPayment(ctx context.Context, params OrderParams) (PaymentResult, error) {
	return PaymentResult{
		PaymentID: fmt.Sprintf("pay-%s", params.OrderID),
		Amount:    params.Amount,
	}, nil
}

func ReserveInventory(ctx context.Context, params OrderParams) (InventoryResult, error) {
	return InventoryResult{ReservedItems: params.Items}, nil
}

func SendNotification(ctx context.Context, params OrderParams) (NotificationResult, error) {
	return NotificationResult{SentTo: params.Email}, nil
}

func main() {
	c, err := client.Dial(client.Options{
		HostPort: "localhost:7233",
	})
	if err != nil {
		log.Fatalln("Unable to create Temporal client:", err)
	}
	defer c.Close()

	w := worker.New(c, "order-fulfillment-q", worker.Options{
		MaxConcurrentActivityExecutionSize:     500,
		MaxConcurrentWorkflowTaskExecutionSize: 500,
	})

	w.RegisterWorkflow(OrderFulfillmentWorkflow)
	w.RegisterActivity(ProcessPayment)
	w.RegisterActivity(ReserveInventory)
	w.RegisterActivity(SendNotification)

	// Make activities log less noise
	_ = activity.GetLogger

	log.Println("Temporal worker starting on task queue: order-fulfillment-q")
	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalln("Unable to start worker:", err)
	}
}
