+++
title = '♥️ System Design : Tinder ✧'
description = "A battle-tested deep dive into designing a location-based dating app that handles 2 billion swipes per day. We'll dissect the real engineering challenges: the geospatial nightmare, the cold start problem, chat delivery guarantees, and why your recommendation engine will make or break everything."
date = 2023-02-15T10:00:00-07:00
draft = false
tags = ['System Design','HLD', 'Dating App', 'Geospatial', 'Recommendations']
theme = "blush"
+++

Here's the question that keeps engineers up at night when building a dating app at scale: **How do you show someone the right person, right now, within 10 miles, when 75 million people are swiping simultaneously?**

Let's dig in.

---

# Problem Statement

Beyond the basics of profiles and matching, here are the harder problems worth solving:

1. **The Proximity Paradox**: You need to find people near the user, but "near" changes every time they move. Their location updates every few minutes. Multiply this by 75M daily active users.

2. **The Cold Start Death Spiral**: New users have no swipe history. Bad recommendations = they leave in 48 hours. You get ONE shot.

3. **The Mutual Interest Problem**: Unlike Instagram where you follow someone and you're done, here BOTH parties must swipe right. Your recommendation engine needs to predict *bilateral* attraction.

4. **The Chat Delivery Guarantee**: When someone finally matches, that first message CANNOT be lost. This isn't "eventual consistency is fine" territory—this is "we lose a user forever" territory.

---

# Functional Requirements

Let's rank these by engineering complexity, not feature importance:

| Feature | User Sees | Engineering Complexity |
|---------|-----------|----------------------|
| **Recommendations** | "Here are people near you" | Very High |
| **Location Updates** | Background sync | High |
| **Chat** | Message delivery | Medium |
| **Matching** | "It's a Match!" | Medium |
| **Profile CRUD** | Edit bio, photos | Low |
| **Notifications** | Push alerts | Low |

The **recommendations engine is 80% of your system's complexity**. Everything else is table stakes.

---

# Non-Functional Requirements

Let's derive real numbers from business metrics instead of guessing:

