+++
title = "Achieve 60ms Response Time Using ValKey: Part 1"
description = ""
date = 2024-06-16T23:27:27+05:30
lastmod = 2024-06-16T23:27:27+05:30
draft = false
images = []
+++

[WIP](https://backend.how)

You will be able to use valkey like swiss-knife it is to serve web pages at blazingly fast speed. 

# Why ? 
- Co-founder set the 60ms benchmark value that engineering team needs solve for.
- 95%+ traffic comes from Google, Facebook, Instagram Ads. On click - 2 methods car can be displayed to the user
  1. Dedicated Page - full details of 1 car, with 10+ photos and other information 
  2. Listing Page - List of cars - basic details and ~4 photos horizontally scrollable

> Amazon found that every 100ms of latency cost them 1% in sales. In 2006, Google found an extra .5 seconds in search page generation time dropped traffic by 20%. - [Marissa Mayer](http://glinden.blogspot.com/2006/11/marissa-mayer-at-web-20.html)

# Spec

- Maximum 10,000 cars can be active available for users to view
- Listing Page 
  - Shows list of cars based on order returned by [LightFM](https://github.com/lyst/lightfm) model
  - User can filter based on car attributes 
- User can be anonymous user or returning user who has filled the lead earlier.
  - For anonymous user use current_car or last_visited car stored in local storage.
  - Logged In user will get recommendation based on all the interaction they have done on platform.

# Exisitng design

- React PWA (Progressive Web App) App built using create-react-app as frontend.
- REST API implemented via Django with Django-Rest-Framework.

# Bottlenecks

## Frontend
PWA - Fastest way to render the page is to send rendered HTML and PWA doesn't do that, it works well after first page load, navigation and offline experiance but not for the first render.

Why have PWA? 
- In lifecycle of user once they decided to buy the car or bought the car, they would not need the platform so encourging someone to install the app felt extra step that user can skip.

## Backend

Request - Response lifecycle

1. User clicks
2. Load JS/CSS bundle (PWA)
3. HTTPS REST API Request
4. AWS Load Balancer (HTTPS termination)
5. Apache 2 Server WSGI extension - prefork (Ec2 Instance)
6. Django WSGI Handler - Python Process
7. Middleware → Create DB connection (1 for each request)
8. Django-Rest-Framework View
9. Model Serializers (n + 1 DB call) ~200 | **90% time spent here onwards** |
10. Automatic Caching via CacheALot 
11. DB Response
12. Convert JSON → Return to Apache2 → Load Balancer → User 


Didn't make sense what just happened ? it's okay. Not important to understand rest of the story. (Google unfamiliar terms or comment !)

Here for Listing API - we need to calculate order of cars from model response and based on that paginate. Paginate - Backend returns 10 cars max in each response, for more in subsquent API request marker is sent to backend to skip to seen results. 

# Solution 

## Frontend

We decided to opt for Next.js and send rendered html for the first page open. Once user is on either dedicated or listing page and interacts with site to go back or visit other cars it would fallback to rendering everything on client side, this allows smooth experiance like native apps.

## Backend

1. Make minimum amount of network calls.
2. Serve page via only valkey (cache), 100% hit ratio.

To keep in mind; 
- Every day car prices changes automatically.
- Operation team can make new car live anytime
- To render full car data - it uses ~10 tables from normalised schema
- All changes to db can be done through different portals.
  - Operation portal built using cakephp app - perform operations
  - Inventory App - that talks to different django application
  - Data Science python scripts to update prices in bulk.

### Building Cache Layer

Use case
1. Filter car based on attributes
2. Cache car information

#### Dedicated Page
- Fetch from redis and return
- Cache Miss, fill cache and return

```python
import redis
dedicated_key = "dp:{car_id}"

class DedicatedPageView(generic.ListRetrieveView):
    def get(request: Request, id: int, **kwargs):
      con = redis.get_connection()
      key = dedicated_key.format(car_id=id)
      value = con.get(rkey)
      if not value:
        # cache miss
        car_obj = Car.objects.get(id=id)
        data = DedicatedSerialiser(obj=car_obj).data
        con.set(key, data, ttl=one_day_in_seconds)
        return data
     return value 
# Find the thundering herd aka cache stampede here, comment with your solution!
```
Are we done ? No

> There are only two hard things in Computer Science: cache invalidation and naming things.
-- [Phil Karlton](https://martinfowler.com/bliki/TwoHardThings.html)


#### Cache Invalidation 

In MySQL, you can listen to binlog [[1]](#WAL) and get notified about all changes to the table - DDL & DML
 
- Data defiantion language 
  - CREATE | ALTER | DROP TABLE
- Data modification language
  - INSERT | UPDATE | DELETE | REPLACE FROM TABLE 

Using [python library](https://github.com/pratikgajjar/mysql-data-stream-kafka) to hook into mysql change log, we emitted changes to kafka topic.

Topic - Log file where you can only append.

```
Topic Name:

  {database_name}.{table_name}

Messages:

   op: insert | delete | update

   before: json payload with key = column name, value = column value

   after: json payload
```

Using above logic we listen to all topics which would affect final payload generated for dedicated page. 

Now here we have 2 choices: 

1. Let user fill the cache.
2. Build the page data, fill the cache.

Since we know there could be only 10_000 active cars, we can go ahead with 2nd option as memory usage won't be very high. 

Let's say dedicated page payload size was 20KB - for 10_000 cars, we would use only 2 000 000 KB, 2GB memory.

#### Listing Page

How would you implement filter in redis ? What about pagination ? Stay tuned for part 2

---

#### [1] What is [the binary log](https://dev.mysql.com/doc/refman/8.0/en/binary-log.html) ? {#WAL}
The binary log contains “events” that describe database changes such as table creation operations or changes to table data. It also contains events for statements that potentially could have made changes (for example, a DELETE which matched no rows), unless row-based logging is used. The binary log also contains information about how long each statement took that updated data.

In PostgresSQL [WAL](https://www.postgresql.org/docs/current/wal-intro.html) 

Write-Ahead Logging (WAL) is a standard method for ensuring data integrity. A detailed description can be found in most (if not all) books about transaction processing. Briefly, WAL's central concept is that changes to data files (where tables and indexes reside) must be written only after those changes have been logged, that is, after WAL records describing the changes have been flushed to permanent storage. If we follow this procedure, we do not need to flush data pages to disk on every transaction commit, because we know that in the event of a crash we will be able to recover the database using the log: any changes that have not been applied to the data pages can be redone from the WAL records. (This is roll-forward recovery, also known as REDO.)

Similarly most database platforms provide a way to read database changes.

Data Engineers would be familiar with term - CDC - [Change data capture](https://www.confluent.io/learn/change-data-capture/)

Change data capture (CDC) refers to the tracking of all changes in a data source (databases, data warehouses, etc.) so they can be captured in destination systems. In short, CDC allows organizations to achieve data integrity and consistency across all systems and deployment environments.

