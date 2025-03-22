+++
title = "🚂 Temporal: Under the Hood"
description = ""
date = 2024-11-28T21:51:38+05:30
lastmod = 2024-11-28T21:51:38+05:30
publishDate = "2024-11-28T21:51:38+05:30"
draft = true
tags = []
images = []
+++

# What is Temporal

Temporal is an open-source durable execution system that abstracts away the complexity of building scalable, reliable distributed systems. It presents a development abstraction that preserves complete application state so that in the case of a host or software failure it can seamlessly migrate execution to another machine.

Almost everyone are distributed systems world without even realising. For example in below diagram we are making network call to either another micro service or 3rd party, Step 3 can fail due to various reasons.

- Buggy code
- Network Blip
- Other service or 3rd party service down
- Underlying instance failure

{{< figure src="sample-app.svg" title="Next Gen app" alt="Wireframes of basic app" >}}

How do we ensure that we are able to recover and we have notified at least once to external service ?

Here are few common approaches

1. [Saga](https://microservices.io/patterns/data/saga.html)
2. [CQRS - Command Query Responsibility Segregation](https://microservices.io/patterns/data/cqrs.html)
3. [Event sourcing](https://microservices.io/patterns/data/event-sourcing.html)
4. [Outbox Pattern](https://www.decodable.co/blog/revisiting-the-outbox-pattern) _Must Read_
5. Durable Functions / Workflow Engine

## Durable Functions

Apart from temporal.io here are the other options you can explore.

- [Restate](https://restate.dev/) - Rust, It's own storage engine ; promising.
- [Cadence](https://github.com/cadence-workflow/cadence) - By Uber - Base of Temporal
- [Conductor](https://conductor-oss.org/) - By Netflix - Java
- [Eventual](https://github.com/sam-goodwin/eventual) - JavaScript
- [dbos](https://docs.dbos.dev/) - Python / TS
- [CloudFlare Workflow](https://developers.cloudflare.com/workflows/) - Beta (Dec 24), Vendor 🔒
- [Azure Durable Functions](https://learn.microsoft.com/en-us/azure/azure-functions/durable/) - Vendor 🔒
- [AWS Step Functions](https://aws.amazon.com/step-functions/) - Vendor 🔒
- [Amazon Simple Workflow Service](https://docs.aws.amazon.com/amazonswf/latest/developerguide/swf-welcome.html) - deprecated in favour of Step Fn.

Here are the reasons to choose [temporal.io](https://temporal.io/)

1. MIT License.
2. Good documentation and active community.
3. Pretty UI.
4. Managed option available.
5. Written in GoLang

# Basics

Activities - A function which has side effects, Ex - Making Network Call (DB, REST, gRPC etc.). We can wire multiple activities in workflow to achieve the business outcome.

Workflow - Executes activities, can trigger child workflows or finish starting new workflow.

Queues - Stores which workflow to execute with the configuration.

Workers - Who actually executes the workflow and activities from one or multiple queues.

{{< figure src="temporal-svc.svg" title="Temporal" alt="Diagram showing how worker and temporal backend connected" width="auto" >}}

1. Workers talk to temporal backend via gRPC
2. Temporal Backend uses database specific protocol fetch and update state.

# Under the hood

Let's look under the hood what goes into building temporal itself such that it enables to build invincible apps. Here we will be using Postgres as datastore. This will also help understand at scalability aspects of using Postgres too.

Most cases database becomes the bottleneck at large scale since both temporal backend nodes and worker nodes are stateless they can be scaled without much worry. So we will be analysing schema and queries done by temporal backend nodes.

```sql
CREATE TABLE IF NOT EXISTS public.queue
(
    queue_type integer NOT NULL,
    message_id bigint NOT NULL,
    message_payload bytea NOT NULL,
    message_encoding character varying(16) COLLATE pg_catalog."default" NOT NULL DEFAULT 'Json'::character varying,
    CONSTRAINT queue_pkey PRIMARY KEY (queue_type, message_id)
)

CREATE TABLE IF NOT EXISTS public.executions
(
    shard_id integer NOT NULL,
    namespace_id bytea NOT NULL,
    workflow_id character varying(255) COLLATE pg_catalog."default" NOT NULL,
    run_id bytea NOT NULL,
    next_event_id bigint NOT NULL,
    last_write_version bigint NOT NULL,
    data bytea NOT NULL,
    data_encoding character varying(16) COLLATE pg_catalog."default" NOT NULL,
    state bytea NOT NULL,
    state_encoding character varying(16) COLLATE pg_catalog."default" NOT NULL,
    db_record_version bigint NOT NULL DEFAULT 0,
    CONSTRAINT executions_pkey PRIMARY KEY (shard_id, namespace_id, workflow_id, run_id)
)

CREATE TABLE IF NOT EXISTS public.shards
(
    shard_id integer NOT NULL,
    range_id bigint NOT NULL,
    data bytea NOT NULL,
    data_encoding character varying(16) COLLATE pg_catalog."default" NOT NULL,
    CONSTRAINT shards_pkey PRIMARY KEY (shard_id)
)

CREATE TABLE IF NOT EXISTS public.task_queues
(
    range_hash bigint NOT NULL,
    task_queue_id bytea NOT NULL,
    range_id bigint NOT NULL,
    data bytea NOT NULL,
    data_encoding character varying(16) COLLATE pg_catalog."default" NOT NULL,
    CONSTRAINT task_queues_pkey PRIMARY KEY (range_hash, task_queue_id)
)

CREATE TABLE IF NOT EXISTS public.tasks
(
    range_hash bigint NOT NULL,
    task_queue_id bytea NOT NULL,
    task_id bigint NOT NULL,
    data bytea NOT NULL,
    data_encoding character varying(16) COLLATE pg_catalog."default" NOT NULL,
    CONSTRAINT tasks_pkey PRIMARY KEY (range_hash, task_queue_id, task_id)
)
```

## Query

Temporal backend nodes periodically `UPSERT` their membership status.

```sql
INSERT INTO
   cluster_membership (membership_partition, host_id, rpc_address, rpc_port, role, session_start, last_heartbeat, record_expiry)
   VALUES($1, $2, $3, $4, $5, $6, $7, $8)
   ON CONFLICT(membership_partition, host_id)
   DO UPDATE SET
   membership_partition = $1, host_id = $2, rpc_address = $3, rpc_port = $4, role = $5, session_start = $6, last_heartbeat = $7, record_expiry = $8

parameters: $1 = '0', $2 = '\x87a6d0fac53c11efac040242ac160003', $3 = '172.22.0.3', $4 = '6934', $5 = '2', $6 = '2024-12-28 16:55:23.686712', $7 = '2024-12-28 16:56:43.763493', $8 = '2024-12-30 16:56:43.763493'

```

```sql
SELECT id, name, is_global, data, data_encoding, notification_version FROM namespaces WHERE partition_id=$1 ORDER BY id LIMIT $2
parameters: $1 = '54321', $2 = '1000'

```
