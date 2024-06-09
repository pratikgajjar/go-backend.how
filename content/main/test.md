+++
title = 'Keeping it 100(x) with real-time data at scale'
date = 2024-06-10T01:10:42+05:30
+++


After years of playing catch-up with Figma’s growth, it was time to fundamentally rethink LiveGraph’s architecture.

At Figma, multiplayer collaboration is central to everything we do—from file canvas editing to features like comments and FigJam voting sessions. Keeping data up-to-date across product surfaces is critical for effective team collaboration and core to what makes Figma feel magical. LiveGraph, Figma’s real-time data-fetching service, is the foundation that makes this possible.

LiveGraph provides a web API for subscribing to GraphQL-like queries and returns the result as a JSON tree. Like other GraphQL backends, we have a schema describing the entities and relations that make up our object graph, along with views that allow querying a subset of that graph. Through our custom React Hook, the front-end automatically re-renders on update with no additional work from engineers.
A flowchart on a yellow background featuring geometric shapes and arrows indicating connections and flow. A prominent blue circle with a recycling arrow symbolizes a cyclical process, and directional arrows guide the flow between elements.

Software Engineers Rudi Chen and Slava Kim share an inside look at how we empower engineers to build real-time data views, while abstracting the complexity of pushing data back and forth.

At the end of our earlier exploration of LiveGraph, we predicted that our next bottleneck would be ingesting all database updates on each LiveGraph server. While this was certainly a factor, it was just one of the many scaling challenges we’ve faced with LiveGraph. Figma’s expanding user base and increasing LiveGraph usage mean more client sessions, each of which is increasingly expensive. The number of sessions has tripled since 2021, with view requests growing 5x in just the last year. Conversely, this growth is leading to large changes in the underlying infrastructure: From a single Postgres instance to many vertical and horizontal shards, the database below LiveGraph is shifting and we have to keep up.
Building for the future

