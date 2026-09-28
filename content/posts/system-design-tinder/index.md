+++
title = '♥️ System Design - Tinder'
description = "How to design a location-based dating app for 75M daily users: derive the load, precompute each user's deck, find nearby people with geohash cells, check matches without races, and never lose the first message."
date = 2023-02-15T10:00:00-07:00
lastmod = 2023-02-15T10:00:00-07:00
draft = false
tags = ['system-design', 'dating-app', 'geospatial', 'recommendations']
images = ["og-dabd1a53.png"]
theme = "blush"
+++

A dating app at scale answers one question many times a second: **how do you show someone the right person, right now, within 10 miles, when 75 million people use the app every day?**

By the end of this post you will know how to size that system from a few business numbers, why the obvious designs break (a geo query per swipe, a match check that reads before it writes, a chat that trusts the live connection), and what to build instead: a deck of candidates ranked ahead of time, geohash cells sized to the search radius, one Redis key per pair for matches, and a message store the phone syncs from. Five figures let you try each part.

---

# The Hard Parts

Beyond the basics of profiles and matching, here are the harder problems worth solving:

1. **The Proximity Paradox**: You need to find people near the user, but "near" changes every time they move. Their location updates every few minutes. Multiply this by 75M daily active users.

2. **The Cold Start Death Spiral**: New users have no swipe history. Bad recommendations = they leave in 48 hours. You get one shot.

3. **The Mutual Interest Problem**: Unlike Instagram where you follow someone and you're done, here both people must swipe right. Your recommendation engine needs to predict *bilateral* attraction.

4. **The Chat Delivery Guarantee**: When someone finally matches, that first message must not be lost. This isn't "eventual consistency is fine" territory. This is "we lose a user forever" territory.

---

# Requirements

## What the App Does

Ranked by engineering complexity, not feature importance:

| Feature | User Sees | Engineering Complexity |
|---------|-----------|----------------------|
| **Recommendations** | "Here are people near you" | Very High |
| **Location Updates** | Background sync | High |
| **Chat** | Message delivery | Medium |
| **Matching** | "It's a Match!" | Medium |
| **Profile CRUD** | Edit bio, photos | Low |
| **Notifications** | Push alerts | Low |

The **recommendations engine is 80% of your system's complexity**. Everything else is table stakes.

## The Load

Derive real numbers from business metrics instead of guessing.

**Starting assumptions:**
- 75M DAU (an upper bound: Tinder has reported about 75M *monthly* active users)
- Average session: 7 minutes
- Average swipes per session: 50
- Peak hours: 8 PM - 11 PM local time (3-hour window)

**Swipes:**

```txt
Daily swipes = 75M × 50 = 3.75 billion swipes/day
             ≈ 2 billion (accounting for variance)

Peak QPS for swipes = (2B × 0.4) / (3 hours × 3600)
                    = 800M / 10,800
                    ≈ 74,000 swipes/second at peak
```

Each swipe triggers:
- 1 write to record the swipe
- 1 read to check for mutual match
- 1 recommendation fetch if queue is low
- 1 potential match notification

So your **effective QPS is 4× your swipe rate**: ~300,000 operations/second at peak.

**Location updates:**

```txt
If 30% of DAU has location services on = 22.5M users
Update every 5 minutes = 22.5M / 300 = 75,000 location updates/second
```

**Chat:**

```txt
10% of DAU sends messages = 7.5M users
Average 20 messages/day = 150M messages/day
Peak: 150M × 0.4 / 10,800 ≈ 5,500 messages/second
```

## The Latency Targets

| Metric | Target | Why |
|--------|--------|-----|
| Recommendation latency P99 | < 100ms | User is swiping; can't wait |
| Match notification latency P99 | < 500ms | Dopamine hit must be instant |
| Message delivery latency P99 | < 200ms | Chat feels broken otherwise |
| Photo load time P50 | < 300ms | First impression is visual |
| Location update lag | < 5 min | Accuracy vs. cost tradeoff |

