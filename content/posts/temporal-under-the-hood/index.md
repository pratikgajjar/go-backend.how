+++
title = "Temporal: Under the Hood"
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