**Starting assumptions:**
- 75M DAU (Tinder's reported numbers)
- Average session: 7 minutes
- Average swipes per session: 50
- Peak hours: 8 PM - 11 PM local time (3-hour window)

**Derived constraints:**

```txt
Daily swipes = 75M × 50 = 3.75 billion swipes/day
             ≈ 2 billion (accounting for variance)

Peak QPS for swipes = (2B × 0.4) / (3 hours × 3600)
                    = 800M / 10,800
                    ≈ 74,000 swipes/second at peak
```

**Important detail:** Each swipe triggers:
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

**Now you have real numbers to design against.**

---

# High-Level Architecture

```txt
                                    ┌─────────────────────────────────────────┐
                                    │              CDN (Images)               │
                                    │         CloudFront / Fastly             │
                                    └─────────────────────────────────────────┘
                                                       ▲
                                                       │
┌──────────┐     ┌─────────────┐     ┌─────────────────┴─────────────────┐
│  Mobile  │────▶│   API GW    │────▶│         Service Mesh              │
│   Apps   │     │  (Kong/AWS) │     │    (Envoy + Istio or Linkerd)     │
└──────────┘     └─────────────┘     └─────────────────┬─────────────────┘
                                                       │
                 ┌─────────────────────────────────────┼─────────────────────────────────────┐
                 │                                     │                                     │
                 ▼                                     ▼                                     ▼
    ┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
    │   Profile Service      │        │  Recommendation Svc    │        │     Chat Service       │
    │                        │        │                        │        │                        │
    │  - CRUD operations     │        │  - Candidate gen       │        │  - WebSocket gateway   │
    │  - Photo management    │        │  - Ranking/scoring     │        │  - Message routing     │
    │  - Verification        │        │  - Queue management    │        │  - Delivery tracking   │
    └───────────┬────────────┘        └───────────┬────────────┘        └───────────┬────────────┘
                │                                  │                                 │
                ▼                                  ▼                                 ▼
    ┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
    │   PostgreSQL (Users)   │        │   Redis Cluster        │        │   Cassandra/ScyllaDB   │
    │   + Read Replicas      │        │   (Recommendation Q)   │        │   (Messages)           │
    └────────────────────────┘        └───────────┬────────────┘        └────────────────────────┘
                                                  │
                                                  ▼
                                      ┌────────────────────────┐
                                      │   Elasticsearch        │
                                      │   (Geo-queries)        │
                                      │   or Redis Geo         │
                                      └────────────────────────┘
```

The diagram becomes clearer when we trace the **data flow for each critical path**.

---

# Recommendation Engine

This is where your system lives or dies. Let me walk you through exactly how it works.

## The Two-Phase Architecture

You cannot compute recommendations in real-time. 74,000 swipes/second with a 200ms recommendation latency budget? Impossible if you're querying a database every time.

**Solution: Pre-computation + Queue**

```txt
┌─────────────────────────────────────────────────────────────────────────────┐
│                        OFFLINE PIPELINE (Every 15 min)                      │
│                                                                             │
│  ┌───────────┐    ┌───────────┐    ┌───────────┐    ┌───────────────────┐  │
│  │  User     │───▶│  Candidate│───▶│   ML      │───▶│  Redis Sorted Set │  │
│  │  Location │    │  Generator│    │  Ranker   │    │  per User         │  │
│  │  Updates  │    │  (Geo)    │    │           │    │  (Top 200 cards)  │  │
│  └───────────┘    └───────────┘    └───────────┘    └───────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        ONLINE SERVING (Real-time)                           │
│                                                                             │
│  User opens app                                                             │
│       │                                                                     │
│       ▼                                                                     │
│  ┌────────────────┐    ┌────────────────┐    ┌────────────────────────┐    │
│  │ Fetch from     │───▶│ Filter already │───▶│ Return top 10 cards   │    │
│  │ Redis Queue    │    │ swiped         │    │ (< 50ms P99)          │    │
│  └────────────────┘    └────────────────┘    └────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Candidate Generation: The Geo Problem

A straightforward SQL approach might look like this:

```sql
SELECT * FROM users 
WHERE ST_DWithin(location, user_location, 50000)  -- 50km
AND age BETWEEN 25 AND 35
AND gender = 'F'
AND last_active > NOW() - INTERVAL '7 days'
LIMIT 200;
```

**The challenge:** At 75K location updates/second, geo-indexes are constantly rebuilding. PostGIS struggles with this write volume.

**The solution: Geohashing with temporal sharding**

```python
# Divide the world into geohash cells (precision 5 ≈ 5km × 5km)
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
1. Geohash lookups are O(1) Redis SMEMBERS
2. Neighbor cells give you ~15-20km radius
3. Time bucketing auto-expires stale users
4. Write path is just SADD—handles 100K+ writes/second

## Ranking: The Bilateral Problem

Here's what makes dating apps different from Instagram or TikTok:

**TikTok:** P(user likes video)  
**Tinder:** P(user A likes user B) × P(user B likes user A)

You need to predict BOTH directions. This is where ELO-style scoring comes in:

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

**The key insight:** If you only optimize for "will this user swipe right," you'll show everyone the same top 1% of attractive users. Those users get overwhelmed, everyone else gets no matches, and your app dies.

---

# Matching System

When both users swipe right, you need to:
1. Detect the match instantly
2. Notify both users
3. Create a conversation thread
4. Do this without race conditions at 74K swipes/second

## Race Condition

```txt
Timeline:
T0: User A swipes right on User B
T1: User B swipes right on User A
T2: Both check "has other user swiped right?"
T3: Both see "no" (eventual consistency)
T4: Match never created. Both users confused.
```

**Solution: Use Redis atomic operations**

```python
def record_swipe(swiper_id, target_id, direction):
    if direction == 'left':
        redis.sadd(f"left:{swiper_id}", target_id)
        return None
    
    # Right swipe - check for mutual match atomically
    pipe = redis.pipeline()
    
    # Add our swipe
    pipe.sadd(f"right:{swiper_id}", target_id)
    
    # Check if they already swiped right on us
    pipe.sismember(f"right:{target_id}", swiper_id)
    
    results = pipe.execute()
    they_liked_us = results[1]
    
    if they_liked_us:
        # MATCH! Create conversation atomically
        match_id = create_match(swiper_id, target_id)
        
        # Fan out notifications
        notification_queue.publish({
            'type': 'match',
            'match_id': match_id,
            'users': [swiper_id, target_id]
        })
        
        return match_id
    
    return None
```

---

# Chat System

Chat seems simple until you realize:
- Users switch between WiFi and cellular
- WebSocket connections drop silently
- Messages must be delivered exactly once
- Read receipts need real-time sync
- Users might be offline for days

## Architecture

```txt
┌──────────────┐         ┌──────────────────┐         ┌──────────────────┐
│   Client A   │◀───────▶│  WS Gateway Pod  │◀───────▶│  Redis Pub/Sub   │
│              │         │  (Connection A)  │         │                  │
└──────────────┘         └──────────────────┘         └────────┬─────────┘
                                                               │
┌──────────────┐         ┌──────────────────┐                  │
│   Client B   │◀───────▶│  WS Gateway Pod  │◀─────────────────┘
│              │         │  (Connection B)  │
└──────────────┘         └──────────────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   Message Store  │
                         │   (ScyllaDB)     │
                         └──────────────────┘
```

## The Delivery Guarantee

```python
async def send_message(sender_id, recipient_id, content):
    message_id = uuid7()  # Time-ordered UUID
    
    message = {
        'id': message_id,
        'sender': sender_id,
        'recipient': recipient_id,
        'content': content,
        'status': 'pending',
        'created_at': now()
    }
    
    # 1. Persist first (durability)
    await scylla.insert('messages', message)
    
    # 2. Try real-time delivery
    delivered = await try_websocket_delivery(recipient_id, message)
    
    if delivered:
        await scylla.update('messages', message_id, {'status': 'delivered'})
    else:
        # 3. Queue for push notification
        await push_queue.publish({
            'user_id': recipient_id,
            'type': 'new_message',
            'preview': content[:50]
        })
        
        # 4. Message waits in "pending" until recipient fetches
    
    return message_id
```

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
- Excellent write throughput (100K+ writes/sec per node)
- Natural time-ordering with timeuuid
- Partition by conversation keeps related messages together

---

# Location Update Pipeline

This is your most write-heavy path: 75,000 updates/second.

```txt
┌──────────┐     ┌──────────────┐     ┌──────────────┐     ┌───────────────┐
│  Mobile  │────▶│    Kafka     │────▶│   Location   │────▶│ Geohash Index │
│   GPS    │     │   (Buffer)   │     │   Processor  │     │    (Redis)    │
└──────────┘     └──────────────┘     └──────────────┘     └───────────────┘
                                              │
                                              ▼
                                      ┌───────────────┐
                                      │   Trigger     │
                                      │   Reco Rebuild│
                                      └───────────────┘
```

**Key insight:** You don't need real-time location accuracy. A 5-minute delay is fine. This lets you batch writes and reduce pressure on downstream systems.

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

---

# Data Storage Strategy

| Data Type | Storage | Why |
|-----------|---------|-----|
| User profiles | PostgreSQL + Read replicas | ACID for billing, strong consistency for auth |
| User photos | S3 + CloudFront CDN | Cheap storage, global edge delivery |
| Swipe history | Redis (hot) + DynamoDB (cold) | Recent swipes need sub-ms access |
| Messages | ScyllaDB | Write-heavy, time-series, partition by convo |
| Recommendation queues | Redis Sorted Sets | Pre-computed, fast pop operations |
| Geospatial index | Redis Sets (geohash) | O(1) lookups, handles write volume |
| Analytics events | Kafka → ClickHouse | Columnar for aggregations |

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

# The Numbers That Matter

For a 75M DAU dating app:

| Metric | Target | Why |
|--------|--------|-----|
| Recommendation latency P99 | < 100ms | User is swiping; can't wait |
| Match notification latency P99 | < 500ms | Dopamine hit must be instant |
| Message delivery latency P99 | < 200ms | Chat feels broken otherwise |
| Photo load time P50 | < 300ms | First impression is visual |
| Location update lag | < 5 min | Accuracy vs. cost tradeoff |

**Infrastructure estimate:**
- 50-100 WebSocket gateway pods (100K connections each)
- 20-node ScyllaDB cluster for messages
- 50-node Redis cluster for recommendations
- 10-node PostgreSQL cluster (1 primary, 9 replicas)
- Kafka: 100+ partitions for location topic

---

# Final Thoughts

The hardest part of building a dating app isn't the technology—it's the **product-engineering intersection**:

- How do you balance showing users attractive profiles (engagement) vs. compatible profiles (retention)?
- How do you prevent the platform from becoming a "top 10% get everything" economy?
- How do you detect and handle bad actors at scale?

Every architectural decision ties back to these questions. The best systems engineers don't just build scalable systems—they build systems that make the product better.

---

Hope this helps in your system design journey. Now go build something people will swipe right on.