**Now you have real numbers to design against.**

---

# The System at a Glance

Each user action takes its own path through the system. Pick one and step through it: the services it touches, the command at each hop, its peak load, and its latency target.

{{< viz kind="arch-paths" fig="1" title="Four paths through the system" fallback="arch-paths.svg" alt="Architecture of the design: mobile app, API gateway, profile, recommendation and swipe services, WebSocket gateways, Redis, Postgres, ScyllaDB, Kafka, the location processor and the offline pipeline, with the swipe path highlighted" caption="The design in this post, not Tinder's production system. Rates and targets come from the requirements above." >}}

The rest of the post follows these paths one at a time, starting with the hardest: what to show when someone opens the app.

---

# Recommendations

## Why Not Query per Request

A straightforward SQL approach might look like this:

```sql
SELECT * FROM users 
WHERE ST_DWithin(location, user_location, 50000)  -- 50km
AND age BETWEEN 25 AND 35
AND gender = 'F'
AND last_active > NOW() - INTERVAL '7 days'
LIMIT 200;
```

It fails twice. On the read side, at 74,000 swipes per second, a geo query plus a ranking model per request will not fit in a 100 ms P99 budget. On the write side, at 75K location updates per second, each update writes a new row version and a new GiST index entry, and vacuum has to clean up the old ones. One Postgres primary struggles with that write rate.

## Rank Ahead of Time, Serve the Top

**Solution: pre-computation plus a queue.** Every 15 minutes, an offline pipeline generates candidates from nearby geohash cells, ranks them, and writes each user's top 200 into a Redis sorted set: their deck. When the user opens the app, the service pops the top 10 (`ZPOPMAX deck:u42 10`), drops anyone swiped since the deck was built, and returns the cards within a 50 ms P99 target. Swipe a few cards and watch what each swipe costs:

{{< viz kind="deck-hero" fig="2" title="Swipe your deck" fallback="deck-hero.svg" alt="A phone showing the top card of a precomputed deck, the deck as a Redis sorted set of IDs and scores, and the offline pipeline that builds it every 15 minutes" caption="IDs and scores are samples. The next sections take each part apart." >}}

The expensive work, finding people nearby and scoring them, happens in the offline box, away from the request. The next sections open that box.

## Candidate Generation: Geohash Cells

The offline pipeline still needs "people near this user", without a geo index in Postgres.

**The solution: Geohashing with temporal sharding**

```python
# Divide the world into geohash cells (precision 5 is 4.9 km × 4.9 km at the
# equator; cells get narrower east-west as you move away from it)
# Store users in Redis sets keyed by geohash + time bucket

def get_candidates(user):
    user_geohash = geohash.encode(user.lat, user.lng, precision=5)
    neighbor_cells = geohash.neighbors(user_geohash)
    
    candidates = []
    for cell in [user_geohash] + neighbor_cells:
        # Time bucket ensures we only see recently active users
        bucket = get_time_bucket(hours=24)
        key = f"active:{cell}:{bucket}"
        candidates.extend(redis.smembers(key))
    
    return candidates[:500]  # Cap for ranking phase
```

**Why this works:**
1. One `SMEMBERS` per cell, so 9 reads per request. `SMEMBERS` is O(N) in the size of the set, so in a dense cell read a sample with `SRANDMEMBER key count` instead.
2. Time bucketing drops stale users, as long as each bucket key has a TTL.
3. The write path is pipelined `SADD`s, and one Redis node handles well over 100K of those per second.

The part that is easy to get wrong is the reach. Nine square cells are not a circle, and a cell's width depends on latitude. Guess first, then move the user, the radius, and the precision:

{{< viz kind="geo-reach" fig="3" title="How far do 9 geohash cells reach?" fallback="geo-reach.svg" alt="A 3 by 3 block of precision-5 geohash cells around a user in New York, with a 16 km search circle; 80% of the circle falls outside the block" caption="Geohash strings are real for the chosen point. Distances assume a spherical Earth." >}}

In the worst case, when the user stands in a corner of their cell, the block reaches only one cell side: 4.9 km at precision 5 on the equator, 3.7 km in New York. That is far short of the 10 miles (16 km) in the opening question. So choose the precision from the radius: use the smallest cells whose 3×3 block still holds the circle, then drop candidates by real distance. Redis `GEOSEARCH` works the same way. It estimates the cell size from the radius, reads the 3×3 block, and moves to bigger cells when the block does not cover the search area[^geosearch].

## Keeping the Cells Fresh

The location pipeline is the write side of those cells, and your most write-heavy path: 75,000 updates/second. Pick *Location update* in [Figure 1](#the-system-at-a-glance) to follow it: phone, Kafka as a buffer, the location processor, the geohash sets, and the offline pipeline that rebuilds decks from them.

You don't need real-time location accuracy. A 5-minute delay is fine. This lets you batch writes and reduce pressure on downstream systems.

```python
# Kafka consumer processing location updates
async def process_location_batch(messages):
    # Batch by geohash cell
    updates_by_cell = defaultdict(list)
    
    for msg in messages:
        user_id = msg['user_id']
        new_hash = geohash.encode(msg['lat'], msg['lng'], precision=5)
        old_hash = await redis.hget(f"user:{user_id}", 'geohash')
        
        if old_hash != new_hash:
            # User moved to different cell
            updates_by_cell[old_hash].append(('SREM', user_id))
            updates_by_cell[new_hash].append(('SADD', user_id))
            
            # Update user's stored location
            await redis.hset(f"user:{user_id}", {
                'geohash': new_hash,
                'lat': msg['lat'],
                'lng': msg['lng']
            })
    
    # Batch Redis operations
    pipe = redis.pipeline()
    for cell, ops in updates_by_cell.items():
        for op, user_id in ops:
            bucket = get_time_bucket(hours=24)
            if op == 'SADD':
                pipe.sadd(f"active:{cell}:{bucket}", user_id)
            else:
                pipe.srem(f"active:{cell}:{bucket}", user_id)
    
    await pipe.execute()
```

## Ranking: The Bilateral Problem

Here's what makes dating apps different from Instagram or TikTok:

**TikTok:** P(user likes video)  
**Tinder:** P(user A likes user B) × P(user B likes user A)

You need to predict both directions, and spread attention fairly:

```python
def calculate_match_score(user_a, user_b):
    # How likely is A to swipe right on B?
    a_likes_b = model.predict(user_a.features, user_b.features)
    
    # How likely is B to swipe right on A?
    b_likes_a = model.predict(user_b.features, user_a.features)
    
    # We want to maximize mutual matches
    # But also give everyone a fair chance (avoid rich-get-richer)
    mutual_probability = a_likes_b * b_likes_a
    
    # Factor in B's current queue depth (fairness)
    fairness_boost = 1.0 / (1 + log(user_b.daily_impressions))
    
    return mutual_probability * fairness_boost
```

If you only optimize for "will this user swipe right," you'll show everyone the same top 1% of attractive users. Those users get overwhelmed, everyone else gets no matches, and your app dies.

---

# Matching: Two Swipes at Once

When both users swipe right, you need to:
1. Detect the match instantly
2. Notify both users
3. Create a conversation thread
4. Do this without race conditions at 74K swipes/second

A and B swipe right on each other within the same few milliseconds. Each request must save its own swipe and check for the other one. Whether the match is found depends on how those two steps are written, and on the order in which the calls reach Redis.

{{< viz kind="swipe-race" fig="4" title="Two right swipes at the same moment" fallback="swipe-race.svg" alt="Outcomes of two simultaneous right swipes for five ways of saving a swipe, across every order of the Redis calls" caption="A and B are sample user IDs. Hash slots are from `CLUSTER KEYSLOT`, and the `CROSSSLOT` reply is what a Valkey 9.1 cluster returns for this transaction." >}}

Checking before writing can miss the match, and a replica that lags the primary has the same effect. Writing before checking can create the match twice. A `MULTI`/`EXEC` transaction fixes both on one Redis node, and redis-py's `pipeline()` already sends one. On Redis Cluster, though, `right:A` and `right:B` hash to different slots, and a transaction may only touch keys in one slot[^crossslot]. One key per pair, with a hash tag, keeps the transaction in one slot:

```python
def record_swipe(swiper_id, target_id, direction):
    if direction == 'left':
        redis.sadd(f"left:{swiper_id}", target_id)
        return None

    # One key per pair. Both users build the same key, and Redis Cluster
    # hashes only the part inside {…}, so the key has a single slot.
    lo, hi = sorted((swiper_id, target_id))
    key = f"likes:{{{lo}:{hi}}}"

    pipe = redis.pipeline()        # transaction=True: MULTI … EXEC
    pipe.sadd(key, swiper_id)
    pipe.scard(key)
    added, likes = pipe.execute()

    if added == 1 and likes == 2:  # true for exactly one of the two swipes
        match_id = create_match(lo, hi)

        # Fan out notifications
        notification_queue.publish({
            'type': 'match',
            'match_id': match_id,
            'users': [lo, hi]
        })

        return match_id

    return None
```

`added == 1` keeps a repeated swipe from creating the match again. The cost is one small key for every pair with at least one like. If the app has a "Likes You" screen, keep `right:{user}` for it as well; the match decision does not read it.

---

# Chat: The First Message

Chat has to handle all of this:
- Users switch between WiFi and cellular
- WebSocket connections drop silently
- A message must never be lost, and must never show twice
- Read receipts need real-time sync
- Users might be offline for days

Each phone holds a WebSocket to one gateway pod. Gateways pass messages to each other through Redis Pub/Sub, and every message is stored in ScyllaDB. Pub/Sub delivers at most once and keeps no copy[^pubsub], so the live path alone cannot keep the first promise above. Pick a fault and follow the first message:

{{< viz kind="chat-timeline" fig="5" title="The first message, as both phones see it" fallback="chat-timeline.svg" alt="Arjun's phone, the backend event log, and Riya's phone: the message is stored, the live Pub/Sub path drops it, a push goes out, and Riya's phone syncs it from ScyllaDB" caption="Names, IDs, text, and the 5-second timeout are samples. The `message_id` is a real version-1 UUID for 2026-02-14 15:11:07 UTC." >}}

Every fault ends the same way, because only two things carry the guarantee: the row in ScyllaDB and the phone's ACK. A successful socket write is not an ACK. The kernel accepts the bytes even when the phone is gone, and Linux keeps retransmitting for 13 to 30 minutes before it reports the connection dead[^tcp].

## The Delivery Guarantee

```python
async def send_message(conversation_id, sender_id, recipient_id, content):
    # timeuuid columns accept only version-1 UUIDs, so not uuid4() or uuid7()
    message_id = uuid1()

    message = {
        'conversation_id': conversation_id,
        'message_id': message_id,
        'sender_id': sender_id,
        'content': content,
        'status': 'pending',
    }

    # 1. Persist first (durability)
    await scylla.insert('messages', message)

    # 2. Try real-time delivery. True only if the phone ACKs message_id
    #    within the timeout, not when the socket write returns.
    delivered = await try_websocket_delivery(recipient_id, message, ack_timeout=5)

    if delivered:
        await scylla.update('messages', message_id, {'status': 'delivered'})
    else:
        # 3. Queue for push notification
        await push_queue.publish({
            'user_id': recipient_id,
            'type': 'new_message',
            'preview': content[:50]
        })

        # 4. Message waits in "pending" until the phone syncs and ACKs

    return message_id
```

On every connect, the phone asks for messages newer than the newest one it has, and stores them by `message_id`. That query is what recovers a lost message, and the ID is what stops a message from showing twice.

**ScyllaDB schema for messages:**

```sql
CREATE TABLE messages (
    conversation_id uuid,
    message_id timeuuid,
    sender_id uuid,
    content text,
    status text,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

**Why ScyllaDB?**
- Time-series write pattern (append-only messages)
- High write throughput (100K+ writes/sec per node)
- Natural time-ordering with `timeuuid`, a version-1 UUID that carries its creation time[^timeuuid]
- Partition by conversation keeps related messages together

---

# Where the Data Lives

| Data Type | Storage | Why |
|-----------|---------|-----|
| User profiles | PostgreSQL + Read replicas | ACID for billing, strong consistency for auth |
| User photos | S3 + CloudFront CDN | Cheap storage, global edge delivery |
| Swipe history | Redis (hot) + DynamoDB (cold) | Recent swipes need sub-ms access |
| Messages | ScyllaDB | Write-heavy, time-series, partition by convo |
| Recommendation queues | Redis Sorted Sets | Pre-computed, fast pop operations |
| Geospatial index | Redis Sets (geohash) | One key per cell; `SADD`/`SREM` keep up with the write volume |
| Analytics events | Kafka → ClickHouse | Columnar for aggregations |

**Infrastructure estimate:**
- 50-100 WebSocket gateway pods (100K connections each)
- 20-node ScyllaDB cluster for messages
- 50-node Redis cluster for recommendations
- 10-node PostgreSQL cluster (1 primary, 9 replicas)
- Kafka: 100+ partitions for location topic

---

# What Could Go Wrong (And Will)

**1. The "Hot User" Problem**

A celebrity joins your app. 500,000 swipes in an hour. Their Redis sorted set for "who liked me" explodes. Solutions:
- Cap the "likes received" list at 10,000
- Sample/aggregate for display
- Rate limit visibility of hot profiles

**2. The Ghost Match**

User A and B match. User A immediately unmatches. User B sees "It's a Match!" notification but can't find the match. Solutions:
- Add `matched_at` timestamp, grace period before display
- Notification includes match_id, client verifies before showing

**3. The Location Spoofer**

Users fake GPS to access profiles in other cities. Solutions:
- IP geolocation cross-reference
- Impossible travel detection (NYC to Tokyo in 1 hour)
- Cellular tower triangulation on mobile

**4. The Recommendation Starvation**

In small towns, users run out of profiles in 2 days. Solutions:
- Gradually expand radius
- Show profiles from nearby cities with disclosure
- "No more profiles nearby—expand your distance?"

---

# Takeaways

1. Size the system from business numbers first: 74,000 swipes/s, 75,000 location updates/s, and 5,500 messages/s at peak.
2. Keep ranking off the request path. A per-user deck in a sorted set turns "open the app" into one pop.
3. Size geohash cells from the search radius. Nine precision-5 cells around a New Yorker reach 3.7 to 5.6 km, not 10 miles.
4. Save the swipe and check for the match in one transaction on one key. On Redis Cluster, that means one key per pair.
5. Store the message first, count it delivered only when the phone ACKs, and let the phone sync from the store.

The hardest part of building a dating app isn't the technology. It's the **product-engineering intersection**:

- How do you balance showing users attractive profiles (engagement) vs. compatible profiles (retention)?
- How do you prevent the platform from becoming a "top 10% get everything" economy?
- How do you detect and handle bad actors at scale?

Every architectural decision ties back to these questions. The best systems engineers don't just build scalable systems; they build systems that make the product better.

Now go build something people will swipe right on.

[^geosearch]: <https://github.com/redis/redis/blob/unstable/src/geohash_helper.c>, `geohashCalculateAreasByShapeWGS84`
[^crossslot]: <https://redis.io/docs/latest/develop/using-commands/multi-key-operations/>
[^pubsub]: <https://redis.io/docs/latest/develop/pubsub/#delivery-semantics>
[^tcp]: <https://man7.org/linux/man-pages/man7/tcp.7.html>, `tcp_retries2`
[^timeuuid]: <https://docs.datastax.com/en/cql-oss/3.x/cql/cql_reference/uuid_type_r.html>
